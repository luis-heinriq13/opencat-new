#!/bin/sh
# Prepara resources/whatscat para a build. WHATSCAT_BIN_DIR tem os binarios ja compilados (macOS arm64).
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
bins=${WHATSCAT_BIN_DIR:-"$HOME/OpenBot/Agents/agent-420b547f-14a8-4c2f-a0b9-022a70e61755/whatscat-bin"}
out="$root/resources/whatscat"
rm -rf "$out"
mkdir -p "$out/bin"
cd "$root"
bun build tools/whatscat/whatscat-mcp.mjs --target=node --format=esm --outfile="$out/whatscat-mcp.mjs" >/dev/null
bun build tools/whatscat/whatsapp-oficial-mcp.mjs --target=node --format=esm --outfile="$out/whatsapp-oficial-mcp.mjs" >/dev/null
cp tools/whatscat/whatscat-panel.html "$out/"
cp "$bins/localwhatsappmcp" "$bins/wacli" "$out/bin/"
chmod 755 "$out/bin/localwhatsappmcp" "$out/bin/wacli"
