#!/bin/bash

# This script is NOT memory safe
# It's NOT supposed to be used in production!!!

# Function to exit with error message
error_exit() {
    echo "$1" >&2
    exit 1
}

# Check if the file exists
ENV_FILE="./internal/cloudflare/.env.local"
[ ! -f "$ENV_FILE" ] && error_exit "File not found: $ENV_FILE"

# Prepare the base arguments (compat date: see scripts/wrangler-dev-compat.sh)
COMPAT_DATE="${WRANGLER_DEV_COMPATIBILITY_DATE:-$(date -u +%Y-%m-%d)}"
ARGS=("bunx" "wrangler" "dev" "--compatibility-date" "${COMPAT_DATE}" "--port" "7777")

# Read the file line by line
while IFS= read -r line || [ -n "$line" ]; do
    # Skip empty lines and lines starting with #
    [[ -z "$line" || "$line" =~ ^# ]] && continue
    
    # Split the line into key and value
    IFS='=' read -r key value <<< "$line"
    
    # Trim whitespace
    key=$(echo "$key" | xargs)
    value=$(echo "$value" | xargs)
    
    # Add to arguments if both key and value exist
    if [[ -n "$key" && -n "$value" ]]; then
        ARGS+=("--var" "${key}:${value}")
    fi
done < "$ENV_FILE"

# Uncomment to print the arguments
# echo "${ARGS[@]}"

# Execute the command
"${ARGS[@]}" || error_exit "Oh no, something went wrong with execution! $?"
