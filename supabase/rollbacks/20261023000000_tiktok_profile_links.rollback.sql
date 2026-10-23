-- ============================================================================
-- ROLLBACK for 20261023000000_tiktok_profile_links.sql  (spec 0002)
--
-- Manual only. Never move this file into supabase/migrations/: `.rollback.sql`
-- sorts before `.sql`, so `db push` would run it first (see supabase/AGENTS.md).
--
-- Before running it:
--   * unset TIKTOK_VERIFIED_BONUS_ONLY and redeploy, so recalculate stops
--     reading view_count_verified_at;
--   * remove the /api/cron/sync-tiktok-links and /api/cron/thin-video-metrics
--     entries from vercel.json, so nothing writes the dropped columns.
--
-- What it loses: every link handle and its verification state, follower
-- snapshots, and the verified_at / source stamps on submissions. The verified
-- view counts themselves stay in submissions.view_count_verified (that column
-- predates this migration). creator_videos rows fetched through a link stay,
-- with their `source` column gone.
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS trg_guard_link_verification ON public.creator_social_accounts;
DROP TRIGGER IF EXISTS trg_guard_link_verification ON public.submissions;
DROP TRIGGER IF EXISTS trg_guard_link_verification ON public.creator_videos;
DROP FUNCTION IF EXISTS public.guard_link_verification_columns();

DROP FUNCTION IF EXISTS public.apply_verified_views(UUID, BIGINT, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.thin_video_metrics(INTEGER);

DROP TABLE IF EXISTS public.social_profile_snapshots;

-- The safe view references the link columns, so it goes back to the
-- 20260604000000 shape before they are dropped. CREATE OR REPLACE cannot drop
-- columns, so this one is a DROP and CREATE, and its grant is restored below.
DROP VIEW IF EXISTS public.creator_social_accounts_safe;
CREATE VIEW public.creator_social_accounts_safe
WITH (security_invoker = true)
AS
SELECT
    csa.id, csa.user_id, csa.creator_id, csa.workspace_id, csa.platform,
    csa.platform_user_id, csa.username, csa.display_name, csa.profile_image_url,
    csa.token_expires_at, csa.refresh_token_expires_at, csa.scopes,
    csa.connection_status, csa.last_synced_at, csa.last_error, csa.metadata,
    csa.created_at, csa.updated_at
FROM public.creator_social_accounts csa;
GRANT SELECT ON public.creator_social_accounts_safe TO authenticated;

DROP INDEX IF EXISTS public.creator_social_accounts_verified_handle_key;
DROP INDEX IF EXISTS public.idx_creator_social_accounts_link_queue;

ALTER TABLE public.creator_social_accounts
    DROP CONSTRAINT IF EXISTS creator_social_accounts_link_status_check,
    DROP CONSTRAINT IF EXISTS creator_social_accounts_link_health_check,
    DROP CONSTRAINT IF EXISTS creator_social_accounts_link_handle_check,
    DROP CONSTRAINT IF EXISTS creator_social_accounts_link_handle_status_check,
    DROP CONSTRAINT IF EXISTS creator_social_accounts_link_rejected_reason_check,
    DROP CONSTRAINT IF EXISTS creator_social_accounts_link_verified_by_fkey,
    DROP COLUMN IF EXISTS link_handle,
    DROP COLUMN IF EXISTS link_status,
    DROP COLUMN IF EXISTS link_code,
    DROP COLUMN IF EXISTS link_code_expires_at,
    DROP COLUMN IF EXISTS link_code_found_at,
    DROP COLUMN IF EXISTS link_verified_at,
    DROP COLUMN IF EXISTS link_verified_by,
    DROP COLUMN IF EXISTS link_rejected_reason,
    DROP COLUMN IF EXISTS link_health,
    DROP COLUMN IF EXISTS link_failure_count,
    DROP COLUMN IF EXISTS link_last_error,
    DROP COLUMN IF EXISTS link_last_fetched_at,
    DROP COLUMN IF EXISTS follower_count;

ALTER TABLE public.creator_videos
    DROP CONSTRAINT IF EXISTS creator_videos_source_check,
    DROP COLUMN IF EXISTS source,
    DROP COLUMN IF EXISTS author_handle;

ALTER TABLE public.submissions
    DROP CONSTRAINT IF EXISTS submissions_verified_views_source_check,
    DROP COLUMN IF EXISTS view_count_verified_at,
    DROP COLUMN IF EXISTS verified_views_source;

COMMIT;
