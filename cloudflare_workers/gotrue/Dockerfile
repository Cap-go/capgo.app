# Same GoTrue release as Supabase's hosted Auth for our project.
# The default command runs the migrations, then serves.
FROM supabase/gotrue:v2.197.0
# Supabase root CAs (2021 and 2025, from the Supabase CLI) for sslmode=verify-full.
COPY supabase-ca.crt /etc/ssl/certs/supabase-ca.crt
