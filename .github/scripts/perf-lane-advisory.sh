#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 3 ]]; then
  echo "Usage: $0 <base-sha> <head-sha> <comma-separated-labels>" >&2
  exit 2
fi

base_sha="$1"
head_sha="$2"
labels_csv="$3"

# The changed-line threshold above which a query/store/backend change is
# mandatory-by-policy regardless of label. See docs/TESTING.md's "Performance
# timing lane (EC2)" section and the batch commit body for the scan backing
# this number.
#
# Of the last 60 first-parent commits on main touching
# packages/typegraph/src/{query,store,backend}, 27 changed at or below 200
# lines (5-196), and both regressions this lane exists to guard — #396's
# frontier equi-join fix (337 lines) and #391's per-query identity-class
# evaluation (445 lines) — sit comfortably above that line, as does every
# commit at or above 1000 lines in the same sample. But that 27-commit set is
# NOT uniformly "small typed-refusal/bugfix": several are genuine
# capability additions well under 200 lines and squarely the class this lane
# exists to catch (e.g. #342 "Make documented query hooks observe submitted
# statements", 93 lines, adds beforeQuery/afterQuery instrumentation to
# store.ts; #320 "Add valid-time endpoint edge writes", 128 lines, changes
# write-path behavior; #311 "Make verified adapter stores reusable across
# connections", 195 lines, changes connection-caching behavior) — none of
# which carried a major-feature/refactor/perf-lane label (verified via `gh pr
# view --json labels` against #342/#320/#311; all three came back empty).
# 200 is kept anyway: it is a large-diff backstop, sized well below both
# known regressions, not a claim that every smaller diff is safe. Catching a
# smaller feature-shaped diff in query/store/backend depends on the author
# applying the major-feature/refactor/perf-lane label above — a reviewer
# discipline this script cannot enforce by line count alone, since this
# history shows feature commits at every size band down to ~30 lines.
PERF_LANE_CHANGED_LINE_THRESHOLD=200

IFS=',' read -r -a labels <<< "$labels_csv"
for label in "${labels[@]}"; do
  case "$label" in
    major-feature | refactor | perf-lane)
      echo "Label \"$label\" makes the timing lane mandatory by policy." >&2
      echo "mandatory"
      exit 0
      ;;
  esac
done

changed_lines="$(
  git diff --numstat "$base_sha...$head_sha" -- \
    packages/typegraph/src/query \
    packages/typegraph/src/store \
    packages/typegraph/src/backend |
    awk '{ added += $1; deleted += $2 } END { print added + deleted + 0 }'
)"

if [[ "$changed_lines" -gt "$PERF_LANE_CHANGED_LINE_THRESHOLD" ]]; then
  echo "Changed $changed_lines lines under packages/typegraph/src/{query,store,backend}," \
    "above the $PERF_LANE_CHANGED_LINE_THRESHOLD-line threshold." >&2
  echo "mandatory"
  exit 0
fi

echo "No mandatory-by-policy label and $changed_lines changed line(s) under" \
  "packages/typegraph/src/{query,store,backend} (threshold: $PERF_LANE_CHANGED_LINE_THRESHOLD)." >&2
echo "optional"
