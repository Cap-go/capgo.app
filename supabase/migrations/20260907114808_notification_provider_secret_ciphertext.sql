ALTER TABLE "public"."notification_provider_configs"
  ADD COLUMN IF NOT EXISTS "secret_ciphertext" "text";

COMMENT ON COLUMN "public"."notification_provider_configs"."secret_ciphertext" IS 'AES-GCM encrypted push credential material for hosted Capgo. Null when using worker env secret_ref (self-host).';
