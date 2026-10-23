# 0002. TikTok profile link tracking: rationale

## Context

> ⚠️ Premise note: this feature fetches TikTok data that TikTok's terms don't allow anyone to collect automatically. A paid provider takes on the collection, and the legal exposure that comes with it, but the agency still depends on something TikTok can break, or object to, at any time. That is acceptable as a bridge while the TikTok app is in review (#3), but it shouldn't be the only path forever. The design keeps OAuth as the preferred source whenever it's usable (AC-9) and puts the provider behind one adapter file, so moving off it costs little.

TikTok is the agency's main platform. The OAuth integration is built, but TikTok limits an unreviewed app to a handful of named test accounts, so in production no real creator can connect. Until the app passes review, the portal has no way of knowing how a creator's TikTok videos perform, except the number the creator types in.

That number matters more than it looks. `api/earnings/recalculate.js` pays view bonuses from $50 up to $1,000 per video. It prefers `submissions.view_count_verified`, but nothing in the codebase ever writes that column (it was added in `20260530000000_payout_system.sql` and has defaulted to 0 since). So every TikTok bonus today is based on `view_count_submitted`, a number the creator types in. The scope's done line ("only verified links count toward earnings") is really asking for the first writer of that column, plus a rule that stops self reported counts unlocking bonuses.

The forces involved are cost (a small agency, about 100 creators to start), honesty of the payout ledger (live payouts are about to run for the first time, #5), fraud (anyone can paste a famous creator's link), operational simplicity (Vercel functions with a 300 second limit and Vercel cron, no queue infrastructure), and the existing data shape. `creator_social_accounts` has `UNIQUE (user_id, platform)` and is read by every connection screen. `creator_videos` and `video_metrics` already exist for TikTok OAuth.

Compliance: no regulated data (no payments data, health data or special category PII). The feature handles public handles, public counts and bio text. Bio text is read in memory and never stored. The privacy page must still disclose the third party processor.

## Options considered

The load bearing decision is where public TikTok data comes from without the creator's OAuth. Smaller decisions are listed after the options.

### Option 1: Hosted scraper API with sync REST (ScrapeCreators), behind an adapter

The function calls a paid REST API that returns public profile, video list and single video data for a handle or URL, paying per request in credits.

**Pros**:
- Synchronous REST fits a cron function directly, with no job polling.
- Cheapest at this volume: about 27k requests a month, about $50 on the $47 / 25k credit pack, and credits don't expire.
- An official Agent Skill documents its endpoints, which lowers the chance of building against invented field names.
- The provider deals with TikTok's anti bot measures and proxies, not the agency.

**Cons**:
- A vendor dependency with a small company behind it. If it disappears, tracking stops until the adapter is pointed somewhere else.
- The exact field names and the private and not found signals were not verified during design (build task 1 checks them on the free trial).
- Still against TikTok's terms for automated collection, even if indirectly.

### Option 2: Hosted scraper API on daily unit plans (EnsembleData)

The same model from a longer established vendor, priced in daily units.

**Pros**:
- An established vendor with sync REST, and errors on their side aren't charged.
- A natural fallback behind the same adapter.

**Cons**:
- About $200 a month at this volume (the Bronze plan, 5,000 units a day). The video list costs 1 unit per 10 posts.
- Daily units don't roll over, so unused capacity is wasted.

### Option 3: Apify actor (clockworks/tiktok-scraper)

Run a hosted scraping actor on Apify and read its dataset.

**Pros**:
- The only option whose fields (`authorMeta.fans`, `authorMeta.signature`, `playCount`) were confirmed in sample output during design.
- A mature platform with good tooling.

**Cons**:
- Pay per result: polling 30 videos per creator 4 times a day comes to about 360k results a month, or $600+.
- Actor runs are asynchronous, so the cron has to start a run and then collect it later, or block on it. That's a poor fit for a 300 second function.

### Option 4: Fetch and parse TikTok's public profile pages ourselves

Request `tiktok.com/@handle` from the function and parse the JSON embedded in the page.

**Pros**:
- No provider fee and no vendor.

**Cons**:
- TikTok blocks or challenges datacenter IPs (which Vercel functions use), so it would likely fail from day one. This wasn't verified, but it's widely reported.
- The embedded JSON shape changes without notice, and the agency would own every break.
- It puts the terms of service exposure directly on the agency.

TikTok's own routes were ruled out. The Research API is limited to approved non profit research and explicitly excludes commercial users. oEmbed returns embed HTML with no counts, bio or follower data. The Display API needs the creator's OAuth, which is the very thing that is blocked.

**Smaller decisions** (all chosen by the engineer during design; the runner up is in brackets):
- Video scope: every recent profile video is stored, and Final submissions are matched to them [only submitted videos].
- Ownership: a bio code that the job detects, then manager approval [manager checks by hand].
- Storage: new columns on the existing tiktok row of `creator_social_accounts`, with OAuth taking precedence [a separate links table].
- Cadence: every 6 hours [12 hours, alongside the current sync].
- Earnings path: write `submissions.view_count_verified` [have earnings read `video_analytics`].
- Unverified TikTok: base pay still counts, the bonus is held [keep the self reported fallback].
- Depth: the 30 most recent videos, plus a single lookup for any unmatched submission [every video].
- Failures: content errors flag at once, transient errors after 2 runs [flag on the first failure].
- View drops: keep the highest value ever seen [always the latest].
- Backfill: all of the creator's submissions, as long as the video's author is the verified handle [only submissions made after verification].
- Recalculation: stays a manual owner action [the job triggers it].
- Provider outage: flag no creator, show it to owners [treat it like any failure].

Smaller calls I made myself (pick, why, runner up):
- **Code format** `OMNYA-XXXXXX`, Crockford base32, valid 7 days. Short enough to type into a bio, with no characters that are easy to confuse, and a 7 day life covers a creator who doesn't act the same day. Runner up: a 4 digit number, which is easier to type but guessable and collides with ordinary bio text.
- **Separate `link_status` / `link_health` columns** rather than reusing `connection_status`. `connection_status` drives OAuth reconnect prompts and the nightly refresh sweep (`REAUTH_STATUSES`), and mixing link states into it would make the sweep skip, or wrongly prompt for, link only rows. Runner up: new `connection_status` values, which would need a CHECK change and would break existing UI assumptions.
- **Guard trigger rather than column grants** for AC-17. The existing `*_update_self` policies and table grants already let creators update their rows. A trigger is one place to read and test, whereas revoking column level UPDATE would need every existing writable column granted back one by one. Runner up: column grants.
- **`apply_verified_views` RPC** rather than a read and then write in JavaScript. `GREATEST` in one statement can't lose a race between the cron and a manual sync. Runner up: optimistic concurrency in JavaScript.
- **A separate cron route** (`15 */6 * * *`) rather than folding the work into `api/analytics/sync.js`. The two jobs have different failure semantics (provider wide versus per token), and the 15 minute offset keeps the two runs from overlapping on the hour. Runner up: one combined sync.
- **Time budget plus oldest first ordering** rather than a queue. At 100 creators with 4 running at once, a run needs about 50 to 100 seconds, well under the limit. The 240 second budget and the ordering make overflow degrade gracefully without adding Vercel Queues. Runner up: Vercel Queues, worth it past roughly 1,000 creators.
- **Queue route for managers** rather than a direct RLS read from the browser. It needs creator names and AM scoping joined in one place, and the existing AM select policy on `creator_social_accounts` doesn't expose `creators.name`. Runner up: an RLS read plus a second query for names.
- **Feature flag for the bonus hold.** Turning the hold on before a single creator can get verified views would freeze every TikTok bonus. Runner up: turning it on at deploy.

## Rationale

Option 1 wins because it fits how the system already runs. It is synchronous, request priced, and small enough to call from the existing cron shaped functions without adding a queue or a job poller, at about a quarter of the next cheapest option's cost (basis: your `api/AGENTS.md`, every privileged call lives in a Vercel function; boring technology, no new infrastructure). The unverified field names are a real risk, and that is why build task 1 checks real responses on the free trial before any code depends on them. The adapter boundary is there so that being wrong about the vendor costs one file (basis: ports and adapters for third party integrations).

The ownership design matters as much as the data source. Public data has no notion of who owns it, so without proof anyone can paste a viral creator's handle and earn on their views. A code in the bio is the standard proof for a public profile, because only the owner can edit the bio. The manager's click keeps the human sign off the scope asked for, and the author handle check on every matched video closes the remaining gap: submitting someone else's video as your own (basis: the scope's done line for #14; least privilege).

Writing `view_count_verified` through one service role function, never lowering it, and keeping money movement behind the owner's existing Recalculate button is what keeps the payout ledger trustworthy during its first live runs (#5). Scraped data can glitch to 0, and an automated job should never be the thing that moves money (basis: your `AGENTS.md`, writes must report when they did not happen; the payout drift lessons in `20260821000000_payout_drift_and_authz.sql`). The feature flag exists because the safe order is "verified views flowing" first and "self reported counts no longer pay" second. Doing them together would freeze every TikTok bonus on deploy day.

## References

**Project sources**:
- `AGENTS.md` and `api/AGENTS.md`: privileged work in `api/`, the handler order, the `isSchemaMissing` mapping, CHECK values for `creator_social_accounts`.
- `supabase/AGENTS.md` and spec [0001](../0001-production-config-migrations/index.md): one probe per migration, `npm run db:migrate`, the `configRules` and `config-test` patterns.
- `api/_utils/analytics.js`: `resolveShortLink`, `resolvePlatform`, `extractVideoId`, `fetchSubmissionsForUser`, `calculateEngagementRate`, `syncSubmissions`.
- `api/earnings/recalculate.js`: the bonus pass that prefers `view_count_verified`.
- `supabase/migrations/20260604000000_tiktok_integration.sql`: `creator_social_accounts`, `creator_videos`, `video_metrics`, their RLS and the safe view.
- `supabase/migrations/20260918000000_creator_portal_fixes.sql`: `creators.am_id` and `claim_creator`.
- Installed skill `scrapecreators-api` (`.agents/skills/scrapecreators-api/`): endpoint paths, the `x-api-key` header, 1 credit per call, `max_cursor` paging, handles without `@`.

**Practices & standards**:
- Ports and adapters (one module wraps a third party, so the vendor is swappable).
- Proof of control for public identities (a code placed somewhere only the owner can edit).
- Monotonic writes with `GREATEST` in a single statement to avoid lost update races.
- Expand only, feature flagged rollout for a change in money logic.
- Least privilege: service role only writers for derived financial inputs.

**Links** (web verified during design, 2026-10-23):
- ScrapeCreators (pricing and plans): https://scrapecreators.com/
- EnsembleData pricing: https://ensembledata.com/pricing
- Apify clockworks TikTok scraper: https://apify.com/clockworks/tiktok-scraper
- Apify EnsembleData TikTok API pricing: https://apify.com/ensembledata/tiktok-api/pricing
- TikTok Research API FAQ (eligibility): https://developers.tiktok.com/doc/research-api-faq
- TikTok Embed Videos (oEmbed fields): https://developers.tiktok.com/doc/embed-videos

## Provider landscape scan (2026-10-23)

Workload assumed: 100 creators × 4 runs a day × (1 profile call + about 1 to 2 video list calls), plus about 100 single video lookups a day, which comes to about 27k requests a month.

| Option | Bio and followers | Views per video | Pricing model | Approx. monthly at this workload | Call style |
|---|---|---|---|---|---|
| ScrapeCreators | profile endpoint (fields to confirm) | `/v3/tiktok/profile/videos` (fields to confirm) | credits, 1 per call; $47 / 25k, no expiry | about $50 | sync REST |
| EnsembleData | user info, 1 unit | 1 unit per 10 posts | daily units; Bronze $200 / 5,000 a day | about $200 | sync REST |
| Apify clockworks | yes (`fans`, `signature`) | yes (`playCount`, …) | per result, from $1.70 / 1k | $600+ | async actor run |
| TikTok Research API | n/a | n/a | gated to non profit research | not eligible | n/a |
| TikTok oEmbed | no | no | free | n/a | sync |
| Self hosted HTML scrape | unverified | unverified | free | likely blocked from datacenter IPs | n/a |

Not checked during design: Bright Data, RapidAPI TikTok scrapers.
