// api/_utils/tiktokPublic.js
//
// The one place that knows about the public TikTok data provider (spec 0002).
// Today that is ScrapeCreators; switching to EnsembleData, or to official
// OAuth, means rewriting this file and nothing else.
//
//   getProfile(handle)          -> { handle, bio, followers, videoCount, raw }
//   listVideos(handle, limit)   -> { videos: [video], partial }
//   getVideo(url)               -> video
//
// where video is
//   { id, url, postedAt, caption, thumbnailUrl, durationSeconds,
//     views, likes, comments, shares, saves, authorHandle, raw }
//
// Every function returns that shape or { error, kind, status } with kind:
//
//   not_found  the account or video does not exist (or is banned)
//   private    the account exists but is private
//   transient  a timeout or 5xx on this call, after one immediate retry
//   provider   401 / 402 / 403 / 429: our key, credits or rate limit. A
//              provider wide failure: the caller must stop the whole run and
//              must not blame the creator (AC-12).
//
// FIELD MAPPING (from the endpoints' OpenAPI examples; see
// tests/fixtures/scrapecreators/README.md for what is confirmed vs assumed):
//
//   /v1/tiktok/profile          user.uniqueId -> handle, user.signature -> bio,
//                               stats.followerCount, stats.videoCount,
//                               user.privateAccount | user.secret -> private
//   /v3/tiktok/profile/videos   aweme_list[], max_cursor, has_more (if sent)
//   /v2/tiktok/video            aweme_detail
//   video (both)                aweme_id, desc, create_time (unix s),
//                               statistics.{play,digg,comment,share,collect}_count,
//                               author.unique_id (the handle, NOT nickname),
//                               video.duration (ms), video.cover.url_list[0]
//
// The API key is server only (SCRAPECREATORS_API_KEY, no REACT_APP_ prefix),
// and the provider is only ever called from api/, so the CSP is unchanged.

const BASE_URL = 'https://api.scrapecreators.com';
const TIMEOUT_MS = 15000;
// Pages of the video list read before giving up on reaching `limit`. TikTok
// can return short or empty pages; this bounds the credits one creator costs.
const MAX_VIDEO_PAGES = 5;

const PROVIDER_STATUSES = new Set([401, 402, 403, 429]);
const NOT_FOUND_TEXT = /not\s*found|does(?:n'?t| not)\s*exist|couldn'?t find|no such user|user.*(?:banned|unavailable)/i;

function fail(error, kind, status) {
  return { error, kind, status: status || null };
}

// One HTTP call, classified. A transient failure is retried once at once,
// because a single 5xx is common and costs nothing to repeat.
async function call(path, params, { retried = false } = {}) {
  const apiKey = process.env.SCRAPECREATORS_API_KEY;
  if (!apiKey) return fail('scrapecreators_not_configured', 'provider', null);

  const url = `${BASE_URL}${path}?${new URLSearchParams(params).toString()}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let resp;
  let body;
  try {
    resp = await fetch(url, { headers: { 'x-api-key': apiKey }, signal: controller.signal });
    body = await resp.json().catch(() => null);
  } catch (err) {
    clearTimeout(timer);
    if (!retried) return call(path, params, { retried: true });
    const timedOut = err && err.name === 'AbortError';
    return { ...fail(timedOut ? 'provider_timeout' : 'provider_network_error', 'transient', null), timeout: timedOut };
  }
  clearTimeout(timer);

  if (PROVIDER_STATUSES.has(resp.status)) {
    return fail(`provider_http_${resp.status}`, 'provider', resp.status);
  }
  if (resp.status >= 500) {
    if (!retried) return call(path, params, { retried: true });
    return fail(`provider_http_${resp.status}`, 'transient', resp.status);
  }

  const message = body && (body.message || body.error || body.detail);
  if (resp.status === 404 || ((resp.status >= 400 || (body && body.success === false)) && NOT_FOUND_TEXT.test(String(message || '')))) {
    return fail('profile_not_found', 'not_found', resp.status);
  }
  if (!resp.ok || !body || body.success === false) {
    return fail(`provider_http_${resp.status}`, 'transient', resp.status);
  }
  return { body, status: resp.status };
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function normalizeVideo(a) {
  if (!a || !a.aweme_id) return null;
  const id = String(a.aweme_id);
  const s = a.statistics || {};
  const author = String((a.author && a.author.unique_id) || '').toLowerCase() || null;
  const cover = a.video && a.video.cover && Array.isArray(a.video.cover.url_list) ? a.video.cover.url_list[0] : null;
  const durationMs = a.video && Number(a.video.duration);
  // The documented example's `url` does not always match the item, so only
  // trust it when it names this video; otherwise build the canonical one.
  const url = typeof a.url === 'string' && a.url.includes(id)
    ? a.url
    : author ? `https://www.tiktok.com/@${author}/video/${id}` : null;
  return {
    id,
    url,
    postedAt: a.create_time ? new Date(Number(a.create_time) * 1000).toISOString() : null,
    caption: typeof a.desc === 'string' ? a.desc : null,
    thumbnailUrl: cover || null,
    durationSeconds: Number.isFinite(durationMs) && durationMs > 0 ? Math.round(durationMs / 1000) : null,
    views: num(s.play_count),
    likes: num(s.digg_count),
    comments: num(s.comment_count),
    shares: num(s.share_count),
    saves: num(s.collect_count),
    authorHandle: author,
    // Kept small on purpose: this lands in video_analytics.raw_metrics.
    raw: { aweme_id: id, author: author, create_time: a.create_time || null, statistics: s },
  };
}

async function getProfile(handle) {
  const r = await call('/v1/tiktok/profile', { handle, trim: 'true' });
  if (r.error) return r;
  const user = r.body.user;
  const stats = r.body.stats || {};
  if (!user || !user.uniqueId) return fail('profile_not_found', 'not_found', r.status);
  if (user.privateAccount === true || user.secret === true) {
    return fail('profile_private', 'private', r.status);
  }
  return {
    handle: String(user.uniqueId).toLowerCase(),
    bio: typeof user.signature === 'string' ? user.signature : '',
    followers: num(stats.followerCount),
    videoCount: stats.videoCount == null ? null : num(stats.videoCount),
    raw: { id: user.id || null, uniqueId: user.uniqueId },
  };
}

async function listVideos(handle, limit = 30) {
  const byId = new Map();
  let cursor = null;
  for (let page = 0; page < MAX_VIDEO_PAGES && byId.size < limit; page += 1) {
    const params = { handle, trim: 'true' };
    if (cursor) params.max_cursor = String(cursor);
    const r = await call('/v3/tiktok/profile/videos', params);
    if (r.error) {
      // A provider wide failure always propagates. Anything else after the
      // first page still leaves a usable (shorter) list; the single video
      // lookups cover whatever it missed.
      if (page === 0 || r.kind === 'provider') return r;
      return { videos: [...byId.values()].slice(0, limit), partial: true };
    }
    const items = Array.isArray(r.body.aweme_list) ? r.body.aweme_list : [];
    for (const item of items) {
      const v = normalizeVideo(item);
      if (v && !byId.has(v.id)) byId.set(v.id, v);
    }
    const next = r.body.max_cursor;
    if (items.length === 0 || r.body.has_more === false || r.body.has_more === 0 || !next || next === cursor) break;
    cursor = next;
  }
  return { videos: [...byId.values()].slice(0, limit), partial: false };
}

async function getVideo(url) {
  const r = await call('/v2/tiktok/video', { url, trim: 'true' });
  if (r.error) {
    return r.kind === 'not_found' ? fail('video_not_found', 'not_found', r.status) : r;
  }
  const v = normalizeVideo(r.body.aweme_detail);
  return v || fail('video_not_found', 'not_found', r.status);
}

module.exports = {
  getProfile,
  listVideos,
  getVideo,
  // exported for the offline tests
  normalizeVideo,
};
