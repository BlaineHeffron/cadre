#!/usr/bin/env bash
set -euo pipefail

upsert_env() {
    local key="$1" value="$2"
    if grep -q "^${key}=" .env; then
        sed -i "s/^${key}=.*/${key}=$value/" .env
    else
        echo "${key}=$value" >> .env
    fi
}

AUTH_TOKEN=$(openssl rand -hex 32)
INTERNAL_BYPASS_TOKEN=$(openssl rand -hex 32)
BROWSER_SESSION_SECRET=$(openssl rand -hex 32)

if [[ ! -f .env ]]; then
    cp .env.example .env
fi

upsert_env AUTH_TOKEN "$AUTH_TOKEN"
upsert_env INTERNAL_BYPASS_TOKEN "$INTERNAL_BYPASS_TOKEN"
upsert_env BROWSER_SESSION_SECRET "$BROWSER_SESSION_SECRET"

echo "Generated AUTH_TOKEN, INTERNAL_BYPASS_TOKEN, and BROWSER_SESSION_SECRET"
echo "Written to .env"
