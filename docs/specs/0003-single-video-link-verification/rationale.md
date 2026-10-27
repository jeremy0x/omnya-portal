# 0003. Single video link verification: rationale

## Context

Omnya Portal manages creator content submissions for client campaigns across TikTok, Instagram, and YouTube. When creators complete a video for a campaign, they submit the live link as their Final submission. The portal needs to verify that the video is real, that it was actually posted by that creator, and fetch its verified views, likes, and comments for campaign analytics and bonus payments.

Connecting through platform OAuth is blocked or heavily delayed because TikTok, Meta, and Google limit unreviewed apps to named test accounts. Spec 0002 addressed this for TikTok by having creators add a code to their TikTok profile bio, followed by a background job that scraped their profile and their 30 latest videos.

While that worked as a bridge, it carries significant friction. Creators must alter their public social bios, wait hours for background cron runs, and spend unnecessary provider credits crawling dozens of unrelated profile videos. Furthermore, when creators copy video links from their mobile apps using the Share button, the links are mobile redirects (such as `vt.tiktok.com/ZSg4DrvG8/`, `instagram.com/share/...`, or `youtu.be/...`) that do not contain the username or full video ID in the raw link text.

The portal needs a fast, direct, and lightweight method to verify any submitted video link across TikTok, Instagram, and YouTube, unroll mobile share links, verify authorship against the creator handle, and pull verified stats for that single video immediately.

## Options considered

### Option 1: Single video link verification with author confirmation

The creator submits their account handle and the video link in the submission form. The server follows redirects to resolve short links, queries the ScrapeCreators single video endpoint (`/v2/tiktok/video`, `/v1/instagram/post`, `/v1/youtube/video`), verifies that the video author matches the entered handle, and stores verified views and engagement metrics directly on the submission.

**Pros**:
- Immediate feedback: creator sees thumbnail, title, and views in real time upon submit.
- Minimal credit cost: exactly one provider request per submission rather than continuous feed scraping.
- No bio modification: creators do not need to touch their profile bio or channel description.
- Universal: works identically for TikTok, Instagram Reels, and YouTube Shorts and videos.

**Cons**:
- Only tracks videos that creators explicitly submit, not unsolicited profile videos.

### Option 2: Full profile crawling and bio code verification (Spec 0002 pattern)

Creators paste a profile link, place an OMNYA verification code in their bio or channel description, and a cron job scrapes their whole profile and 30 latest videos every 6 hours.

**Pros**:
- Discovers all recent posts automatically without individual submissions.

**Cons**:
- Heavy credit consumption: costs multiple credits per creator every day.
- High creator friction: requires editing public bios and waiting for verification.
- Slower: newly submitted videos must wait for the next scheduled background cycle to sync.

### Option 3: Manual link entry with staff verification

Creators paste a link and type their view count, and account managers manually check links and type confirmed numbers into the portal.

**Pros**:
- Zero provider API costs.

**Cons**:
- High staff labor, slow turnaround, and prone to human error or inflated self reported numbers.

## Decision

**Chosen option**: Option 1: Single video link verification with author confirmation.

Build single video verification into the submission flow. Automatically unroll mobile short links, call the provider single video endpoint, confirm that the author returned by the provider matches the creator handle, and write verified views and metrics.

## Rationale

Option 1 provides the best combination of security, cost efficiency, and creator experience. ScrapeCreators provides dedicated single video endpoints for all three platforms that return the author username along with complete metrics (views, likes, comments, title, thumbnail, duration). Checking the author handle returned by the provider stops creators from submitting other people's viral videos. 

Unrolling mobile redirects server side ensures that links copied directly from phone apps work seamlessly. This replaces continuous profile crawling with a predictable, pay per use verification model.
