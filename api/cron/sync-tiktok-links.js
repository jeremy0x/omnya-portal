// api/cron/sync-tiktok-links.js
//
// GET /api/cron/sync-tiktok-links   (Vercel cron, 15 */6 * * *; CRON_SECRET)
//
// The TikTok profile link job (spec 0002). Two passes:
//
//   1. pending_code rows whose code has not expired: fetch the profile and,
//      when the bio holds the code, move the row to code_found (AC-4).
//      Expired codes are not polled, so they cost no credits.
//
//   2. verified rows without a usable OAuth token (AC-9), oldest fetch first
//      (AC-13): profile and the 30 newest videos -> creator_videos,
//      video_metrics, today's social_profile_snapshots row (AC-7). Then each
//      of the creator's TikTok Final submissions is matched to a video, by the
//      feed or a bounded single lookup, and its views are written through
//      apply_verified_views() when the author is the verified handle and the
//      sanity cap allows it (AC-8).
//
// Budgets (AC-13): 4 creators at a time, no new creator after 240 s, 45 s per
// creator (then its remaining single lookups wait for the next run). A
// creator's link_last_fetched_at only moves when its whole pipeline finished,
// so one cut short goes first next time.
//
// A provider wide failure (401/402/403/429: key, credits, rate limit) stops
// the run and answers 503 provider_unavailable without touching any creator
// (AC-12). Per creator health rules and the shared 5xx counter are slice 3
// (spec 0002 task 13, 14); until then a per creator failure is counted in the
// summary and the creator is simply retried first on the next run.
//
// Logs one structured summary: counts only, no handles, tokens or user ids.

const crypto = require('crypto');
const { getSupabaseAdminClient } = require('../_utils/supabaseAdmin');
const { Errors, sendOk, sendError } = require('../_utils/errors');
const {
  FINAL_SUBMISSION_TYPES,
  resolvePlatform,
  resolveShortLink,
  extractVideoId,
  calculateEngagementRate,
} = require('../_utils/analytics');
const { getProfile, listVideos, getVideo } = require('../_utils/tiktokPublic');
const {
  bioHasCode,
  codeExpired,
  hasUsableOAuth,
  checkJump,
  lookupEligible,
  isLinkSchemaMissing,
  sendMigrationMissing,
} = require('../_utils/tiktokLink');

const CONCURRENCY = 4;
const RUN_BUDGET_MS = 240 * 1000;
const CREATOR_BUDGET_MS = 45 * 1000;
const VIDEO_LIMIT = 30;

class ProviderUnavailable extends Error {
  constructor(status) { super('provider_unavailable'); this.status = status; }
}
class SchemaMissing extends Error {}

module.exports = async (req, res) => {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) {
    console.error('[cron/sync-tiktok-links] CRON_SECRET env var is not set');
    return sendError(res, 500, 'cron_not_configured', 'Cron not configured');
  }
  // Constant time comparison of equal length hashes, as api/analytics/sync.js.
  const incomingHash = crypto.createHash('sha256').update(req.headers.authorization || '').digest();
  const expectedHash = crypto.createHash('sha256').update(`Bearer ${cronSecret}`).digest();
  if (!crypto.timingSafeEqual(incomingHash, expectedHash)) {
    return Errors.unauthorized(res, 'Invalid cron secret');
  }
  if (req.method !== 'GET' && req.method !== 'POST') return Errors.methodNotAllowed(res);

  const result = await runLinkSync(getSupabaseAdminClient());
  if (result.schemaMissing) return sendMigrationMissing(res);
  if (result.providerUnavailable) {
    return sendError(res, 503, 'provider_unavailable',
      'The TikTok data provider refused the run (key, credits or rate limit). No creator was changed.',
      { status: result.providerStatus, summary: result.summary });
  }
  if (result.fatal) return Errors.internal(res, 'TikTok link sync failed', { message: result.fatal });
  return sendOk(res, result.summary);
};

// Exported for the offline tests; the route above is a thin wrapper.
async function runLinkSync(supabase, { now = () => Date.now() } = {}) {
  const startedAt = now();
  const summary = {
    pending_checked: 0,
    codes_found: 0,
    creators_eligible: 0,
    profiles_fetched: 0,
    creators_completed: 0,
    creators_cut_short: 0,
    videos_upserted: 0,
    submissions_matched: 0,
    submissions_verified: 0,
    single_lookups: 0,
    author_mismatch: 0,
    views_jump_held: 0,
    stale_skip: 0,
    failures: {},
    duration_ms: 0,
  };
  const state = { aborted: null };
  const failed = (reason) => { summary.failures[reason] = (summary.failures[reason] || 0) + 1; };
  const outOfTime = () => now() - startedAt > RUN_BUDGET_MS;

  // Every provider call goes through here, so one provider wide refusal stops
  // every worker's next call, not just the one that saw it.
  const provider = async (fn) => {
    if (state.aborted) throw new ProviderUnavailable(state.aborted);
    const r = await fn();
    if (r && r.error && r.kind === 'provider') {
      state.aborted = state.aborted || r.status || 'provider';
      throw new ProviderUnavailable(state.aborted);
    }
    return r;
  };

  const finish = (extra = {}) => {
    summary.duration_ms = now() - startedAt;
    const event = extra.providerUnavailable ? 'tiktok_link_sync_provider_unavailable' : 'tiktok_link_sync_completed';
    console.log(JSON.stringify({ event, status: extra.providerStatus, ...summary }));
    return { summary, ...extra };
  };

  try {
    const nowIso = new Date(now()).toISOString();
    const { data: pending, error: pErr } = await supabase
      .from('creator_social_accounts')
      .select('id, link_handle, link_code, link_code_expires_at')
      .eq('platform', 'tiktok')
      .eq('link_status', 'pending_code')
      .gt('link_code_expires_at', nowIso);
    if (pErr) throw isLinkSchemaMissing(pErr) ? new SchemaMissing(pErr.message) : pErr;

    const { data: verified, error: vErr } = await supabase
      .from('creator_social_accounts')
      .select('id, user_id, creator_id, link_handle, link_last_fetched_at, ' +
              'access_token_encrypted, connection_status, token_expires_at')
      .eq('platform', 'tiktok')
      .eq('link_status', 'verified')
      .order('link_last_fetched_at', { ascending: true, nullsFirst: true });
    if (vErr) throw isLinkSchemaMissing(vErr) ? new SchemaMissing(vErr.message) : vErr;

    // AC-9: OAuth is the source while its token is usable.
    const linkRows = (verified || []).filter((row) => !hasUsableOAuth(row));
    summary.creators_eligible = linkRows.length;

    const tasks = [
      ...(pending || []).map((row) => () => checkPending(row)),
      ...linkRows.map((row) => () => syncCreator(row)),
    ];

    let next = 0;
    const worker = async () => {
      while (next < tasks.length && !state.aborted && !outOfTime()) {
        const task = tasks[next++];
        try {
          await task();
        } catch (err) {
          if (err instanceof ProviderUnavailable) return;
          if (err instanceof SchemaMissing) throw err;
          failed('unexpected');
          console.error('[cron/sync-tiktok-links] creator task failed:', err && err.message);
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    if (state.aborted) return finish({ providerUnavailable: true, providerStatus: state.aborted });
    return finish();
  } catch (err) {
    if (err instanceof SchemaMissing) return finish({ schemaMissing: true });
    console.error('[cron/sync-tiktok-links] run failed:', err && err.message);
    return finish({ fatal: err && err.message });
  }

  // ---- pass 1: is the code in the bio yet? ---------------------------------
  async function checkPending(row) {
    summary.pending_checked += 1;
    const profile = await provider(() => getProfile(row.link_handle));
    // Not found or private leaves the row pending (AC-4); health rules do not
    // apply to pending rows.
    if (profile.error) { failed(`pending_${profile.error}`); return; }
    if (!bioHasCode(profile.bio, row.link_code) || codeExpired(row, now())) return;

    const { data, error } = await supabase
      .from('creator_social_accounts')
      .update({ link_status: 'code_found', link_code_found_at: new Date(now()).toISOString() })
      .eq('id', row.id)
      .eq('link_status', 'pending_code')
      .eq('link_handle', row.link_handle)
      .eq('link_code', row.link_code)
      .select('id');
    if (error) { failed('code_found_write_failed'); return; }
    if (data && data.length) summary.codes_found += 1;
  }

  // ---- pass 2: one verified creator, end to end -----------------------------
  async function syncCreator(account) {
    const creatorStart = now();
    const handle = account.link_handle;
    const userId = account.user_id;
    let cutShort = false;

    const profile = await provider(() => getProfile(handle));
    if (profile.error) { failed(profile.error); return; }
    const list = await provider(() => listVideos(handle, VIDEO_LIMIT));
    if (list.error) { failed(`videos_${list.error}`); return; }
    summary.profiles_fetched += 1;

    // Only videos the verified handle actually uploaded are stored as theirs.
    const videos = list.videos.filter((v) => v.authorHandle === handle);
    const fetchedAt = new Date(now()).toISOString();

    // The sanity cap compares against what we stored LAST run, so read the
    // previous counts before this run's upsert overwrites them.
    const previous = await previousCounts(userId, videos.map((v) => v.id));

    const videoIds = await upsertVideos(account, videos, fetchedAt);
    if (!videoIds) { failed('videos_upsert_failed'); return; }
    summary.videos_upserted += videos.length;

    const snapshot = await supabase
      .from('social_profile_snapshots')
      .upsert({
        social_account_id: account.id,
        user_id: userId,
        snapshot_date: fetchedAt.slice(0, 10),
        follower_count: profile.followers,
        video_count: profile.videoCount,
      }, { onConflict: 'social_account_id,snapshot_date' });
    if (snapshot.error) failed('snapshot_write_failed');

    // ---- submissions -------------------------------------------------------
    const { data: subs, error: subErr } = await supabase
      .from('submissions')
      .select('id, creator_id, campaign_id, platform, posted_link, submission_type, posted_at, created_at, ' +
              'view_count_verified, view_count_verified_at, creators!inner(user_id)')
      .eq('creators.user_id', userId)
      .in('submission_type', FINAL_SUBMISSION_TYPES)
      .not('posted_link', 'is', null)
      .not('posted_link', 'eq', '');
    if (subErr) {
      if (isLinkSchemaMissing(subErr)) throw new SchemaMissing(subErr.message);
      failed('submissions_fetch_failed');
      return;
    }

    const byId = new Map(videos.map((v) => [v.id, v]));
    const candidates = [];
    for (const sub of subs || []) {
      const link = await resolveShortLink(sub.posted_link);
      if (resolvePlatform({ ...sub, posted_link: link }) !== 'tiktok') continue;
      const videoId = extractVideoId('tiktok', link);
      if (!videoId) { failed('video_id_unparseable'); continue; }
      candidates.push({ sub, link, videoId });
    }

    const notFoundAt = await cachedNotFound(candidates.filter((c) => !byId.has(c.videoId)).map((c) => c.sub.id));

    for (const { sub, link, videoId } of candidates) {
      let video = byId.get(videoId);
      let previousFetch = previous.get(videoId);

      if (!video) {
        if (!lookupEligible(sub, notFoundAt.get(sub.id), now())) continue;
        if (now() - creatorStart > CREATOR_BUDGET_MS || state.aborted) { cutShort = true; continue; }
        summary.single_lookups += 1;
        const single = await provider(() => getVideo(link));
        if (single.error) {
          if (single.kind === 'not_found') await cacheNotFound(sub.id, fetchedAt);
          failed(`lookup_${single.error}`);
          continue;
        }
        video = single;
        if (video.authorHandle === handle) {
          // Store it like a feed video, so the next run has a baseline for
          // the sanity cap and the creator's history is complete.
          previousFetch = (await previousCounts(userId, [video.id])).get(video.id);
          await upsertVideos(account, [video], fetchedAt);
        }
      }

      // Author check (AC-8): the provider's unique id, never the nickname.
      if (video.authorHandle !== handle) { summary.author_mismatch += 1; continue; }
      summary.submissions_matched += 1;

      const jump = checkJump({
        newViews: video.views,
        storedVerified: sub.view_count_verified,
        previousFetch: previousFetch == null ? null : previousFetch,
      });
      if (!jump.apply) {
        summary.views_jump_held += 1;
        console.log(JSON.stringify({ event: 'views_jump_held', stored: sub.view_count_verified, fetched: video.views }));
        continue;
      }

      const { data: applied, error: applyErr } = await supabase.rpc('apply_verified_views', {
        p_submission_id: sub.id,
        p_views: video.views,
        p_source: 'link',
        p_user_id: userId,
        p_handle: handle,
      });
      if (applyErr) {
        if (isLinkSchemaMissing(applyErr)) throw new SchemaMissing(applyErr.message);
        failed('apply_failed');
        console.error('[cron/sync-tiktok-links] apply_verified_views failed:', applyErr.code, applyErr.message);
        continue;
      }
      if (applied !== true) { summary.stale_skip += 1; continue; }
      summary.submissions_verified += 1;

      // Same row shape syncSubmissions writes, so dashboards read one table.
      const analytics = await supabase.from('video_analytics').upsert({
        user_id: userId,
        creator_id: sub.creator_id,
        submission_id: sub.id,
        campaign_id: sub.campaign_id,
        platform: 'tiktok',
        video_id: videoId,
        video_url: sub.posted_link,
        views: video.views,
        likes: video.likes,
        comments: video.comments,
        shares: video.shares,
        saves: video.saves,
        reach: 0,
        engagement_rate: calculateEngagementRate(video),
        raw_metrics: video.raw,
        pulled_at: fetchedAt,
        updated_at: fetchedAt,
      }, { onConflict: 'submission_id' });
      if (analytics.error) failed('analytics_write_failed');
    }

    if (cutShort) { summary.creators_cut_short += 1; return; }

    // Only a finished pipeline moves the creator to the back of the queue,
    // and only while the row is still verified with this handle.
    const { error: doneErr } = await supabase
      .from('creator_social_accounts')
      .update({ follower_count: profile.followers, link_last_fetched_at: fetchedAt })
      .eq('id', account.id)
      .eq('link_status', 'verified')
      .eq('link_handle', handle);
    if (doneErr) { failed('account_write_failed'); return; }
    summary.creators_completed += 1;
  }

  async function previousCounts(userId, ids) {
    const map = new Map();
    if (!ids.length) return map;
    const { data, error } = await supabase
      .from('creator_videos')
      .select('platform_video_id, view_count')
      .eq('user_id', userId)
      .eq('platform', 'tiktok')
      .in('platform_video_id', ids);
    if (!error) for (const row of data || []) map.set(String(row.platform_video_id), Number(row.view_count) || 0);
    return map;
  }

  // creator_videos upsert plus one video_metrics snapshot per video.
  // Returns the platform id -> creator_videos.id map, or null on failure.
  async function upsertVideos(account, list, fetchedAt) {
    if (!list.length) return new Map();
    const { data, error } = await supabase
      .from('creator_videos')
      .upsert(list.map((v) => ({
        user_id: account.user_id,
        creator_id: account.creator_id || null,
        social_account_id: account.id,
        platform: 'tiktok',
        platform_video_id: v.id,
        video_url: v.url,
        caption: v.caption,
        thumbnail_url: v.thumbnailUrl,
        posted_at: v.postedAt,
        view_count: v.views,
        like_count: v.likes,
        comment_count: v.comments,
        share_count: v.shares,
        duration_seconds: v.durationSeconds,
        sync_status: 'synced',
        source: 'link',
        author_handle: v.authorHandle,
        updated_at: fetchedAt,
      })), { onConflict: 'user_id,platform,platform_video_id' })
      .select('id, platform_video_id');
    if (error) {
      if (isLinkSchemaMissing(error)) throw new SchemaMissing(error.message);
      console.error('[cron/sync-tiktok-links] creator_videos upsert failed:', error.code, error.message);
      return null;
    }
    const ids = new Map((data || []).map((r) => [String(r.platform_video_id), r.id]));
    const metrics = list.filter((v) => ids.has(v.id)).map((v) => ({
      video_id: ids.get(v.id),
      user_id: account.user_id,
      snapshot_at: fetchedAt,
      view_count: v.views,
      like_count: v.likes,
      comment_count: v.comments,
      share_count: v.shares,
      engagement_rate: calculateEngagementRate(v),
    }));
    if (metrics.length) {
      const { error: mErr } = await supabase.from('video_metrics').insert(metrics);
      if (mErr) failed('metrics_write_failed');
    }
    return ids;
  }

  // AC-8: a single lookup that came back not found is not repeated for 7
  // days. The mark lives in video_analytics.raw_metrics, and is only set on a
  // row that already exists: inserting a zero views row just to hold it would
  // show a client a video with no views.
  async function cachedNotFound(submissionIds) {
    const map = new Map();
    if (!submissionIds.length) return map;
    const { data } = await supabase
      .from('video_analytics')
      .select('submission_id, raw_metrics')
      .in('submission_id', submissionIds);
    for (const row of data || []) {
      const at = row.raw_metrics && row.raw_metrics.lookup_not_found_at;
      if (at) map.set(row.submission_id, at);
    }
    return map;
  }

  async function cacheNotFound(submissionId, at) {
    const { data } = await supabase
      .from('video_analytics')
      .select('id, raw_metrics')
      .eq('submission_id', submissionId)
      .maybeSingle();
    if (!data) return;
    await supabase
      .from('video_analytics')
      .update({ raw_metrics: { ...(data.raw_metrics || {}), lookup_not_found_at: at } })
      .eq('id', data.id);
  }
}

module.exports.runLinkSync = runLinkSync;
