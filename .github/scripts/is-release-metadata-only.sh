#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <base-sha> <head-sha>" >&2
  exit 2
fi

base_sha="$1"
head_sha="$2"
has_changed_file=false
is_release_metadata_only=true

function package_change_is_version_only() {
  local package_path="$1"
  local base_package
  local head_package

  if ! base_package="$(git show "$base_sha:$package_path" | jq -cS 'del(.version)')"; then
    return 1
  fi

  if ! head_package="$(git show "$head_sha:$package_path" | jq -cS 'del(.version)')"; then
    return 1
  fi

  [[ "$base_package" == "$head_package" ]]
}

while IFS= read -r changed_file; do
  if [[ -z "$changed_file" ]]; then
    continue
  fi

  has_changed_file=true

  case "$changed_file" in
    .changeset/*.md | CHANGELOG.md | */CHANGELOG.md) ;;
    packages/typegraph/package.json)
      if ! package_change_is_version_only "$changed_file"; then
        is_release_metadata_only=false
        break
      fi
      ;;
    *)
      is_release_metadata_only=false
      break
      ;;
  esac
done < <(git diff --name-only "$base_sha" "$head_sha")

if [[ "$has_changed_file" != "true" ]]; then
  is_release_metadata_only=false
fi

echo "$is_release_metadata_only"
