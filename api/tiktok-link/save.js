// api/tiktok-link/save.js
//
// POST /api/tiktok-link/save
//   Headers: Authorization: Bearer <supabase-jwt>   (role creator)
//   Body:    { handle: string }   handle, @handle, profile URL or short link
//
// Saves the caller's TikTok profile link and issues a bio code (spec 0002,
// AC-1 to AC-3). The row is always the caller's own (user_id, 'tiktok') row,
// resolved from the JWT, never from input. OAuth columns are never touched.
//
//   200 { handle, linkStatus, code, codeExpiresAt }
//   409 handle_claimed          another creator has this handle verified
//   422 invalid_tiktok_handle   not a handle, profile URL or short link
//   503 migration_missing       20261023000000 not applied (AC-19)

const { applyCors } = require('../_utils/cors');
const { requireRole } = require('../_utils/auth');
const { Errors, sendOk, sendError } = require('../_utils/errors');
const { getSupabaseAdminClient } = require('../_utils/supabaseAdmin');
const { applyRateLimit } = require('../_utils/rateLimit');
const {
  normalizeHandle,
  generateCode,
  codeExpiresAt,
  isLinkSchemaMissing,
  sendMigrationMissing,
} = require('../_utils/tiktokLink');

const ROW_SELECT = 'id, link_handle, link_status, link_code, link_code_expires_at';

function shape(row) {
  return {
    handle: row.link_handle,
    linkStatus: row.link_status,
    code: row.link_code,
    codeExpiresAt: row.link_code_expires_at,
  };
}

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return Errors.methodNotAllowed(res);

  const ctx = await requireRole(req, res, ['creator']);
  if (!ctx) return;

  const blocked = await applyRateLimit(req, res, {
    max: 10,
    windowSecs: 3600,
    endpoint: 'tiktok-link-save',
    userId: ctx.user.id,
  });
  if (blocked) return;
  const userId = ctx.user.id;

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }

  const handle = await normalizeHandle(body && body.handle);
  if (!handle) {
    return sendError(res, 422, 'invalid_tiktok_handle',
      'Paste your TikTok handle or profile link, for example @yourname or https://www.tiktok.com/@yourname.');
  }

  const supabase = getSupabaseAdminClient();

  try {
    // AC-2: someone else already owns this handle.
    const { data: claimed, error: claimErr } = await supabase
      .from('creator_social_accounts')
      .select('id')
      .eq('platform', 'tiktok')
      .eq('link_status', 'verified')
      .eq('link_handle', handle)
      .neq('user_id', userId)
      .limit(1);
    if (claimErr) {
      if (isLinkSchemaMissing(claimErr)) return sendMigrationMissing(res);
      throw claimErr;
    }
    if (claimed && claimed.length > 0) {
      return sendError(res, 409, 'handle_claimed',
        'This TikTok account is already verified for another creator. Contact your manager if it is yours.');
    }

    const { data: current, error: curErr } = await supabase
      .from('creator_social_accounts')
      .select(ROW_SELECT)
      .eq('user_id', userId)
      .eq('platform', 'tiktok')
      .maybeSingle();
    if (curErr) {
      if (isLinkSchemaMissing(curErr)) return sendMigrationMissing(res);
      throw curErr;
    }

    // AC-3: the same handle, already verified, changes nothing.
    if (current && current.link_handle === handle && current.link_status === 'verified') {
      return sendOk(res, shape(current));
    }

    // AC-1 / AC-3: anything else starts over at pending_code with a fresh
    // code, clearing what an earlier handle or review left behind.
    const fields = {
      link_handle: handle,
      link_status: 'pending_code',
      link_code: generateCode(),
      link_code_expires_at: codeExpiresAt(),
      link_code_found_at: null,
      link_verified_at: null,
      link_verified_by: null,
      link_rejected_reason: null,
      link_health: 'ok',
      link_failure_count: 0,
      link_last_error: null,
    };

    let saved;
    if (current) {
      const { data, error } = await supabase
        .from('creator_social_accounts')
        .update(fields)
        .eq('id', current.id)
        .select(ROW_SELECT);
      if (error) {
        if (isLinkSchemaMissing(error)) return sendMigrationMissing(res);
        throw error;
      }
      saved = data && data[0];
    } else {
      const { data: creator } = await supabase
        .from('creators')
        .select('id')
        .eq('user_id', userId)
        .maybeSingle();
      // connection_status stays at its default 'not_connected': it describes
      // OAuth only, and the refresh sweep and needsReauth() ignore a row
      // without a token.
      const { data, error } = await supabase
        .from('creator_social_accounts')
        .insert({
          user_id: userId,
          platform: 'tiktok',
          creator_id: (creator && creator.id) || null,
          username: handle,
          ...fields,
        })
        .select(ROW_SELECT);
      if (error) {
        if (isLinkSchemaMissing(error)) return sendMigrationMissing(res);
        // 23505 on (user_id, platform): a double click raced us to the
        // insert. Ask for a retry rather than guess which save should win.
        if (error.code === '23505') {
          return sendError(res, 409, 'invalid_link_state', 'Your link was saved twice at once. Reload and try again.');
        }
        throw error;
      }
      saved = data && data[0];
    }

    if (!saved) {
      return Errors.internal(res, 'The link was not saved. Reload and try again.');
    }
    return sendOk(res, shape(saved));
  } catch (err) {
    console.error('[tiktok-link/save] failed:', err && (err.code || ''), err && err.message);
    return Errors.internal(res, 'Could not save your TikTok link');
  }
};
