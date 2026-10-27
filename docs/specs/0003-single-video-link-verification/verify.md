# Verify: Single video link verification · spec 0003 · updated 2026-10-27

_Steps derived from spec 0003 acceptance criteria. `/check verify` runs these; `/test` locks the durable ones._

## UI / manual

- [x] Log in as a creator, open Submit Content, and select Final video with upload mode set to Paste Link → Platform Account Handle input appears pre filled from your profile for that platform, with an editable text field and an @ symbol indicator → AC-1
- [x] Paste a mobile share link (for example `https://vt.tiktok.com/ZSg4DrvG8/`) into Video Link and enter your matching handle `@irene_stiches_fashion`, then click Verify Video → the link unrolls, the provider author is matched, and a green confirmed preview appears displaying thumbnail, author handle, views, and likes → AC-1, AC-2, AC-3, AC-4, AC-5
- [x] Enter a handle that does not match the video author (for example `@different_user`) and click Verify Video → a clear error message indicates that the video was posted by another account and blocks submission → AC-4, AC-7
- [x] Submit a verified final video link → submission is created with verified views, timestamp, and source stamped by the service role, visible on My Submissions with verified view count badge → AC-5
- [x] Log in as an account manager and view the pending review queue → the final submission card displays the verified view count badge alongside the video preview link → AC-5
- [x] On a previously verified submission, click refresh or trigger manual sync → updated view counts are pulled from the provider and saved without decreasing existing views → AC-5, AC-6

## Commands

- [x] `node tests/single-video-verification.test.cjs` → runs offline unit test suite across handle normalization, provider normalizers, short link resolution, author matching, and error cases; exits 0 with all assertions passing → AC-2, AC-3, AC-4, AC-7
- [x] `npm run build` → production build compiles successfully with zero errors and zero warnings → AC-1, AC-5

## Acceptance-criteria coverage

- AC-1: covered by UI step 1 and UI step 2
- AC-2: covered by UI step 2 and command step 1
- AC-3: covered by UI step 2 and command step 1
- AC-4: covered by UI step 2, UI step 3, and command step 1
- AC-5: covered by UI step 2, UI step 4, UI step 5, and command step 2
- AC-6: covered by UI step 6
- AC-7: covered by UI step 3 and command step 1
