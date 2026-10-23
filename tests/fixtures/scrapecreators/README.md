# ScrapeCreators fixtures (spec 0002, build task 1)

Offline stand ins for the four provider calls `api/_utils/tiktokPublic.js` makes.

**Provenance: documented examples, not recorded responses.** No
`SCRAPECREATORS_API_KEY` was available when these were written (2026-10-23), so
each file is the `200` example from the endpoint's own OpenAPI spec
(`https://docs.scrapecreators.com/<path>/openapi.json`), trimmed to the fields
the adapter reads, with the real creator swapped for `some.creator`. Replace
them with one real, trimmed response of each once a key exists (spec 0002 task
1 stays open until then).

| File | Endpoint | Notes |
|---|---|---|
| `profile.json` | `GET /v1/tiktok/profile?handle=` | bio (`user.signature`) carries the code `OMNYA-7K3QZD` |
| `profile_private.json` | same | `user.privateAccount: true`, the documented private flag |
| `videos.json` | `GET /v3/tiktok/profile/videos?handle=` | `aweme_list[]`, paged by `max_cursor` |
| `video.json` | `GET /v2/tiktok/video?url=` | `aweme_detail`, a video by a different author (mismatch case) |
| `credit_balance.json` | `GET /v1/account/credit-balance` | the spec names `/v1/credit/balance`; the docs path is this one |

Confirmed from the docs: both the video list and the single video endpoint
return `author.unique_id` (the handle), not only the display name, so the AC-8
author check works on either source.

Not documented, so assumed until a real recording: how "not found" and
"banned" profiles are reported. The adapter treats HTTP 404, and a 2xx or 400
whose body says the user does not exist, as `not_found`.
