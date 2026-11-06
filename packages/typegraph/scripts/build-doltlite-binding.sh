#!/usr/bin/env bash
set -euo pipefail

package_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
repository_dir="$(cd "$package_dir/../.." && pwd)"
mkdir -p "$package_dir/tmp"
build_dir="$(mktemp -d "$package_dir/tmp/doltlite-binding.XXXXXXXX")"

# Both source inputs are pinned. Never build a moving branch or skip TLS/checksums.
git -C "$build_dir" init --quiet
git -C "$build_dir" remote add origin https://github.com/dolthub/doltlite-node.git
git -C "$build_dir" fetch --quiet --depth=1 origin c178405e1c8f40ec8f0d9ce584f8da7ce1fd6ddf
git -C "$build_dir" checkout --quiet --detach FETCH_HEAD
test "$(git -C "$build_dir" rev-parse HEAD)" = c178405e1c8f40ec8f0d9ce584f8da7ce1fd6ddf
git -C "$build_dir" apply "$repository_dir/patches/doltlite-node-0.51.9.patch"

curl --fail --location --silent --show-error \
  https://github.com/dolthub/doltlite/releases/download/v0.51.9/doltlite-autoconf-0.51.9.tar.gz \
  --output "$build_dir/engine.tar.gz"
(
  cd "$build_dir"
  test "$(sha256sum engine.tar.gz | cut -d ' ' -f 1)" = ae6a44cab882de9e6a34b9aa6c29ae1c6f7a5ef2a60f3f48b6ae13be9cd2a47f
  mkdir -p amalgamation/.source
  tar xzf engine.tar.gz --strip-components=1 -C amalgamation/.source
  npm ci --ignore-scripts --no-audit --no-fund --cache "${npm_config_cache:-$build_dir/npm-cache}"
  node scripts/build-amalgamation.js
  "$package_dir/node_modules/.bin/node-gyp" rebuild --jobs=2 --devdir="$build_dir/node-gyp-cache"
  node --test test/errors.test.cjs
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
echo "Installed patched DoltLite binding from $build_dir"
