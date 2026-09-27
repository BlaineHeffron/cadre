#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${CADRE_APP_DIR:-${DUENO_APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}}"
CERT_DIR="${CADRE_CERT_DIR:-${DUENO_CERT_DIR:-$APP_DIR/certs}}"
SYSTEMD_SCOPE="${CADRE_SYSTEMD_SCOPE:-${DUENO_SYSTEMD_SCOPE:-system}}"
SERVICE_NAME="${CADRE_SERVICE_NAME:-${DUENO_SERVICE_NAME:-dueno-monitor}}"

echo "Checking certificate expiration..."

mkdir -p "$CERT_DIR"

# Check if cert expires within 30 days
if openssl x509 -checkend 2592000 -in "$CERT_DIR/server.crt" -noout 2>/dev/null; then
    echo "Certificate still valid for >30 days. No renewal needed."
    exit 0
fi

echo "Certificate expires soon. Regenerating..."

# Backup old certs
cp "$CERT_DIR/server.crt" "$CERT_DIR/server.crt.bak" 2>/dev/null || true
cp "$CERT_DIR/server.key" "$CERT_DIR/server.key.bak" 2>/dev/null || true

# Generate new self-signed cert
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/server.key" \
    -out "$CERT_DIR/server.crt" \
    -days 365 \
    -subj "/CN=cadre/O=Cadre" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERT_DIR/server.key"

if [[ "$SYSTEMD_SCOPE" != "user" ]] && id dueno &>/dev/null; then
    chown dueno:dueno "$CERT_DIR/server.crt" "$CERT_DIR/server.key"
fi

echo "Certificate renewed. Restarting service..."
if [[ "$SYSTEMD_SCOPE" == "user" ]]; then
    systemctl --user restart "$SERVICE_NAME"
else
    systemctl restart "$SERVICE_NAME"
fi

echo "Done."
