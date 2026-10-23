-- ============================================================================
-- ROLLBACK for 20261023000001_fix_submission_review_audit.sql
--
-- Manual only. Never move this file into supabase/migrations/.
--
-- Restores the 20260823000000 body, which reads concept_status and
-- final_status. With 20260826000000 applied (those columns dropped) this
-- breaks every UPDATE of submissions again, so only run it after undoing
-- 20260826000000.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_submission_review()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
    IF NEW.concept_status IS DISTINCT FROM OLD.concept_status THEN
        PERFORM public.log_admin_action(
            'concept_review', 'submission', NEW.id, NULL,
            OLD.concept_status, NEW.concept_status, NEW.feedback,
            jsonb_build_object('creator_id', NEW.creator_id,
                               'campaign_id', NEW.campaign_id),
            NEW.reviewed_by
        );
    END IF;

    IF NEW.final_status IS DISTINCT FROM OLD.final_status THEN
        PERFORM public.log_admin_action(
            'final_review', 'submission', NEW.id, NULL,
            OLD.final_status, NEW.final_status, NEW.feedback,
            jsonb_build_object('creator_id', NEW.creator_id,
                               'campaign_id', NEW.campaign_id),
            NEW.reviewed_by
        );
    END IF;

    RETURN NEW;
END;
$$;

COMMIT;
