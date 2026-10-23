// api/tiktok-link/review.js
//
// POST /api/tiktok-link/review
//   Headers: Authorization: Bearer <supabase-jwt>   (role owner or am)
//   Body:    { accountId: uuid, handle: string, action: 'verify'|'reject', reason?: string }
//
// A manager confirms (or refuses) that a creator owns the TikTok profile they
// linked (spec 0002, AC-5, AC-6).
//
// Who may act: an owner, or the AM whose account_managers.id is the creator's
// creators.am_id. A creator with no AM is reviewed by owners only.
//
// Both writes are conditional on the state and the handle the manager was
// shown (`handle` in the body), followed by .select(). Zero rows back means
// the creator changed or removed the link mid review, and nothing happened.
//
// Verify re-reads the bio first: the code has to still be there.
//
// The verified / rejected emails arrive in slice 2 (spec 0002 task 12).

const { applyCors } = require('../_utils/cors');
const { requireRole, normalizeRole } = require('../_utils/auth');
const { Errors, sendOk, sendError } = require('../_utils/errors');
const { getSupabaseAdminClient } = require('../_utils/supabaseAdmin');
const { applyRateLimit } = require('../_utils/rateLimit');
const { getProfile } = require('../_utils/tiktokPublic');
const { bioHasCode, isLinkSchemaMissing, sendMigrationMissing } = require('../_utils/tiktokLink');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REJECTABLE = new Set(['pending_code', 'code_found', 'verified']);

module.exports = async (req, res) => {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return Errors.methodNotAllowed(res);

  const ctx = await requireRole(req, res, ['owner', 'am']);
  if (!ctx) return;

  const blocked = await applyRateLimit(req, res, {
    max: 60,
    windowSecs: 60,
    endpoint: 'tiktok-link-review',
    userId: ctx.user.id,
  });
  if (blocked) return;
  const { user } = ctx;
  const role = normalizeRole(ctx.profile.role);

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};
  const accountId = typeof body.accountId === 'string' ? body.accountId : '';
  const handle = typeof body.handle === 'string' ? body.handle.trim().toLowerCase() : '';
  const action = body.action;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';

  if (!UUID_RE.test(accountId)) return Errors.badRequest(res, 'accountId must be a uuid');
  if (!handle) return Errors.badRequest(res, 'handle is required');
  if (action !== 'verify' && action !== 'reject') return Errors.badRequest(res, "action must be 'verify' or 'reject'");
  if (action === 'reject' && (reason.length < 3 || reason.length > 500)) {
    return sendError(res, 422, 'reason_required', 'Give the creator a reason of 3 to 500 characters.');
  }

  const supabase = getSupabaseAdminClient();

  try {
    const { data: account, error: accErr } = await supabase
      .from('creator_social_accounts')
      .select('id, user_id, platform, link_handle, link_status, link_code')
      .eq('id', accountId)
      .maybeSingle();
    if (accErr) {
      if (isLinkSchemaMissing(accErr)) return sendMigrationMissing(res);
      throw accErr;
    }
    if (!account || account.platform !== 'tiktok' || !account.link_status) {
      return Errors.notFound(res, 'TikTok link not found');
    }

    // Scope: an AM acts only on their own creators (AC-5).
    if (role === 'am') {
      const [{ data: am }, { data: creator }] = await Promise.all([
        supabase.from('account_managers').select('id').eq('user_id', user.id).maybeSingle(),
        supabase.from('creators').select('am_id').eq('user_id', account.user_id).maybeSingle(),
      ]);
      if (!am || !creator || !creator.am_id || creator.am_id !== am.id) {
        return sendError(res, 403, 'not_your_creator', 'Only this creator\'s manager or an owner can review their link.');
      }
    }

    let update;
    let fromState = account.link_status;

    if (action === 'verify') {
      if (account.link_status !== 'code_found' || account.link_handle !== handle) {
        return sendError(res, 409, 'invalid_link_state',
          'This link changed since you loaded it. Reload the list and check it again.');
      }
      const profile = await getProfile(handle);
      if (profile.error && (profile.kind === 'provider' || profile.kind === 'transient')) {
        return sendError(res, 502, 'provider_unavailable',
          'Could not reach TikTok data right now, so the bio was not rechecked. Try again in a few minutes.');
      }
      if (profile.error || !bioHasCode(profile.bio, account.link_code)) {
        return sendError(res, 409, 'code_missing',
          'The code is no longer in this creator\'s TikTok bio, so the link was not verified.');
      }
      update = supabase
        .from('creator_social_accounts')
        .update({
          link_status: 'verified',
          link_verified_at: new Date().toISOString(),
          link_verified_by: user.id,
        })
        .eq('id', accountId)
        .eq('link_status', 'code_found')
        .eq('link_handle', handle);
    } else {
      if (!REJECTABLE.has(account.link_status) || account.link_handle !== handle) {
        return sendError(res, 409, 'invalid_link_state',
          'This link changed since you loaded it. Reload the list and check it again.');
      }
      update = supabase
        .from('creator_social_accounts')
        .update({ link_status: 'rejected', link_rejected_reason: reason })
        .eq('id', accountId)
        .eq('link_status', account.link_status)
        .eq('link_handle', handle);
    }

    const { data: rows, error: upErr } = await update.select('id, link_status');
    if (upErr) {
      if (isLinkSchemaMissing(upErr)) return sendMigrationMissing(res);
      // The partial unique index: another creator verified this handle first.
      if (upErr.code === '23505') {
        return sendError(res, 409, 'handle_claimed', 'Another creator already has this TikTok account verified.');
      }
      throw upErr;
    }
    if (!rows || rows.length === 0) {
      return sendError(res, 409, 'invalid_link_state',
        'This link changed while you were reviewing it, so nothing was saved. Reload and check it again.');
    }

    const nextState = rows[0].link_status;
    const { error: auditErr } = await supabase.rpc('log_admin_action', {
      p_action: action === 'verify' ? 'tiktok_link_verified' : 'tiktok_link_rejected',
      p_entity_type: 'creator_social_account',
      p_entity_id: accountId,
      p_entity_label: handle,
      p_from: fromState,
      p_to: nextState,
      p_reason: action === 'reject' ? reason : null,
      p_metadata: { creator_user_id: account.user_id },
      p_actor: user.id,
    });
    // The review already happened; a lost audit row is logged loudly rather
    // than reported to the manager as a failed review.
    if (auditErr) console.error('[tiktok-link/review] audit write failed:', auditErr.code, auditErr.message);

    return sendOk(res, { accountId, linkStatus: nextState, audited: !auditErr });
  } catch (err) {
    console.error('[tiktok-link/review] failed:', err && (err.code || ''), err && err.message);
    return Errors.internal(res, 'Could not review this TikTok link');
  }
};
