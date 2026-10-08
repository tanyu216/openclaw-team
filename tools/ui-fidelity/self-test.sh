#!/usr/bin/env bash
#
# ui-fidelity self-test: proves the checker detects conforming vs violating UIs.
# Runs inside the ui-fidelity container (see docker/ui-fidelity/Dockerfile).
#   - impl-ok  : conforming  → L1/L2/L3 all pass (exit 0)
#   - impl-bad : missing block + wrong tokens → must FAIL (exit 1)

set -euo pipefail
cd "$(dirname "$0")"
ROOT="$PWD"

rm -rf .tmp && mkdir -p .tmp

write_cfg() { # $1 = impl fixture file, $2 = config path
  cat > "$2" <<EOF
{
  "prototype": { "baseUrl": "file:", "paths": { "fixture": "$ROOT/fixtures/prototype.html" } },
  "impl": { "baseUrl": "file:", "paths": { "fixture": "$ROOT/fixtures/$1" } },
  "manifests": "$ROOT/manifests",
  "outDir": "$ROOT/.tmp/out",
  "baselineDir": "$ROOT/.tmp/baseline",
  "viewports": [1512, 760],
  "theme": "light",
  "locale": "en-US"
}
EOF
}

echo "== self-test: conforming implementation =="
write_cfg impl-ok.html .tmp/ok.json
node check.mjs --config .tmp/ok.json --update-baseline >/dev/null
node check.mjs --config .tmp/ok.json

echo
echo "== self-test: violating implementation (must fail) =="
write_cfg impl-bad.html .tmp/bad.json
if node check.mjs --config .tmp/bad.json --style-strict; then
  echo "ERROR: violating implementation unexpectedly passed"; exit 1
else
  echo "(expected failure observed)"
fi

echo
echo "== ui-fidelity self-test passed =="
