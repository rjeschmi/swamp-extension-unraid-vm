#!/bin/bash
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

# Install swamp
curl -fsSL https://swamp.club/install.sh | sh

# Deno (used by swamp extension models) doesn't trust the TLS inspection proxy.
# Tell it to use the system cert store, which does trust it.
echo 'export DENO_TLS_CA_STORE=system' >> "$CLAUDE_ENV_FILE"
