#!/usr/bin/env bash
set -euo pipefail

CERT_DIR="certs"
mkdir -p "$CERT_DIR"

if [[ -f "$CERT_DIR/server.crt" && -f "$CERT_DIR/server.key" ]]; then
    echo "Certificates already exist in $CERT_DIR/"
    exit 0
fi

echo "Generating self-signed TLS certificate..."
openssl req -x509 -newkey rsa:2048 -nodes \
    -keyout "$CERT_DIR/server.key" \
    -out "$CERT_DIR/server.crt" \
    -days 365 \
    -subj "/CN=cadre/O=Local Development" \
    -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"

chmod 600 "$CERT_DIR/server.key"
echo "Certificates created in $CERT_DIR/"
