# Verify: TikTok profile link tracking · spec 0002 · updated 2026-10-23
_Steps derived from spec 0002 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

Slice 1 only (build tasks 3 to 7). Live steps need migration `20261023000000` applied, `SCRAPECREATORS_API_KEY` set, and the `submissions` audit trigger fixed (every `submissions` update fails in production as of 2026-10-23, which blocks `apply_verified_views`).

## UI / manual
- [ ] As a creator, open Connections → TikTok card shows "Track TikTok with your profile link" and an input → AC-16 (slice 1 subset)
- [ ] Paste `https://www.tiktok.com/@Your.Handle?lang=en` → Save link → card shows an `OMNYA-XXXXXX` code, `@your.handle`, and an expiry 7 days out → AC-1
- [ ] Paste `not a handle!` → error "Paste your TikTok handle or profile link…" and nothing changes → AC-1
- [ ] Save the same handle again while pending → a different code appears → AC-3
- [ ] As a second creator, save a handle already verified for the first → 409 "already verified for another creator" → AC-2
- [ ] Put the code in the TikTok bio, run the cron once → card says "We found your code… waiting for your manager" → AC-4
- [ ] As an AM who does not manage that creator, POST `/api/tiktok-link/review` verify → 403 `not_your_creator` → AC-5
- [ ] Remove the code from the bio, then verify as the creator's AM → 409 `code_missing`, row still `code_found` → AC-5
- [ ] Put the code back, verify as the creator's AM → 200 `verified`; `admin_audit_logs` has one `tiktok_link_verified` row with the AM as actor and the handle as label → AC-5
- [ ] As an owner, reject a link with reason "ab" → 422 `reason_required`; with a real reason → `rejected`, card shows the reason and the input again → AC-6
- [ ] Owner runs Recalculate in Payout Manager with `TIKTOK_VERIFIED_BONUS_ONLY=true` and an approved TikTok submission without verified views → message mentions the held TikTok bonus → AC-10
- [ ] Before the migration is applied: the TikTok card says "TikTok link tracking isn't switched on yet" → AC-19

## Commands
- [ ] `node supabase/migrations/__tests__/tiktok-profile-links.test.cjs` → 39 passed (guard trigger, unique handle, GREATEST, stale write, thinning, RLS) → AC-2, AC-8, AC-17, AC-18, AC-20
- [ ] `node tests/tiktok-link.test.cjs` → 65 passed (normalizer, codes, adapter mapping, error kinds, write rules) → AC-1, AC-4, AC-8, AC-11, AC-12, AC-19
- [ ] `node tests/tiktok-link-routes.test.cjs` → 49 passed (save, review, cron, recalculate through the real handlers) → AC-1 to AC-10, AC-12, AC-19
- [ ] `curl -H "Authorization: Bearer $CRON_SECRET" https://<prod>/api/cron/sync-tiktok-links` → 200 summary with `profiles_fetched ≥ 1`, and the creator's Final submission has `view_count_verified_at` set and `verified_views_source = 'link'` → AC-7, AC-8 (build task 8)
- [ ] Same call with a wrong secret → 401 → AC-7
- [ ] `npm run db:migrate -- --status` → `20261023000000_tiktok_profile_links.sql` reads `applied` → AC-19

## Value sourcing
- [ ] Saved handle: paste `@Some.Creator`, a profile URL, and a `vm.tiktok.com` short link for the same account → all store `some.creator` → normalized handle
- [ ] Code: 20 saves never repeat a code and never contain I, L, O or U → code
- [ ] Code found: a bio with the code in lowercase still moves the row to `code_found`; an expired code does not, even when present → code found?
- [ ] Follower count: compare `follower_count` and today's `social_profile_snapshots` row with the TikTok app → follower count
- [ ] Snapshot day: run the cron at 23:30 and 00:30 UTC → two rows with consecutive `snapshot_date` (UTC, not local) → snapshot day
- [ ] Author: a Final submission linking someone else's viral video stays unverified and the summary shows `author_mismatch: 1` → author matches?
- [ ] Verified views: set the stored value to 120000, have the provider return 0 → value stays 120000 → verified views
- [ ] Sanity cap: stored 5000, one fetch of 9,000,000 → nothing written, `views_jump_held: 1`; the next run also near 9,000,000 → written → sanity cap baseline
- [ ] Single lookup: a Final submission posted 46 days ago not in the feed → no `/v2/tiktok/video` call → single lookup eligible?
- [ ] Usable OAuth: a creator with a connected, unexpired token is skipped (`creators_eligible` excludes them); set `reauth_required` → included next run → usable OAuth token
- [ ] Hold flag: `TIKTOK_VERIFIED_BONUS_ONLY` unset → Recalculate output for TikTok is identical to before the change → hold flag
- [ ] Is TikTok: a submission whose dropdown says TikTok but links Instagram is not held → is TikTok?

## Acceptance-criteria coverage
- AC-1, AC-2, AC-3: UI steps 2 to 5, routes suite, value sourcing (handle, code)
- AC-4: UI step 6, routes suite (cron pending pass)
- AC-5, AC-6: UI steps 7 to 10, routes suite
- AC-7, AC-8: curl step, routes suite, value sourcing (author, views, cap, lookup)
- AC-9: value sourcing (usable OAuth), routes suite
- AC-10: UI step 11, routes suite, value sourcing (hold flag, is TikTok)
- AC-12: routes suite (402 stops the run, no creator changed); config test is slice 3
- AC-13: routes suite (last fetched moves only on a finished pipeline); time budgets not yet exercised
- AC-17, AC-18, AC-20: PGlite suite
- AC-19: UI step 12, all three suites
- Not built yet (slices 2 to 4): AC-11, AC-14, AC-15, AC-16 (full card), AC-12 config test, AC-18 cron, AC-9 OAuth write path
