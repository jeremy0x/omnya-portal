# 0002. TikTok profile link tracking

**Date**: 2026-10-23
**Status**: In Progress

## Summary

A creator can paste their TikTok profile link instead of connecting through OAuth (the "log in with TikTok" flow, which TikTok limits to named test accounts until the app is reviewed). The portal gives them a short code to put in their TikTok bio. A job sees the code, and their manager clicks Verify. From then on, a job every 6 hours pulls their public videos and follower count through ScrapeCreators (a paid public data API). Each video that matches one of their Final submissions gets its verified view count written. TikTok view bonuses are then paid only on those verified views, never on a number the creator typed in.

## Requirements

**User stories**:
- As a creator, I want to add my TikTok by pasting my profile link, so that my views count without waiting for TikTok to approve the app.
- As a creator, I want to see clearly whether my link is waiting, verified, rejected or broken, so that I know what to do next.
- As an account manager, I want proof that a creator owns the profile before I verify it, so that nobody earns on someone else's videos.
- As an owner, I want TikTok bonuses to be based only on views the portal fetched itself, so that payouts can't be inflated by self reported numbers.
- As an owner, I want to know when the data provider is down or out of credits, so that creators aren't told their link is broken because of a billing problem.

**Acceptance criteria**:
- **AC-1**: A creator saves a TikTok profile as `handle`, `@handle`, `https://www.tiktok.com/@handle` (with or without a trailing path or query), or a `vm.tiktok.com` / `tiktok.com/t/` short link (resolved with the existing `resolveShortLink`). It is normalized to a lowercase handle matching `^[a-z0-9._]{2,24}$`. Anything else returns 422 `invalid_tiktok_handle`. On success the creator's `(user_id, 'tiktok')` row in `creator_social_accounts` is upserted with `link_status = 'pending_code'`, a fresh code, and `link_code_expires_at = now() + 7 days`. Any OAuth columns on that row are left untouched. The response returns `handle`, `linkStatus`, `code`, `codeExpiresAt`.
- **AC-2**: Saving a handle that is already `verified` for a different user returns 409 `handle_claimed` and changes nothing. The database also enforces this with a partial unique index (AC-5 relies on it too).
- **AC-3**: Saving a handle that differs from the current one, whatever the current state, resets the row to `pending_code` with a new code. It clears `link_code_found_at`, `link_verified_at`, `link_verified_by` and `link_rejected_reason`, and sets `link_health = 'ok'` and `link_failure_count = 0`. Saving the same handle again while it is `pending_code` issues a new code and expiry. Saving the same handle while it is `verified` changes nothing and returns the current state.
- **AC-4**: For every `pending_code` row, the scheduled job, and a creator's **Check now** call, fetch the profile and test whether the bio contains the code (case insensitive). If it does and the code has not expired, the row moves to `code_found` and `link_code_found_at` is set. If the code has expired, the row stays `pending_code` and the creator sees "Code expired, save your link again to get a new one". Check now is limited to 3 calls per user per rolling hour (429 with `Retry-After` beyond that). Check now returns 409 `invalid_link_state` unless the row is `pending_code`. The cron polls only `pending_code` rows whose code has not expired, so expired codes cost no credits. A profile error during a pending check (not found, private) leaves the row `pending_code`, and Check now returns it in the response (`profileError: 'profile_not_found' | 'profile_private'`). Health rules (AC-11) don't apply to pending rows.
- **AC-5**: Verify succeeds only when the row is `code_found` and the caller is an owner, or the AM whose `account_managers.id` equals the creator's `creators.am_id`. A creator with no AM (`am_id IS NULL`) can be reviewed by owners only. Before writing, Verify fetches the profile once more and refuses with 409 `code_missing` if the code is no longer in the bio. The write is a conditional UPDATE (`.eq('id', accountId).eq('link_status', 'code_found').eq('link_handle', handleShownToManager)` followed by `.select()`). Zero rows returned means 409 `invalid_link_state`, so a handle changed or removed mid review is never verified. On success it sets `link_status = 'verified'`, `link_verified_at`, and `link_verified_by`. It then writes one `admin_audit_logs` row (action `tiktok_link_verified`, entity_type `creator_social_account`, entity_label the handle) and only after that sends the creator a "TikTok verified" email. An email failure is logged and never fails the verify. Any other AM, creator, client or pending user gets 403 `not_your_creator` (or 403 from the role guard). A unique index violation (another creator verified the same handle first) returns 409 `handle_claimed`.
- **AC-6**: Reject needs a reason of 3 to 500 characters (422 `reason_required` otherwise) and has the same caller rule as AC-5. It works from `pending_code`, `code_found` or `verified`. It is a conditional UPDATE on the state and handle shown to the manager, like Verify. It sets `link_status = 'rejected'` and `link_rejected_reason`, writes an audit row (`tiktok_link_rejected`), and then emails the creator with the reason (an email failure never fails the reject). A rejected creator can save a link again, either the same handle or a different one, and that starts over at `pending_code` (AC-1). Rejecting a `verified` link stops fetching but leaves `view_count_verified` already written in place. Those views were verified when written, and money only moves when an owner runs Recalculate, so the owner decides there.
- **AC-7**: Every 6 hours (`15 */6 * * *`), the cron route `GET /api/cron/sync-tiktok-links` (authenticated with `CRON_SECRET`, like `api/analytics/sync.js`) does the following for each `verified` row that has no usable OAuth token (AC-9). It fetches the profile (follower count) and the 30 most recent videos. It upserts each video into `creator_videos` with `source = 'link'` and `author_handle`, appends one `video_metrics` row per video, upserts today's (UTC) `social_profile_snapshots` row, and sets `follower_count` and `link_last_fetched_at` on the account.
- **AC-8**: For each Final submission (`submission_type` in `FINAL_SUBMISSION_TYPES`) of that creator whose link resolves to TikTok (`resolvePlatform`), the job extracts the video id. If that id is among the fetched videos, it uses that video. Otherwise it fetches the single video by the submission's URL, but only when the submission's `posted_at` (or `created_at` when null) is within the last 45 days, its `view_count_verified_at` is null or older than 24 hours, and no `not_found` result has been cached for it in the last 7 days (`video_analytics.raw_metrics.lookup_not_found_at`). Older submissions keep their last verified value. The video counts only when its author handle (the provider's unique id, never the display name) equals the row's verified `link_handle`. On a match it calls `apply_verified_views(submission_id, views, 'link', expected_user_id, expected_handle)`. That function writes only if the creator's tiktok row is still `verified` with that handle, so a handle change, removal or reject during the run writes nothing. It sets `view_count_verified = GREATEST(view_count_verified, views)`, `view_count_verified_at = now()` and `verified_views_source`. It also upserts `video_analytics` (`onConflict: submission_id`). On an author mismatch, nothing is written for that submission, and the run summary counts it under `author_mismatch`. This covers submissions made before verification (backfill). **Sanity cap**: when the new views exceed 20× the stored `view_count_verified`, and the stored value is at least 1,000, the views are applied only if the previous fetch of the same video (`creator_videos.view_count` before this run's upsert) was also above that 20× line. Two runs in a row have to agree. Otherwise the jump is logged (`views_jump_held`) and counted in the summary, and nothing is written.
- **AC-9**: When the tiktok row has a usable OAuth token (`access_token_encrypted IS NOT NULL` and `!needsReauth(row)` from `api/_utils/socialAccounts.js`, so an expired but refreshable token still counts as usable), the link job skips fetching videos for it. `syncSubmissions` in `api/_utils/analytics.js` then calls `apply_verified_views(…, 'oauth')` after each successful TikTok upsert, so OAuth creators get verified views too. If the token later needs a reconnect (`reauth_required`) and the row also has a `verified` link, the link job takes over on its next run.
- **AC-10**: With `TIKTOK_VERIFIED_BONUS_ONLY=true`, `api/earnings/recalculate.js` handles a bonus eligible submission that resolves to TikTok like this. If `view_count_verified_at IS NULL`, it creates no bonus, leaves any existing non terminal bonus row unchanged, and counts the submission in a new `bonusHeld` total in the response. If it is set, it uses `view_count_verified` (even when 0) and never `view_count_submitted`. Base pay is unchanged. Other platforms keep today's logic. With the flag unset or not `true`, behaviour is exactly as today. PayoutManager shows `bonusHeld` after a recalculation.
- **AC-11**: These rules apply to `verified` rows only. A per creator fetch failure is classified. `profile_not_found` and `profile_private` (the provider reports the account missing, banned or private) set `link_health = 'needs_attention'` at once, with `link_last_error` set to that code. A transient per creator error (timeout or 5xx on that creator's call, after one immediate retry) increments `link_failure_count`, and at 2 sets `needs_attention` with `link_last_error`. Any successful fetch resets `link_failure_count = 0` and `link_health = 'ok'`. Verified views already written are never reduced because of a failure.
- **AC-12**: A provider wide failure stops the run early and changes no creator's health or failure count. That means 401, 402, 403 or 429 from ScrapeCreators, or 3 consecutive 5xx or timeouts. "Consecutive" is one counter shared by the 4 workers, which any successful provider call resets to 0. On a provider wide failure, workers start no new creators, and creators already in flight finish without health changes. The route logs `{ event: 'tiktok_link_sync_provider_unavailable', status }` and responds 503 `provider_unavailable`. Check now, which is user facing, maps the same provider wide failure to 502 `provider_unavailable` instead. **Test connections** in System Config (`POST /api/admin/config-test`) reports ScrapeCreators as `ok` (with the credit balance), or `failed` with the HTTP status. It shows amber when the balance is below 2,000 credits (about 2 days at the planned volume).
- **AC-13**: Each cron run processes rows ordered by `link_last_fetched_at ASC NULLS FIRST`, 4 creators at a time. It stops starting new creators after 240 seconds. Each creator also has a 45 second deadline, after which their remaining single video lookups are skipped and left for the next run. So the run finishes inside the 300 second limit (`maxDuration: 300` set in `vercel.json`). `link_last_fetched_at` moves forward only when a creator's whole pipeline finished, so a creator who was cut short or failed partway goes first next run. It logs one structured summary (`tiktok_link_sync_completed` with counts: profiles fetched, codes found, videos upserted, submissions verified, author mismatches, failures by reason, duration), with no handles, tokens or user ids.
- **AC-14**: Removing a link (`POST /api/tiktok-link/remove`) sets `link_handle`, `link_status`, `link_code` and the verification fields to NULL, so fetching stops. It keeps `creator_videos`, `video_metrics`, `social_profile_snapshots`, and every `view_count_verified` already written (same reasoning as AC-6). It does not touch OAuth columns. A creator deleting their whole row through the existing `creator_social_accounts_delete_self` policy has the same effect, and is allowed. After a handle change, videos fetched under the old handle stay in `creator_videos` as history, but no longer match any submission, because matching requires the current verified handle.
- **AC-15**: AMs and owners get a **TikTok links** tab in the review area. An AM sees only their own creators' rows; an owner sees all. Each row shows the creator's name, handle (a link to the profile), status, whether the code was found, follower count, last fetched time, and health with `link_last_error`. **Verify** is enabled only on `code_found`, and **Reject** asks for a reason. Rows that need action come first: `code_found`, then `needs_attention`, then `pending_code`, then the rest. When another creator also has the same handle saved (any non verified state), the row shows "also claimed by <name>", so the manager knows to look closer.
- **AC-16**: The TikTok card on the creator's Connections screen shows one of these states. **No link**: a handle input. **Pending**: the code with a copy button, "add this to your TikTok bio", the expiry date, and Check now. **Code found**: "waiting for your manager". **Verified**: the handle, follower count, and last updated time. **Rejected**: the reason, plus the input to try again. **Needs attention**: the reason in plain words (for example "Your profile is private, so we can't read your views"). Remove is available in every state that has a link. When OAuth is also connected, the card shows OAuth as the active source.
- **AC-17**: A creator can't set their own verification state or verified views through the browser's anon key. Any INSERT that sets, or UPDATE that changes, `link_status`, `link_verified_at`, `link_verified_by`, `link_code_found_at`, `link_rejected_reason`, `link_health`, `link_failure_count`, `follower_count`, `submissions.view_count_verified`, `view_count_verified_at` or `verified_views_source`, `link_handle` or `link_code` to a non default value, made by the `authenticated` or `anon` role, is rejected (SQLSTATE 42501). Authenticated users can't insert or update `creator_videos` rows where `source = 'link'`.
- **AC-18**: A nightly cron (`GET /api/cron/thin-video-metrics`, `0 4 * * *`) calls `thin_video_metrics(90)`. That deletes every `video_metrics` row older than 90 days except the latest snapshot per `(video_id, UTC day)`, and returns how many rows it deleted.
- **AC-19**: If migration `20261023000000_tiktok_profile_links.sql` is not applied, every new route returns 503 `{ code: 'migration_missing' }` naming that file (on `42703`, `42P01`, `PGRST204` or `PGRST202`) instead of a generic 500. The creator card shows "TikTok link tracking isn't switched on yet".
- **AC-20**: A client can't read `creator_videos`, `video_metrics`, `social_profile_snapshots` or another creator's `creator_social_accounts` row (RLS returns zero rows). Clients keep seeing campaign numbers only through `video_analytics`, as today.

## Decision

**Chosen option**: Option 1: Public profile tracking through a ScrapeCreators adapter, ownership proven by a bio code and confirmed by the creator's manager, feeding the existing `view_count_verified` column.

Build TikTok tracking on public data fetched server side every 6 hours, behind one swappable adapter module. Store it on the creator's existing tiktok account row and in the existing video tables. Make verified views the only basis for TikTok bonuses, behind a flag.

**Implementation skills**: `scrapecreators-api` (`scrapecreators/agent-skills`, `.agents/skills/scrapecreators-api/`) · `supabase-postgres-best-practices` (`supabase/agent-skills`, `.agents/skills/supabase-postgres-best-practices/`) · `upstash-ratelimit-js` (`upstash/skills`, `.agents/skills/upstash-ratelimit-js/`) · `resend` (`resend/resend-skills`, `.agents/skills/resend/`)

## Rationale

Reasoning, options and the provider landscape: see [rationale.md](rationale.md).

## Feature design

**Data model sketch** (target; one migration, `supabase/migrations/20261023000000_tiktok_profile_links.sql`, wrapped in `BEGIN; … COMMIT;`, every column added nullable or with a default):

| Entity | Change | Fields (type, null) | Keys, relations, constraints |
|---|---|---|---|
| `creator_social_accounts` | add columns | `link_handle text null` · `link_status text null` · `link_code text null` · `link_code_expires_at timestamptz null` · `link_code_found_at timestamptz null` · `link_verified_at timestamptz null` · `link_verified_by uuid null` · `link_rejected_reason text null` · `link_health text not null default 'ok'` · `link_failure_count int not null default 0` · `link_last_error text null` · `link_last_fetched_at timestamptz null` · `follower_count bigint null` | CHECK `link_status IN ('pending_code','code_found','verified','rejected')` or NULL · CHECK `link_health IN ('ok','needs_attention')` · CHECK `link_handle ~ '^[a-z0-9._]{2,24}$'` · CHECK `link_handle IS NOT NULL OR link_status IS NULL` · CHECK `char_length(link_rejected_reason) <= 500` · FK `link_verified_by → auth.users(id) ON DELETE SET NULL` · UNIQUE INDEX `creator_social_accounts_verified_handle_key ON (lower(link_handle)) WHERE link_status = 'verified'` · INDEX on `(link_status, link_last_fetched_at)` WHERE `platform = 'tiktok'` · existing UNIQUE `(user_id, platform)` kept |
| `creator_videos` | add columns | `source text not null default 'oauth'` · `author_handle text null` | CHECK `source IN ('oauth','link')` · existing UNIQUE `(user_id, platform, platform_video_id)` is the upsert arbiter · `social_account_id → creator_social_accounts` (N:1) |
| `video_metrics` | none (retention only) | unchanged | `video_id → creator_videos` (N:1) · INDEX `(video_id, snapshot_at)` if missing (needed by `thin_video_metrics`) |
| `social_profile_snapshots` | **new** | `id uuid pk default gen_random_uuid()` · `social_account_id uuid not null` · `user_id uuid not null` · `snapshot_date date not null` · `follower_count bigint not null` · `video_count int null` · `created_at timestamptz not null default now()` | FK `social_account_id → creator_social_accounts(id) ON DELETE CASCADE` · UNIQUE `(social_account_id, snapshot_date)` · RLS select: self, owner and payment manager, AM of the creator (same three policy shapes as `creator_videos`); no insert, update or delete for `authenticated`; `REVOKE ALL FROM anon` |
| `submissions` | add columns | `view_count_verified_at timestamptz null` · `verified_views_source text null` | CHECK `verified_views_source IN ('oauth','link')` or NULL |
| `video_analytics` | none | upserted per matched submission | existing `onConflict: submission_id` |

Database functions and triggers in the same migration:
- `apply_verified_views(p_submission_id uuid, p_views bigint, p_source text, p_user_id uuid, p_handle text) RETURNS boolean`, `SECURITY DEFINER`, `EXECUTE` granted to `service_role` only. It runs a single `UPDATE submissions … SET view_count_verified = GREATEST(COALESCE(view_count_verified,0), p_views), view_count_verified_at = now(), verified_views_source = p_source WHERE id = p_submission_id AND (p_source = 'oauth' OR EXISTS (SELECT 1 FROM creator_social_accounts WHERE user_id = p_user_id AND platform = 'tiktok' AND link_status = 'verified' AND link_handle = p_handle)) RETURNING id`. So the cron and a manual sync racing each other can never lower the value, and a link write after a handle change, removal or reject is a no op. A false return is counted as `stale_skip` in the summary.
- `thin_video_metrics(p_keep_days int) RETURNS bigint`, `service_role` only (AC-18).
- `guard_link_verification_columns()`, a `BEFORE INSERT OR UPDATE` trigger on `creator_social_accounts` and on `submissions`. It raises 42501 when `auth.role() IN ('authenticated', 'anon')` and an AC-17 column is set on INSERT, or changed on UPDATE (`IS DISTINCT FROM`). Service role calls, migrations and psql (no JWT, so `auth.role()` is NULL) pass. PGlite tests simulate the roles by setting `request.jwt.claims` (`{"role":"authenticated","sub":…}`) before the statement. A trigger is used, not column grants, because the existing `*_insert_self` / `*_update_self` policies and table level INSERT/UPDATE grants already let creators write their row, and a trigger is one place that is easy to test.
- Column grants: `20260604000000` revoked table level SELECT on `creator_social_accounts` from `authenticated` and granted columns back one by one. So the migration must `GRANT SELECT (link_handle, link_status, link_code, link_code_expires_at, link_code_found_at, link_verified_at, link_verified_by, link_rejected_reason, link_health, link_failure_count, link_last_error, link_last_fetched_at, follower_count) ON public.creator_social_accounts TO authenticated`, or the security invoker safe view fails with permission denied. `social_profile_snapshots` gets `GRANT SELECT` to `authenticated` only.
- Extend `creator_social_accounts_safe` with `CREATE OR REPLACE VIEW`, adding the new columns after the existing ones (never `DROP VIEW`, which would drop grants and break `creator_connection_status`). `link_code` is included: only the row's creator, their AM and owners can read the row under RLS, and the code stops being secret once it's in a public bio anyway.
- A rollback file in `supabase/rollbacks/` and a `probes.json` entry (spec 0001's rule: every migration file has exactly one probe).

**Adapter to table mapping** (the link job's writes):

| Table.column | From |
|---|---|
| `creator_social_accounts` (new row on first save) | `user_id` = caller; `platform = 'tiktok'`; `creator_id` = `creators.id` where `creators.user_id = caller`; `workspace_id` NULL; `connection_status` left at its default `'not_connected'` (the nightly refresh sweep and `needsReauth` ignore rows with no token, which the build confirms with a test); `username` = handle |
| `creator_videos.user_id`, `creator_id`, `social_account_id` | from the account row |
| `creator_videos.platform_video_id`, `video_url`, `posted_at` | `video.id`, `video.url`, `video.postedAt` |
| `creator_videos.caption`, `thumbnail_url`, `duration_seconds` | `video.caption`, `video.thumbnailUrl`, `video.durationSeconds` (NULL when the provider omits them) |
| `creator_videos.view_count`, `like_count`, `comment_count`, `share_count` | `video.views`, `video.likes`, `video.comments`, `video.shares` (0 when missing; the columns are NOT NULL) |
| `creator_videos.source`, `author_handle`, `sync_status` | `'link'`, `video.authorHandle` lowercased, `'synced'`. The upsert key `(user_id, platform, platform_video_id)` is shared with the OAuth sync, so the last writer sets `source`. That's acceptable because a usable OAuth token stops the link job writing that creator's videos (AC-9). |
| `video_metrics` | `video_id` = the upserted `creator_videos.id`, `user_id`, `snapshot_at = now()`, the four counts, `engagement_rate` = `calculateEngagementRate` |
| `social_profile_snapshots` | `social_account_id`, `user_id`, `snapshot_date` = UTC date, `follower_count` = `profile.followers`, `video_count` = `profile.videoCount`; upsert on `(social_account_id, snapshot_date)` |
| `video_analytics` | the same row shape `syncSubmissions` builds (`user_id`, `creator_id`, `submission_id`, `campaign_id`, `platform = 'tiktok'`, `video_id`, `video_url`, counts, `engagement_rate`, `raw_metrics` = the provider video object, `pulled_at`) |

**State transitions** (`creator_social_accounts.link_status`; `link_health` is a separate health flag on `verified` rows):

| From | To | Trigger | Who |
|---|---|---|---|
| NULL or any | `pending_code` | save a new or changed handle (AC-1, AC-3) | creator |
| `pending_code` | `pending_code` | save the same handle again: new code and expiry | creator |
| `pending_code` | `code_found` | bio contains an unexpired code (AC-4) | cron or Check now |
| `code_found` | `verified` | Verify (AC-5) | owner or the creator's AM |
| `pending_code`, `code_found`, `verified` | `rejected` | Reject with reason (AC-6) | owner or the creator's AM |
| `rejected` | `pending_code` | save a handle again | creator |
| any | NULL | Remove (AC-14) | creator |
| `verified` + `ok` | `verified` + `needs_attention` | AC-11 failure rules | cron |
| `verified` + `needs_attention` | `verified` + `ok` | next successful fetch | cron |

**API surface** (all CommonJS, handler order per `api/AGENTS.md`: `applyCors`, method check, `applyRateLimit`, auth guard, body parse; responses via `sendOk` / `Errors.*`):

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/tiktok-link/save` | POST | `handle: string` (req; handle, @handle, profile URL or short link) | `handle, linkStatus, code, codeExpiresAt` | bearer, role `creator` | 401, 403, 409 `handle_claimed`, 422 `invalid_tiktok_handle`, 429 (10/hour/user), 503 `migration_missing` |
| `/api/tiktok-link/check` | POST | none | `linkStatus, codeFound: bool, codeExpired: bool, profileError?` | bearer, `creator` | 409 `invalid_link_state`, 429 (3/hour/user), 502 `provider_unavailable`, 503 (also 503 `rate_limit_unavailable` in production when Upstash is down: marked `failClosed` per spec 0001, since every call spends credits) |
| `/api/tiktok-link/remove` | POST | none | `removed: true` | bearer, `creator` | 404 `no_link`, 429 (10/hour/user), 503 |
| `/api/tiktok-link/review` | POST | `accountId: uuid` (req), `handle: string` (req, the handle the manager was shown), `action: 'verify' \| 'reject'` (req), `reason: string` (req for reject) | `accountId, linkStatus` | bearer, `owner` or `am` | 403 `not_your_creator`, 404, 409 `invalid_link_state` / `handle_claimed` / `code_missing`, 422 `reason_required`, 429 (60/min/user), 502 `provider_unavailable` (bio check on verify), 503 |
| `/api/tiktok-link/queue` | GET | none | `rows[]: { accountId, creatorId, creatorName, handle, linkStatus, codeFoundAt, followerCount, lastFetchedAt, health, lastError, verifiedAt }` | bearer, `owner` or `am` (AM scoped by `creators.am_id`) | 403, 503 |
| `/api/cron/sync-tiktok-links` | GET | `Authorization: Bearer CRON_SECRET` | summary counts (AC-13) | cron secret | 401, 500 `cron_not_configured`, 503 `provider_unavailable` |
| `/api/cron/thin-video-metrics` | GET | cron secret | `deleted: number` | cron secret | 401, 503 |
| `/api/admin/config-test` | POST | (existing) | adds `scrapecreators: { status, httpStatus?, credits? }` | owner (existing) | existing |
| `/api/earnings/recalculate` | POST | (existing) | adds `bonusHeld: number` | existing | existing |

The creator's own card state is read in the browser from `creator_social_accounts_safe` under RLS (no new route). The queue goes through a route because it joins creator names and applies AM scoping in one service role query. Provider module `api/_utils/tiktokPublic.js` exposes `getProfile(handle)`, `listVideos(handle, limit)` and `getVideo(url)`. Each returns the normalized shape below, or `{ error, kind }` where `kind` is `not_found | private | transient | provider`. It calls `/v1/tiktok/profile`, `/v3/tiktok/profile/videos` (paging with `max_cursor` until 30 videos) and `/v2/tiktok/video` with the `x-api-key` header, `trim=true`, and a 15 second timeout.

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| save | normalized handle | input `handle` → `resolveShortLink` for short links → regex extract `@([A-Za-z0-9._]+)` from the URL, or the bare value → lowercase |
| save | code | server generated: `OMNYA-` + 6 chars from the Crockford base32 alphabet via `crypto.randomInt` |
| save | code expiry | `now() + 7 days` (constant `LINK_CODE_TTL_DAYS = 7` in `api/_utils/tiktokLink.js`) |
| save | "already claimed" | `creator_social_accounts` row with `lower(link_handle)` equal, `link_status = 'verified'`, `user_id` different |
| check, cron | bio text | ScrapeCreators `/v1/tiktok/profile`, normalized to `profile.bio` by the adapter (the provider field name is confirmed in build task 1) |
| check, cron | code found? | `profile.bio.toUpperCase().includes(link_code)` and `now() < link_code_expires_at` |
| cron | follower count, video count | `/v1/tiktok/profile` normalized to `profile.followers`, `profile.videoCount` |
| cron | videos (id, url, posted time, views, likes, comments, shares, author) | `/v3/tiktok/profile/videos`, normalized to `{ id, url, postedAt, views, likes, comments, shares, authorHandle }` |
| cron | single video for an unmatched submission | `/v2/tiktok/video?url=<submissions.posted_link after resolveShortLink>` |
| cron | which submissions to match | `submissions` where `creators.user_id = account.user_id`, `submission_type` in `FINAL_SUBMISSION_TYPES`, `posted_link` not empty, `resolvePlatform = 'tiktok'` (reuse `fetchSubmissionsForUser(supabase, userId, 'tiktok')`) |
| cron | video id of a submission | `extractVideoId('tiktok', resolvedLink)` from `api/_utils/analytics.js` |
| cron | author matches? | `video.authorHandle.toLowerCase() === account.link_handle` |
| cron | verified views | `video.views` → `apply_verified_views` (GREATEST with the stored value) |
| cron | engagement rate in `video_analytics` | `calculateEngagementRate` from `api/_utils/analytics.js` |
| cron | snapshot day | UTC date of the run (`new Date().toISOString().slice(0,10)`) |
| cron | "usable OAuth token" | `access_token_encrypted IS NOT NULL` and `!needsReauth(row)` (`api/_utils/socialAccounts.js`) on the same row |
| cron | single lookup eligible? | `submissions.posted_at` (else `created_at`) within 45 days; `view_count_verified_at` null or older than 24 h; no `video_analytics.raw_metrics.lookup_not_found_at` within 7 days (set when a lookup returns not found) |
| cron | sanity cap baseline | stored `submissions.view_count_verified` and the previous `creator_videos.view_count` for that video, read before this run's upsert |
| review | handle shown to manager | input `handle` (from the queue row), used in the conditional UPDATE |
| review, check | bio still has the code | one `getProfile(handle)` call at review time |
| review | email helper | the shared Resend helper that `api/send-email.js` uses (the build extracts it into `api/_utils/` if it is only inline in the route) |
| review | caller may act | owner: `user_profiles.role = 'owner'` via `requireRole`; AM: `account_managers.user_id = caller` and `account_managers.id = creators.am_id`, where `creators.user_id = account.user_id` |
| review | verified by | caller's `auth.users.id` |
| review | creator email address and name | `user_profiles` (email) and `creators` (name) for `account.user_id`, sent through the existing `send-email` helper |
| queue | creator name | `creators.name` (join on `creators.user_id = account.user_id`) |
| queue | other claimants | other `creator_social_accounts` rows with the same `lower(link_handle)` and a different `user_id`, joined to `creators.name` |
| recalculate | is TikTok? | `resolvePlatform(sub)` (needs `platform` and `posted_link` added to the existing select) |
| recalculate | hold flag | env `TIKTOK_VERIFIED_BONUS_ONLY === 'true'` |
| config test | credit balance | ScrapeCreators `/v1/credit/balance` |
| config test | low balance threshold | constant 2,000 credits |
| creator card | plain words for each `link_last_error` | a fixed map in `src/CreatorConnections.js` (`profile_not_found`, `profile_private`, `fetch_failed`) |

**Key invariants**:
- One verified owner per handle (partial unique index, case insensitive).
- `view_count_verified` never decreases, and only `service_role` writes it (`apply_verified_views` plus the trigger). A jump of more than 20× needs two fetches in a row to agree before it lands.
- A link path write happens only while the creator's row is still `verified` with the handle that was fetched (checked inside `apply_verified_views`). Verify and Reject are conditional on the state and handle the manager saw.
- A video counts toward a submission only when its author handle equals the creator's verified handle.
- Earnings change only when an owner runs Recalculate. No cron touches `creator_earnings`.
- A provider wide outage never marks a creator's link as needing attention.
- OAuth, when usable, is the source of TikTok views. The link path never overwrites a row's OAuth columns, and the OAuth callback upsert never clears `link_*` columns (it only sends the OAuth fields).

**Security model**:
- The browser uses only the anon key under RLS. Every write in this feature goes through `api/` with the service role, after the role guard.
- Creators: save, check and remove act only on their own `(auth user, 'tiktok')` row, resolved from the JWT and never from input. They read their own row through `creator_social_accounts_safe`.
- AMs: review and the queue are scoped to creators where `creators.am_id` is their `account_managers.id`. Reading videos and snapshots uses the existing AM select policy shape.
- Owners: everything. Clients: nothing new (AC-20).
- `SCRAPECREATORS_API_KEY` is server only (no `REACT_APP_` prefix), and the provider is called only from `api/`, so the CSP `connect-src` stays as it is.
- PII: public handle, bio text (read in memory, never stored), and follower counts. The privacy page has to name ScrapeCreators as a processor of public profile data (Follow-up).
- Audit: verify and reject write `admin_audit_logs` rows with the actor, role, and the handle as the entity label.

**Configuration required**:
- `SCRAPECREATORS_API_KEY`: ScrapeCreators API key, server only. Add it to `api/_lib/configRules.js` as required in production, to `.env.example`, and to the config test.
- `TIKTOK_VERIFIED_BONUS_ONLY`: `true` turns on the TikTok bonus hold (AC-10). Unset in production until slice 1 is proven live (see Migration plan).
- `vercel.json` crons: `{ "path": "/api/cron/sync-tiktok-links", "schedule": "15 */6 * * *" }` and `{ "path": "/api/cron/thin-video-metrics", "schedule": "0 4 * * *" }`, plus `functions` entries `"api/cron/sync-tiktok-links.js": { "maxDuration": 300 }` and `"api/cron/thin-video-metrics.js": { "maxDuration": 300 }`.

**Critical test scenarios**:
- Happy path, end to end: a creator saves `https://www.tiktok.com/@Some.Creator?lang=en`, gets `some.creator` and a code. The fixture bio contains the code, so the cron moves it to `code_found`. The AM verifies. The next cron writes `view_count_verified = 120000` with `verified_views_source = 'link'` on that creator's Final submission, and recalculate with the flag on creates the 100K tier bonus. Verifies **AC-1**, **AC-4**, **AC-5**, **AC-7**, **AC-8**, **AC-10**.
- Author mismatch: a creator's Final submission links another account's viral video. The single video lookup returns a different `authorHandle`, so nothing is written, the summary counts `author_mismatch: 1`, and the bonus stays held. Verifies **AC-8**, **AC-10**.
- Views drop: the stored value is 120000 and the fetch returns 0, so the value stays 120000. Verifies **AC-8**.
- Glitch spike: the stored value is 5000 and one fetch returns 9,000,000, so nothing is written and `views_jump_held` is counted. If the next run also returns about 9,000,000, it is applied. Verifies **AC-8**.
- Stale write: the cron fetches `old.handle`, the creator changes the handle before the write, and `apply_verified_views` returns false (`stale_skip`) with the submission unchanged. Verifies **AC-8**, **AC-3**.
- Insert bypass: a creator using the anon key inserts a tiktok row with `link_status = 'verified'` and gets 42501. Verifies **AC-17**.
- Handle theft: user B saves a handle user A has verified and gets 409 `handle_claimed`. A concurrent verify of the same handle loses on the unique index with 409. Verifies **AC-2**, **AC-5**.
- Provider out of credits: the first call returns 402. The run stops with 503, no row's `link_failure_count` changes, and the config test shows `failed 402`. Verifies **AC-12**.
- Private profile, then recovery: a fetch returns `private`, so `needs_attention` is set at once. The next successful fetch resets it to `ok` and 0. A timeout twice in a row sets `needs_attention` on the second run. Verifies **AC-11**.
- Permission: an AM who doesn't manage the creator calls review and gets 403 `not_your_creator`. A creator using the anon key runs `update creator_social_accounts set link_status='verified'` and gets 42501. A client selecting `creator_videos` gets zero rows. Verifies **AC-5**, **AC-17**, **AC-20**.
- Migration missing: the route returns 503 `migration_missing` naming `20261023000000`. Verifies **AC-19**.
- Flag off: recalculate output for TikTok submissions is identical to today's. Verifies **AC-10**.

## Build plan

Tracer Bullet (from the scope header): slice 1 proves one real creator end to end in production with the thinnest code, and later slices thicken each segment. The whole data model lands in one migration in slice 1, because it is small and every slice reads it.

**Slice 1: one creator, verified views, end to end**
1. On the ScrapeCreators free trial, fetch the per endpoint OpenAPI specs for `/v1/tiktok/profile`, `/v3/tiktok/profile/videos`, `/v2/tiktok/video` and `/v1/credit/balance`. Record one real response of each, with personal data trimmed, as fixtures in `tests/fixtures/scrapecreators/`. Write the field mapping (bio, followers, views, author, private and not found signals) at the top of the adapter. Confirm that both the video list and `/v2/tiktok/video` return the author's unique id (the handle), not only the display name. If the single video endpoint doesn't, the author check in AC-8 needs a new decision before task 6. Satisfies **AC-4**, **AC-7**, **AC-8**, **AC-11**.
2. Migration `20261023000000_tiktok_profile_links.sql` for the full data model: columns, CHECKs, indexes, `social_profile_snapshots` with RLS, `apply_verified_views`, `thin_video_metrics`, the guard trigger, and the recreated safe view. Add the rollback file, the `probes.json` entry, and a PGlite migration test (trigger rejects a non service update, partial unique index, GREATEST). Satisfies **AC-2**, **AC-17**, **AC-18**, **AC-19**, **AC-20**.
3. [x] `api/_utils/tiktokPublic.js` (adapter plus error `kind` classifier) and `api/_utils/tiktokLink.js` (handle normalizer, code generator, matching), with offline unit tests on the fixtures. Satisfies **AC-1**, **AC-8**, **AC-11**, **AC-12**.
4. [x] `POST /api/tiktok-link/save` and a minimal handle input plus status line on the creator's TikTok card. Satisfies **AC-1**, **AC-2**, **AC-3**, **AC-19**.
5. [x] `POST /api/tiktok-link/review` (verify and reject, owner and AM scoping, audit row; email comes in slice 2). Satisfies **AC-5**, **AC-6**.
6. [x] `GET /api/cron/sync-tiktok-links`: unexpired `pending_code` rows → profile → bio code check → `code_found`. Then verified rows → profile and videos → `creator_videos`, `video_metrics`, snapshot → submission matching (lookup bounds, sanity cap) → `apply_verified_views` → `video_analytics`. Include the time budgets, concurrency and summary log. Add the `vercel.json` cron and `maxDuration` entries. Satisfies **AC-4**, **AC-7**, **AC-8**, **AC-13**.
7. [x] Recalculate hold behind `TIKTOK_VERIFIED_BONUS_ONLY`, plus `bonusHeld` in the response and in PayoutManager. Satisfies **AC-10**.
8. Prove it live: set `SCRAPECREATORS_API_KEY`, apply the migration with `npm run db:migrate` (spec 0001), and walk one real creator through save, verify (by an owner) and one cron run. Confirm `view_count_verified_at` is set on their submission. Satisfies **AC-1**, **AC-5**, **AC-7**, **AC-8**.

**Slice 2: ownership proof and the review workflow**
9. `POST /api/tiktok-link/check` (Check now) with the 3 per hour `failClosed` limit, reusing the cron's bio check. Satisfies **AC-4**.
10. Creator card in all six states, Check now, copy code, Remove (`POST /api/tiktok-link/remove`), and the OAuth active indicator. Satisfies **AC-14**, **AC-16**.
11. `GET /api/tiktok-link/queue` and the **TikTok links** tab with ordering, Verify and Reject with a reason. Satisfies **AC-15**, **AC-5**, **AC-6**.
12. Verified and rejected emails through the existing send-email path (the rejection carries only the manager's reason). Satisfies **AC-5**, **AC-6**.

**Slice 3: failure handling**
13. Per creator health rules (immediate vs 2 strikes, reset on success) and the creator facing error text map. Satisfies **AC-11**, **AC-16**.
14. Provider wide abort and the ScrapeCreators check in `config-test`, plus `configRules` for `SCRAPECREATORS_API_KEY`, the low credit amber, and `.env.example`. Satisfies **AC-12**.

**Slice 4: OAuth convergence and housekeeping**
15. `syncSubmissions` calls `apply_verified_views(…, 'oauth')` for TikTok, and the link job skips rows with a usable token and takes over after `reauth_required`. Satisfies **AC-9**.
16. `GET /api/cron/thin-video-metrics` with its `vercel.json` entry. Satisfies **AC-18**.
17. RLS tests for client invisibility and AM scoping on the new table and the existing video tables. Satisfies **AC-20**, **AC-17**.

## Migration plan

**Strategy**: feature flagged.
**Phases**:
1. Apply the migration (additive only: nullable columns, defaults, a new table, functions, a trigger). Deploy slices 1 to 3 with `TIKTOK_VERIFIED_BONUS_ONLY` unset, so earnings behave exactly as today while real creators verify and views start landing.
2. Once at least one live creator has verified views landing, and the owner has checked them against the TikTok app, tell creators that TikTok bonuses now need a verified link, then set `TIKTOK_VERIFIED_BONUS_ONLY=true`. From that recalculation on, TikTok bonuses without verified views are held. Existing bonus rows are left as they are (grandfathered), because a held submission is skipped, not rewritten.
**Rollback**: unset `TIKTOK_VERIFIED_BONUS_ONLY` to restore today's bonus logic at once (no deploy needed beyond the env change and a redeploy). Remove the cron entries to stop fetching. The schema rollback in `supabase/rollbacks/` drops the new columns, table, functions and trigger, and is safe because nothing outside this feature reads them.
**Risks**: the guard trigger fires on every update to `submissions` and `creator_social_accounts`, so an existing service role path is unaffected but any browser path that updates a protected column will now fail loudly (intended). The scraped data can disagree with the TikTok app by a few percent, so phase 2 waits for a manual spot check.

## Consequences

**Positive**:
- TikTok works in production now, without waiting on TikTok's app review (#3).
- For the first time, bonuses are paid on views the portal fetched itself. `view_count_verified` finally has a writer (it had none before).
- One adapter file isolates the provider, so a switch to EnsembleData or to official OAuth only touches that file.
- Managers can see a creator's whole TikTok profile, not just submitted posts.

**Negative / tradeoffs**:
- A new paid dependency: about $50 a month at 100 creators, rising roughly linearly. Run out of credits and tracking stops (loudly, per AC-12).
- Public scraping goes against TikTok's terms for automated access. The legal exposure sits mainly with the provider, but TikTok can break it at any time, and it should not be mentioned as a data source in TikTok's own app review (#3, #6).
- Numbers are up to 6 hours old, and public counts can differ slightly from what the creator sees in TikTok's analytics.
- Creators must edit their bio once, which is friction, and some will need support.
- With the flag on, a creator without a verified link has their TikTok bonuses held, and that will cause questions.

**Neutral**:
- Three new cron entries in total use (two new). They need the Vercel Pro plan, which the existing 12 hour cron already implies.
- `creator_social_accounts.connection_status` keeps describing OAuth only. Link state lives in `link_status` / `link_health`, so existing OAuth code and the nightly refresh sweep are unaffected.
- `video_metrics` grows by about 12k rows a day before thinning, and stays bounded at about 90 days of full detail.

## Follow-up

- [ ] Update the privacy page (`/privacy`) to name ScrapeCreators as a processor of public TikTok profile data, before slice 1 goes live.
- [ ] `scrapecreators-api` was installed during this design and is not yet listed in `api/AGENTS.md` `## Agent skills`. It is area specific (`api/_utils/tiktokPublic.js`), so it belongs in `api/AGENTS.md`, not root.
- [ ] Add `SCRAPECREATORS_API_KEY` and `TIKTOK_VERIFIED_BONUS_ONLY` to the `api/AGENTS.md` gotchas once built (`/sync`).
- [ ] Fresh database drift: `20260604000000_tiktok_integration.sql` adds a `connection_status` CHECK without `sync_failed` (and `expired`), while production accepts both (`api/_utils/socialAccounts.js`, probed 2026-08-21). A fresh database (PGlite tests, a restore drill) will reject the `sync_failed` write in `syncSubmissions`. Fix with a migration that aligns the CHECK with production.
- [ ] Wire the `tiktok_link_sync_provider_unavailable` and `needs_attention` events into alerts when #8 (observability and alerts) is designed.
- [ ] When TikTok approves the app (#3), decide whether to nudge verified link creators to upgrade to OAuth, or keep link tracking as the default.
- [ ] Revisit the provider choice if monthly credit use goes past the $47 tier or the error rate is high. EnsembleData is the ready fallback behind the same adapter.
