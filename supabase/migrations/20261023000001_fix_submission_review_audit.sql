-- ============================================================================
-- 20261023000001_fix_submission_review_audit.sql
--
-- Every UPDATE of public.submissions fails with
--
--     record "new" has no field "concept_status"
--
-- 20260823000000 created audit_submission_review(), an AFTER UPDATE trigger
-- that compares NEW/OLD.concept_status and NEW/OLD.final_status. Two days
-- later 20260826000000 replaced both columns with a single `status` and
-- dropped them. DROP COLUMN ... CASCADE does not touch PL/pgSQL bodies, and
-- PL/pgSQL only resolves a record field when the line runs, so nothing failed
-- at migration time; every later update did, including the review decision
-- (src/App.js writes `status`) and the stats save. Confirmed on the live
-- database 2026-10-23, where it also blocks apply_verified_views (spec 0002).
--
-- Fix: the same audit, keyed on `status`. One action, 'submission_review',
-- because concept and final review are now steps of one status column; the
-- submission_type goes into metadata so the two stay distinguishable.
-- The trigger itself is unchanged (same name, AFTER UPDATE, FOR EACH ROW).
--
-- Rollback: supabase/rollbacks/20261023000001_fix_submission_review_audit.rollback.sql
-- (it restores the broken body, so only use it with 20260826000000 undone).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_submission_review()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        PERFORM public.log_admin_action(
            'submission_review', 'submission', NEW.id, NULL,
            OLD.status, NEW.status, NEW.feedback,
            jsonb_build_object('creator_id', NEW.creator_id,
                               'campaign_id', NEW.campaign_id,
                               'submission_type', NEW.submission_type),
            NEW.reviewed_by
        );
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
