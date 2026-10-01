-- Manifest objects that a deleted version's cleanup moved to the R2 trash
-- while a new upload started referencing them, and whose copy back failed.
-- While a row exists for a version, its manifest cleanup retries the restore
-- before releasing any manifest row, so the new reference cannot be dropped
-- with the object still in deleted-after-7-days/.
CREATE TABLE "public"."manifest_trash_restore_pending" (
    "s3_path" text NOT NULL,
    "app_version_id" bigint NOT NULL,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "manifest_trash_restore_pending_pkey" PRIMARY KEY ("app_version_id", "s3_path"),
    CONSTRAINT "manifest_trash_restore_pending_app_version_id_fkey"
        FOREIGN KEY ("app_version_id") REFERENCES "public"."app_versions" ("id") ON DELETE CASCADE
);

ALTER TABLE "public"."manifest_trash_restore_pending" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "public"."manifest_trash_restore_pending" FROM PUBLIC;
REVOKE ALL ON TABLE "public"."manifest_trash_restore_pending" FROM "anon";
REVOKE ALL ON TABLE "public"."manifest_trash_restore_pending" FROM "authenticated";
GRANT ALL ON TABLE "public"."manifest_trash_restore_pending" TO "service_role";

-- Backend connections, table owners, and service_role bypass RLS; PostgREST
-- callers must not access rows directly.
CREATE POLICY "Deny all direct access"
ON "public"."manifest_trash_restore_pending"
AS RESTRICTIVE
FOR ALL
TO PUBLIC
USING (false)
WITH CHECK (false);
