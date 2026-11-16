#!/usr/bin/env bash
# Packs the already-built @nicia-ai/typegraph, installs the tarball with its
# optional peers into an empty sandbox, and runs scripts/smoke-exports.mjs
# there: every public subpath through ESM and CJS, plus the cross-entrypoint
# identity checks. CI runs it on every pull request (after the build) and the
# release workflow runs it before publishing, so a packaging break fails a PR
# instead of a release.
#
# Usage, from anywhere in the repository, after `pnpm --filter
# @nicia-ai/typegraph build`:
#   bash packages/typegraph/scripts/smoke-packed-tarball.sh [work-directory]
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
work_directory="${1:-$(mktemp -d)}"
mkdir -p "$work_directory"
cd "$repository_root"

PACK_OUTPUT="$(pnpm --filter @nicia-ai/typegraph pack --json --pack-destination "$work_directory")"
TARBALL_PATH="$(echo "$PACK_OUTPUT" | node -e 'const fs = require("node:fs"); const input = fs.readFileSync(0, "utf8"); const data = JSON.parse(input); const filename = Array.isArray(data) ? data[0]?.filename : data?.filename; if (!filename) process.exit(1); process.stdout.write(filename);')"
# Adapter subpaths load Drizzle and a database driver at import time. Pin
# those optional peers to the exact ranges the repo validates against —
# PGlite's is tight (>=0.5.0 <0.6.0) — so the smoke can import every public
# subpath, not just the driver-agnostic ones.
OPTIONAL_PEER_SPECS="$(node -e 'const dev = require("./packages/typegraph/package.json").devDependencies; const names = ["drizzle-orm", "better-sqlite3", "@libsql/client", "@electric-sql/pglite"]; process.stdout.write(names.map((name) => `${name}@${dev[name]}`).join(" "));')"

mkdir -p "$work_directory/smoke"
cp packages/typegraph/scripts/smoke-exports.mjs "$work_directory/smoke/"
cd "$work_directory/smoke"
npm init -y >/dev/null
# shellcheck disable=SC2086 # OPTIONAL_PEER_SPECS is a space-separated list
npm install "$TARBALL_PATH" $OPTIONAL_PEER_SPECS >/dev/null
node smoke-exports.mjs
