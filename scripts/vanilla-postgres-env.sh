# Local-only defaults for the vanilla Postgres compose service.
# Sourced by postgres:vanilla:* scripts so docker-compose.yml stays credential-free.
export VANILLA_POSTGRES_USER="${VANILLA_POSTGRES_USER:-postgres}"
export VANILLA_POSTGRES_PASSWORD="${VANILLA_POSTGRES_PASSWORD:-postgres}"
export VANILLA_POSTGRES_DB="${VANILLA_POSTGRES_DB:-capgo}"
