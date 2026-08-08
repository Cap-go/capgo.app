-- acknowledge_compatibility_event used to RETURN silently when the caller lacked
-- app_upload_bundle (and for unknown ids), so the dashboard showed a success
-- toast for a write that never happened. Raise instead, so the client surfaces
-- the failure. Both the unknown-id and the permission-denied branches raise the
-- SAME error on purpose: distinguishing them would turn this SECURITY DEFINER
-- RPC into an existence oracle for callers outside the org.

CREATE OR REPLACE FUNCTION "public"."acknowledge_compatibility_event"("event_id" bigint, "note" "text") RETURNS "void"
    LANGUAGE "plpgsql" SECURITY DEFINER
    SET "search_path" TO ''
    AS $$
DECLARE v_org uuid; v_app text;
BEGIN
  IF note IS NULL OR length(btrim(note)) = 0 THEN
    RAISE EXCEPTION 'reason_required';
  END IF;
  SELECT org_id, app_id INTO v_org, v_app
    FROM public.compatibility_events WHERE id = event_id;
  -- Unknown id: raise the same error as an RBAC denial (no existence oracle).
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'not_authorized';
  END IF;
  -- RBAC: app upload-bundle permission (release managers); NOT legacy min_rights.
  -- Adjust the perm key in review if a different role should be allowed to accept.
  IF NOT public.rbac_check_permission_direct(
        public.rbac_perm_app_upload_bundle(), auth.uid(), v_org, v_app, NULL::bigint) THEN
    RAISE EXCEPTION 'not_authorized';               -- unauthorized: surface, don't no-op
  END IF;
  UPDATE public.compatibility_events
    SET resolved_at = now(), resolved_by = auth.uid(),
        resolution_kind = 'accepted', resolution_note = note
    WHERE id = event_id AND resolved_at IS NULL;
END; $$;
