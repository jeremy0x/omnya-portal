# 0003. Single video link verification

**Date**: 2026-10-27
**Status**: In Progress

## Summary

Creators can submit a live video link alongside their social handle when filing a Final campaign submission. The portal automatically resolves mobile share links, queries the provider for that specific video, and verifies that the author matches the creator handle. Once confirmed, the video views, likes, comments, title, and thumbnail are saved immediately to provide instant verified metrics for client reports and creator bonuses.

## Requirements

**User stories**:
- As a creator, I want to submit my video link along with my handle and get it verified immediately, so that my views count toward campaign requirements without delay.
- As a creator, I want to paste links copied directly from my mobile app (including short links like vt.tiktok.com) and have them work automatically.
- As an account manager, I want the portal to confirm that submitted videos were uploaded by that creator's account, so that creators cannot claim credit for other people's videos.
- As an owner, I want verified view counts and metrics fetched directly from public platform data, so that bonuses and client reports are accurate.

**Acceptance criteria**:
- **AC-1**: When submitting a Final video in the submission form, the creator sees two fields: Platform Account Handle and Video Link. The handle field pre fills automatically from the creator profile for that platform, but remains editable if an alternate handle was used.
- **AC-2**: The server accepts standard desktop links and mobile share redirect links across TikTok (`vt.tiktok.com`, `vm.tiktok.com`, `tiktok.com/t/`), Instagram (`instagram.com/share/`, `instagram.com/reel/`, `instagram.com/p/`), and YouTube (`youtu.be/`, `youtube.com/shorts/`, `youtube.com/watch`). The server unrolls redirects and canonicalizes the URL before making provider calls.
- **AC-3**: The server calls the ScrapeCreators single video endpoint matching the platform (`/v2/tiktok/video`, `/v1/instagram/post`, `/v1/youtube/video`) with a 15 second timeout.
- **AC-4**: The server compares the author handle returned by the provider with the submitted handle (case insensitive, stripped of `@` symbols and whitespace). If the handles match, verification succeeds. If the handles do not match, the server returns 422 `author_mismatch` with the video author and expected handle, and writes nothing.
- **AC-5**: On successful verification, the server records `submissions.view_count_verified` using `GREATEST(existing, new_views)`, sets `view_count_verified_at = now()`, stamps `verified_views_source = 'link'`, and saves thumbnail and title. It also upserts a complete metric snapshot into `video_analytics`.
- **AC-6**: A single submission can be refreshed on demand via `POST /api/analytics/manual-sync` using the same single video endpoint without requiring an OAuth token.
- **AC-7**: If a video link is private, deleted, or unparseable, the server returns a descriptive error (such as `video_not_found` or `video_private`) without updating stored metrics. Verification endpoints are rate limited to 10 requests per user per minute.

## Decision

**Chosen option**: Option 1: Single video link verification with author confirmation.

Build single video verification into the submission flow. Automatically unroll mobile short links, call the provider single video endpoint, confirm that the author returned by the provider matches the creator handle, and write verified views and metrics.

**Implementation skills**: `scrapecreators-api` (`scrapecreators/agent-skills`, `.agents/skills/scrapecreators-api/`)

## Rationale

Full reasoning, alternatives considered, and trade offs are recorded in [rationale.md](rationale.md).

## Feature design

**Data model sketch**:

Existing tables receive additive fields:
- `submissions`:
  - `author_handle text null` (the handle confirmed for this submission)
  - `thumbnail_url text null` (video preview thumbnail)
  - `video_title text null` (video caption or title)
  - `duration_seconds int null` (video length)
  - `likes_verified bigint null default 0`
  - `comments_verified bigint null default 0`
  - `shares_verified bigint null default 0`
- `video_analytics`:
  - Receives the upserted snapshot with `raw_metrics` containing the provider response.

**API surface**:

| Endpoint | Method | Key inputs | Key outputs | Auth | Key errors |
|---|---|---|---|---|---|
| `/api/social/verify-video-link` | POST | `platform: string, handle: string, url: string, submissionId?: uuid` | `ok: true, video: object, authorMatches: true` | bearer, creator or staff | 400 invalid input, 404 video not found, 422 author mismatch, 429 rate limit, 502 provider error |
| `/api/analytics/manual-sync` | POST | `submissionId: uuid` | updated submission summary | bearer, creator or staff | 403 unauthorized, 404 not found, 502 provider error |

**Value sourcing**:

| Action | Value produced / displayed | Source |
|---|---|---|
| Verify submit | unrolled video URL | input `url` resolved through `resolveShortLink` redirect follow |
| Verify submit | provider video object | ScrapeCreators single video endpoint for that platform |
| Verify submit | confirmed author | `video.authorHandle` compared to input `handle` |
| Verify submit | verified view count | `video.views` written through `GREATEST` on `submissions` |
| Verify submit | thumbnail and title | `video.thumbnailUrl` and `video.caption` from provider payload |
| Verify submit | metrics snapshot | `video_analytics` row upserted on `submission_id` |

**Key invariants**:
- A video whose provider author does not match the creator handle is never verified.
- Stored verified views can never decrease upon re sync.
- Verification uses one single video request and never triggers whole profile background crawls.

**Security model**:
- Verification runs server side in `api/` using `SCRAPECREATORS_API_KEY`.
- The provider key is never exposed to the browser.
- Creators can only verify links for submissions belonging to campaigns they are assigned to.

**Configuration required**:
- `SCRAPECREATORS_API_KEY`: API key for ScrapeCreators (already present for TikTok).

**Critical test scenarios**:
- Happy path: creator submits `@alex_ugc` and a valid TikTok short link `vt.tiktok.com/...`; redirects resolve, author matches, verified views and thumbnail are returned (verifies **AC-1**, **AC-2**, **AC-3**, **AC-4**, **AC-5**).
- Author mismatch: creator submits a video uploaded by `@different_creator`; verification fails with 422 `author_mismatch` (verifies **AC-4**).
- Private or broken link: creator submits a deleted video URL; verification returns 404 `video_not_found` (verifies **AC-7**).
- Manual re sync: owner or creator triggers manual sync on a verified submission; views are refreshed using the single video fetch (verifies **AC-6**).

## Build plan

- [x] Milestone 1: Provider adapter for single video fetching across TikTok, Instagram, and YouTube (`api/_utils/socialPublic.js`) with short link resolution (AC-2, AC-3)
- [x] Milestone 2: Verification API endpoint (`/api/social/verify-video-link`) with author confirmation and verified views write (AC-4, AC-5, AC-7)
- [x] Milestone 3: Content submission form UI update with pre filled handle and video link inputs, showing live verification feedback (AC-1, AC-4, AC-5)
- [x] Milestone 4: Integration with manual sync and campaign analytics dashboards for on demand refreshes (AC-5, AC-6)
