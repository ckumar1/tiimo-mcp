#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> typecheck"
npm run typecheck

echo "==> test"
npm test

echo "==> build"
npm run build

echo "==> all gates passed"
