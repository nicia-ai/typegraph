#!/usr/bin/env bash
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mkdir -p "$package_dir/tmp"
build_dir="$(mktemp -d "$package_dir/tmp/doltlite-binding.XXXXXXXX")"

# Both source inputs are pinned. Never build a moving branch or skip TLS/checksums.
git -C "$build_dir" init --quiet
git -C "$build_dir" remote add origin https://github.com/dolthub/doltlite-node.git
git -C "$build_dir" fetch --quiet --depth=1 origin 5917efb805215dd49ff6798f78383be02e75a548
git -C "$build_dir" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$build_dir" rev-parse HEAD)" = 5917efb805215dd49ff6798f78383be02e75a548

curl --fail --location --silent --show-error \
  https://github.com/dolthub/doltlite/releases/download/v0.51.14/doltlite-autoconf-0.51.14.tar.gz \
  --output "$build_dir/engine.tar.gz"
(
  cd "$build_dir"
  test "$(sha256sum engine.tar.gz | cut -d ' ' -f 1)" = fea7c8087b51de11fe2814e467f99e347a094cdaab37ff4e7ae344466af46ef1
  mkdir -p amalgamation/.source
  tar xzf engine.tar.gz --strip-components=1 -C amalgamation/.source
  npm ci --ignore-scripts --no-audit --no-fund --cache "${npm_config_cache:-$build_dir/npm-cache}"
  node scripts/build-amalgamation.js
  "$package_dir/node_modules/.bin/node-gyp" rebuild --jobs=2 --devdir="$build_dir/node-gyp-cache"
  node --test test/native.test.cjs
)

# Replace only the generated pnpm package link, preserving regular directories.
binding_link="$package_dir/node_modules/@dolthub/doltlite"
if [[ -L "$binding_link" ]]; then
  rm "$binding_link"
elif [[ -e "$binding_link" ]]; then
  echo "Refusing to replace a non-symlink binding directory: $binding_link" >&2
  exit 1
fi
mkdir -p "$(dirname "$binding_link")"
ln -s "$build_dir" "$binding_link"
echo "Installed source-built DoltLite binding from $build_dir"
