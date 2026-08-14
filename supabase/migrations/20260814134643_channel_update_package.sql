CREATE TYPE "public"."channel_update_package" AS ENUM (
    'all',
    'zip',
    'delta',
    'zip_from_builtin',
    'delta_from_builtin'
);

ALTER TYPE "public"."channel_update_package" OWNER TO "postgres";

ALTER TABLE "public"."channels"
ADD COLUMN "update_package" "public"."channel_update_package" DEFAULT 'all'::"public"."channel_update_package" NOT NULL;

COMMENT ON COLUMN "public"."channels"."update_package" IS
  'How /updates serves the channel bundle: all (zip+delta), zip, delta, or zip/delta only when the device is still on the store builtin version.';
