-- ============================================================================
-- 20261023000000_tiktok_profile_links.sql
--
-- Spec 0002: TikTok profile link tracking.
--
-- A creator pastes their TikTok profile link instead of going through OAuth.
-- The portal hands them a code for their bio, a job sees the code, their
-- manager verifies, and from then on a cron pulls their public videos through
-- ScrapeCreators and writes verified views onto matching Final submissions.
--
-- This file is the whole data model for the feature (spec 0002, build task 2):
--
--   1. creator_social_accounts   link_* columns, follower_count, CHECKs, FK,
--                                one verified owner per handle (partial UNIQUE)
--   2. creator_videos            source ('oauth' | 'link'), author_handle
--   3. submissions               view_count_verified_at, verified_views_source
--   4. social_profile_snapshots  new: one follower snapshot per account per day
--   5. apply_verified_views()    the only writer of verified views
--   6. thin_video_metrics()      90 day retention for video_metrics (AC-18)
--   7. guard trigger             browsers cannot set verification state (AC-17)
--   8. grants and the safe view  so the creator card can read its own row
--
-- Additive only: every column is nullable or has a default, nothing existing
-- is dropped or rewritten. Safe to run twice (the PGlite suite does).
--
-- Rollback: supabase/rollbacks/20261023000000_tiktok_profile_links.rollback.sql
-- ============================================================================

BEGIN;


-- ============================================================================
-- SECTION 1 — creator_social_accounts: the link state
--
-- link_status and connection_status are separate on purpose. connection_status
-- keeps describing OAuth only, so the token refresh sweep, needsReauth() and
-- the existing card logic are untouched by a creator who never did OAuth.
-- ============================================================================

ALTER TABLE public.creator_social_accounts
    ADD COLUMN IF NOT EXISTS link_handle          TEXT,
    ADD COLUMN IF NOT EXISTS link_status          TEXT,
    ADD COLUMN IF NOT EXISTS link_code            TEXT,
    ADD COLUMN IF NOT EXISTS link_code_expires_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS link_code_found_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS link_verified_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS link_verified_by     UUID,
    ADD COLUMN IF NOT EXISTS link_rejected_reason TEXT,
    ADD COLUMN IF NOT EXISTS link_health          TEXT    NOT NULL DEFAULT 'ok',
    ADD COLUMN IF NOT EXISTS link_failure_count   INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS link_last_error      TEXT,
    ADD COLUMN IF NOT EXISTS link_last_fetched_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS follower_count       BIGINT;

COMMENT ON COLUMN public.creator_social_accounts.link_status IS
    'TikTok profile link state (spec 0002): pending_code -> code_found -> '
    'verified, or rejected. NULL when the creator has no link. Written only by '
    'api/tiktok-link/* and the link cron with the service role.';

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'creator_social_accounts_link_status_check'
                     AND conrelid = 'public.creator_social_accounts'::regclass) THEN
        ALTER TABLE public.creator_social_accounts
            ADD CONSTRAINT creator_social_accounts_link_status_check
            CHECK (link_status IS NULL
                   OR link_status IN ('pending_code','code_found','verified','rejected'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'creator_social_accounts_link_health_check'
                     AND conrelid = 'public.creator_social_accounts'::regclass) THEN
        ALTER TABLE public.creator_social_accounts
            ADD CONSTRAINT creator_social_accounts_link_health_check
            CHECK (link_health IN ('ok','needs_attention'));
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'creator_social_accounts_link_handle_check'
                     AND conrelid = 'public.creator_social_accounts'::regclass) THEN
        ALTER TABLE public.creator_social_accounts
            ADD CONSTRAINT creator_social_accounts_link_handle_check
            CHECK (link_handle IS NULL OR link_handle ~ '^[a-z0-9._]{2,24}$');
    END IF;

    -- A status with no handle would be a verified nobody.
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'creator_social_accounts_link_handle_status_check'
                     AND conrelid = 'public.creator_social_accounts'::regclass) THEN
        ALTER TABLE public.creator_social_accounts
            ADD CONSTRAINT creator_social_accounts_link_handle_status_check
            CHECK (link_handle IS NOT NULL OR link_status IS NULL);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'creator_social_accounts_link_rejected_reason_check'
                     AND conrelid = 'public.creator_social_accounts'::regclass) THEN
        ALTER TABLE public.creator_social_accounts
            ADD CONSTRAINT creator_social_accounts_link_rejected_reason_check
            CHECK (link_rejected_reason IS NULL OR char_length(link_rejected_reason) <= 500);
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'creator_social_accounts_link_verified_by_fkey'
                     AND conrelid = 'public.creator_social_accounts'::regclass) THEN
        ALTER TABLE public.creator_social_accounts
            ADD CONSTRAINT creator_social_accounts_link_verified_by_fkey
            FOREIGN KEY (link_verified_by) REFERENCES auth.users(id) ON DELETE SET NULL;
    END IF;
END
$$;

-- One verified owner per handle, case insensitive (AC-2, AC-5). Verify relies
-- on this to lose a race cleanly: the second verify gets 23505, which the
-- route maps to 409 handle_claimed.
CREATE UNIQUE INDEX IF NOT EXISTS creator_social_accounts_verified_handle_key
    ON public.creator_social_accounts (lower(link_handle))
    WHERE link_status = 'verified';

-- The cron's two scans: unexpired pending codes, and verified rows oldest
-- fetch first (AC-13).
CREATE INDEX IF NOT EXISTS idx_creator_social_accounts_link_queue
    ON public.creator_social_accounts (link_status, link_last_fetched_at)
    WHERE platform = 'tiktok';


-- ============================================================================
-- SECTION 2 — creator_videos: where a row came from
--
-- The upsert key (user_id, platform, platform_video_id) is shared with the
-- OAuth sync, so the last writer sets `source`. A usable OAuth token stops the
-- link job writing that creator's videos at all (AC-9), so the two never
-- alternate on one row.
-- ============================================================================

ALTER TABLE public.creator_videos
    ADD COLUMN IF NOT EXISTS source        TEXT NOT NULL DEFAULT 'oauth',
    ADD COLUMN IF NOT EXISTS author_handle TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'creator_videos_source_check'
                     AND conrelid = 'public.creator_videos'::regclass) THEN
        ALTER TABLE public.creator_videos
            ADD CONSTRAINT creator_videos_source_check
            CHECK (source IN ('oauth','link'));
    END IF;
END
$$;

-- video_metrics needs (video_id, snapshot_at) for thin_video_metrics();
-- 20260604000000 already created it as idx_video_metrics_video_snapshot, so
-- this is a no-op wherever that migration ran.
CREATE INDEX IF NOT EXISTS idx_video_metrics_video_snapshot
    ON public.video_metrics (video_id, snapshot_at DESC);


-- ============================================================================
-- SECTION 3 — submissions: when and how views were verified
--
-- view_count_verified already exists (20260530000000, INTEGER DEFAULT 0) and
-- had no writer until now. Its default of 0 cannot tell "never verified" from
-- "verified at zero views", so view_count_verified_at is what the bonus hold
-- reads (AC-10).
-- ============================================================================

ALTER TABLE public.submissions
    ADD COLUMN IF NOT EXISTS view_count_verified_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS verified_views_source  TEXT;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conname = 'submissions_verified_views_source_check'
                     AND conrelid = 'public.submissions'::regclass) THEN
        ALTER TABLE public.submissions
            ADD CONSTRAINT submissions_verified_views_source_check
            CHECK (verified_views_source IS NULL OR verified_views_source IN ('oauth','link'));
    END IF;
END
$$;


-- ============================================================================
-- SECTION 4 — social_profile_snapshots
--
-- One follower count per account per UTC day, upserted by the link cron. The
-- read policies are the same three shapes as creator_videos; nobody but the
-- service role writes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.social_profile_snapshots (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    social_account_id  UUID        NOT NULL
                       REFERENCES public.creator_social_accounts(id) ON DELETE CASCADE,
    user_id            UUID        NOT NULL,
    snapshot_date      DATE        NOT NULL,
    follower_count     BIGINT      NOT NULL,
    video_count        INTEGER,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT social_profile_snapshots_account_day_key UNIQUE (social_account_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_social_profile_snapshots_user_id
    ON public.social_profile_snapshots (user_id);

ALTER TABLE public.social_profile_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS social_profile_snapshots_select_self     ON public.social_profile_snapshots;
DROP POLICY IF EXISTS social_profile_snapshots_select_owner_pm ON public.social_profile_snapshots;
DROP POLICY IF EXISTS social_profile_snapshots_select_am       ON public.social_profile_snapshots;

CREATE POLICY social_profile_snapshots_select_self ON public.social_profile_snapshots
    FOR SELECT TO authenticated
    USING (user_id = auth.uid());

CREATE POLICY social_profile_snapshots_select_owner_pm ON public.social_profile_snapshots
    FOR SELECT TO authenticated
    USING (
        public.current_user_role() = 'owner'
        OR public.is_payment_manager('can_view_payouts')
    );

CREATE POLICY social_profile_snapshots_select_am ON public.social_profile_snapshots
    FOR SELECT TO authenticated
    USING (
        public.current_user_role() = 'am'
        AND EXISTS (
            SELECT 1
            FROM   public.creators c
            JOIN   public.account_managers am ON am.id = c.am_id
            WHERE  am.user_id = auth.uid()
              AND  c.user_id  = social_profile_snapshots.user_id
        )
    );

REVOKE ALL ON public.social_profile_snapshots FROM anon;
REVOKE ALL ON public.social_profile_snapshots FROM authenticated;
GRANT SELECT ON public.social_profile_snapshots TO authenticated;
GRANT ALL    ON public.social_profile_snapshots TO service_role;


-- ============================================================================
-- SECTION 5 — apply_verified_views()
--
-- The single writer of submissions.view_count_verified. Three rules live here
-- rather than in the cron, so a second caller (the OAuth sync, AC-9) cannot
-- get them wrong:
--
--   * GREATEST: a racing cron and manual sync, or a provider that briefly
--     reports 0, can never lower a verified count.
--   * the submission must belong to p_user_id.
--   * for 'link', the creator's tiktok row must STILL be verified with the
--     handle that was fetched. A handle change, removal or reject during the
--     run makes this a no-op (returns false, counted as stale_skip).
--
-- view_count_verified is INTEGER, so the value is clamped rather than letting
-- one viral outlier abort the whole run with an overflow.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.apply_verified_views(
    p_submission_id UUID,
    p_views         BIGINT,
    p_source        TEXT,
    p_user_id       UUID,
    p_handle        TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_source IS NULL OR p_source NOT IN ('oauth','link') THEN
        RAISE EXCEPTION 'apply_verified_views: source must be oauth or link, got %', p_source
            USING ERRCODE = '22023';
    END IF;
    IF p_views IS NULL OR p_views < 0 THEN
        RAISE EXCEPTION 'apply_verified_views: views must be a non negative number'
            USING ERRCODE = '22023';
    END IF;

    UPDATE public.submissions s
       SET view_count_verified    = GREATEST(COALESCE(s.view_count_verified, 0),
                                             LEAST(p_views, 2147483647))::INTEGER,
           view_count_verified_at = now(),
           verified_views_source  = p_source
     WHERE s.id = p_submission_id
       AND EXISTS (SELECT 1 FROM public.creators c
                   WHERE c.id = s.creator_id AND c.user_id = p_user_id)
       AND (
            p_source = 'oauth'
            OR EXISTS (
                SELECT 1 FROM public.creator_social_accounts a
                WHERE a.user_id     = p_user_id
                  AND a.platform    = 'tiktok'
                  AND a.link_status = 'verified'
                  AND a.link_handle = p_handle
            )
       )
    RETURNING s.id INTO v_id;

    RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_verified_views(UUID, BIGINT, TEXT, UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_verified_views(UUID, BIGINT, TEXT, UUID, TEXT)
    TO service_role;


-- ============================================================================
-- SECTION 6 — thin_video_metrics()  (AC-18)
--
-- The link cron appends a video_metrics row per video every 6 hours (about
-- 12k rows a day at 100 creators). Past p_keep_days, keep only the newest
-- snapshot per (video, UTC day). Returns how many rows it deleted.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.thin_video_metrics(p_keep_days INTEGER)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_deleted BIGINT;
BEGIN
    IF p_keep_days IS NULL OR p_keep_days < 1 THEN
        RAISE EXCEPTION 'thin_video_metrics: keep_days must be at least 1' USING ERRCODE = '22023';
    END IF;

    WITH ranked AS (
        SELECT id,
               row_number() OVER (
                   PARTITION BY video_id, (snapshot_at AT TIME ZONE 'UTC')::date
                   ORDER BY snapshot_at DESC, id DESC
               ) AS rn
        FROM   public.video_metrics
        WHERE  snapshot_at < now() - make_interval(days => p_keep_days)
    ),
    gone AS (
        DELETE FROM public.video_metrics v
        USING  ranked r
        WHERE  v.id = r.id AND r.rn > 1
        RETURNING 1
    )
    SELECT count(*) INTO v_deleted FROM gone;

    RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.thin_video_metrics(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.thin_video_metrics(INTEGER) TO service_role;


-- ============================================================================
-- SECTION 7 — guard_link_verification_columns()  (AC-17)
--
-- The existing *_insert_self / *_update_self policies, and the table level
-- INSERT/UPDATE grants from 20260604000000, already let a creator write their
-- own creator_social_accounts row and their own submissions. Column grants
-- would mean revoking and re-granting every other column; a trigger is one
-- place, and easy to test.
--
-- It fires for a browser caller: current_user is authenticated or anon (what
-- PostgREST sets), or the JWT says so (same lookup as Supabase's auth.role()).
-- The service role, migrations and psql pass. Rejection is SQLSTATE 42501.
--
-- The column list is the spec's AC-17 list plus link_code_expires_at,
-- link_last_error and link_last_fetched_at: nothing in the browser writes
-- those either, and a creator who could push link_code_expires_at forward
-- could keep an expired code alive.
--
-- creator_videos: a browser can still write its own 'oauth' rows as before,
-- but never a 'link' row, the data verified views are built from.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_link_verification_columns()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_claims TEXT := nullif(current_setting('request.jwt.claims', true), '');
    v_role   TEXT := coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                              CASE WHEN v_claims IS NULL THEN NULL
                                   ELSE v_claims::jsonb ->> 'role' END);
    v_bad    TEXT;
BEGIN
    IF current_user::text NOT IN ('authenticated','anon')
       AND coalesce(v_role, '') NOT IN ('authenticated','anon') THEN
        RETURN NEW;
    END IF;

    IF TG_TABLE_NAME = 'creator_social_accounts' THEN
        IF TG_OP = 'INSERT' THEN
            v_bad := CASE
                WHEN NEW.link_handle          IS NOT NULL THEN 'link_handle'
                WHEN NEW.link_status          IS NOT NULL THEN 'link_status'
                WHEN NEW.link_code            IS NOT NULL THEN 'link_code'
                WHEN NEW.link_code_expires_at IS NOT NULL THEN 'link_code_expires_at'
                WHEN NEW.link_code_found_at   IS NOT NULL THEN 'link_code_found_at'
                WHEN NEW.link_verified_at     IS NOT NULL THEN 'link_verified_at'
                WHEN NEW.link_verified_by     IS NOT NULL THEN 'link_verified_by'
                WHEN NEW.link_rejected_reason IS NOT NULL THEN 'link_rejected_reason'
                WHEN NEW.link_health  IS DISTINCT FROM 'ok' THEN 'link_health'
                WHEN NEW.link_failure_count IS DISTINCT FROM 0 THEN 'link_failure_count'
                WHEN NEW.link_last_error      IS NOT NULL THEN 'link_last_error'
                WHEN NEW.link_last_fetched_at IS NOT NULL THEN 'link_last_fetched_at'
                WHEN NEW.follower_count       IS NOT NULL THEN 'follower_count'
            END;
        ELSE
            v_bad := CASE
                WHEN NEW.link_handle          IS DISTINCT FROM OLD.link_handle          THEN 'link_handle'
                WHEN NEW.link_status          IS DISTINCT FROM OLD.link_status          THEN 'link_status'
                WHEN NEW.link_code            IS DISTINCT FROM OLD.link_code            THEN 'link_code'
                WHEN NEW.link_code_expires_at IS DISTINCT FROM OLD.link_code_expires_at THEN 'link_code_expires_at'
                WHEN NEW.link_code_found_at   IS DISTINCT FROM OLD.link_code_found_at   THEN 'link_code_found_at'
                WHEN NEW.link_verified_at     IS DISTINCT FROM OLD.link_verified_at     THEN 'link_verified_at'
                WHEN NEW.link_verified_by     IS DISTINCT FROM OLD.link_verified_by     THEN 'link_verified_by'
                WHEN NEW.link_rejected_reason IS DISTINCT FROM OLD.link_rejected_reason THEN 'link_rejected_reason'
                WHEN NEW.link_health          IS DISTINCT FROM OLD.link_health          THEN 'link_health'
                WHEN NEW.link_failure_count   IS DISTINCT FROM OLD.link_failure_count   THEN 'link_failure_count'
                WHEN NEW.link_last_error      IS DISTINCT FROM OLD.link_last_error      THEN 'link_last_error'
                WHEN NEW.link_last_fetched_at IS DISTINCT FROM OLD.link_last_fetched_at THEN 'link_last_fetched_at'
                WHEN NEW.follower_count       IS DISTINCT FROM OLD.follower_count       THEN 'follower_count'
            END;
        END IF;

    ELSIF TG_TABLE_NAME = 'submissions' THEN
        IF TG_OP = 'INSERT' THEN
            v_bad := CASE
                WHEN coalesce(NEW.view_count_verified, 0) <> 0 THEN 'view_count_verified'
                WHEN NEW.view_count_verified_at IS NOT NULL   THEN 'view_count_verified_at'
                WHEN NEW.verified_views_source  IS NOT NULL   THEN 'verified_views_source'
            END;
        ELSE
            v_bad := CASE
                WHEN NEW.view_count_verified    IS DISTINCT FROM OLD.view_count_verified    THEN 'view_count_verified'
                WHEN NEW.view_count_verified_at IS DISTINCT FROM OLD.view_count_verified_at THEN 'view_count_verified_at'
                WHEN NEW.verified_views_source  IS DISTINCT FROM OLD.verified_views_source  THEN 'verified_views_source'
            END;
        END IF;

    ELSIF TG_TABLE_NAME = 'creator_videos' THEN
        IF NEW.source = 'link' OR (TG_OP = 'UPDATE' AND OLD.source = 'link') THEN
            v_bad := 'source';
        END IF;
    END IF;

    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'Only the server can set %.% (spec 0002, AC-17)', TG_TABLE_NAME, v_bad
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_link_verification ON public.creator_social_accounts;
CREATE TRIGGER trg_guard_link_verification
    BEFORE INSERT OR UPDATE ON public.creator_social_accounts
    FOR EACH ROW EXECUTE FUNCTION public.guard_link_verification_columns();

DROP TRIGGER IF EXISTS trg_guard_link_verification ON public.submissions;
CREATE TRIGGER trg_guard_link_verification
    BEFORE INSERT OR UPDATE ON public.submissions
    FOR EACH ROW EXECUTE FUNCTION public.guard_link_verification_columns();

DROP TRIGGER IF EXISTS trg_guard_link_verification ON public.creator_videos;
CREATE TRIGGER trg_guard_link_verification
    BEFORE INSERT OR UPDATE ON public.creator_videos
    FOR EACH ROW EXECUTE FUNCTION public.guard_link_verification_columns();


-- ============================================================================
-- SECTION 8 — column grants and the safe view
--
-- 20260604000000 revoked table level SELECT on creator_social_accounts from
-- authenticated and granted the columns back one by one. New columns are
-- therefore invisible to the browser until granted here, and the security
-- invoker safe view would fail with "permission denied" without this.
--
-- The view is extended with CREATE OR REPLACE, appending after the existing
-- columns. Never DROP it: that drops its grants and anything built on it.
-- link_code is included on purpose: only the creator, their AM and owners can
-- read the row under RLS, and the code is public the moment it is in a bio.
-- ============================================================================

GRANT SELECT (
    link_handle, link_status, link_code, link_code_expires_at, link_code_found_at,
    link_verified_at, link_verified_by, link_rejected_reason, link_health,
    link_failure_count, link_last_error, link_last_fetched_at, follower_count
) ON public.creator_social_accounts TO authenticated;

CREATE OR REPLACE VIEW public.creator_social_accounts_safe
WITH (security_invoker = true)
AS
SELECT
    csa.id,
    csa.user_id,
    csa.creator_id,
    csa.workspace_id,
    csa.platform,
    csa.platform_user_id,
    csa.username,
    csa.display_name,
    csa.profile_image_url,
    csa.token_expires_at,
    csa.refresh_token_expires_at,
    csa.scopes,
    csa.connection_status,
    csa.last_synced_at,
    csa.last_error,
    csa.metadata,
    csa.created_at,
    csa.updated_at,
    csa.link_handle,
    csa.link_status,
    csa.link_code,
    csa.link_code_expires_at,
    csa.link_code_found_at,
    csa.link_verified_at,
    csa.link_verified_by,
    csa.link_rejected_reason,
    csa.link_health,
    csa.link_failure_count,
    csa.link_last_error,
    csa.link_last_fetched_at,
    csa.follower_count
FROM public.creator_social_accounts csa;

GRANT SELECT ON public.creator_social_accounts_safe TO authenticated;

COMMIT;
