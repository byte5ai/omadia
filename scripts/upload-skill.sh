#!/usr/bin/env bash
# Packages the odoo-accounting skill as a zip and uploads it via `ant`.
# Prerequisite: `ant` CLI installed (https://docs.claude.com/cli), ANTHROPIC_API_KEY set.
set -euo pipefail

cd "$(dirname "$0")/.."

SKILL_DIR="skills/odoo-accounting"
ZIP_PATH="dist/odoo-accounting.zip"

mkdir -p dist
rm -f "$ZIP_PATH"

(cd skills && zip -r "../$ZIP_PATH" odoo-accounting \
  -x '*.DS_Store' '__MACOSX/*' '*/__MACOSX/*')

echo "--- Zip contents ---"
unzip -l "$ZIP_PATH"
echo "--------------------"

ant beta:skills create \
  --display-title "Odoo Accounting" \
  --file "$ZIP_PATH" \
  --beta skills-2025-10-02
