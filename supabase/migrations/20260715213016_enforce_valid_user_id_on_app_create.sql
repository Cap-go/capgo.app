CREATE OR REPLACE TRIGGER "force_valid_user_id_on_app"
BEFORE INSERT ON "public"."apps"
FOR EACH ROW
EXECUTE FUNCTION "public"."force_valid_user_id_on_app"();
