#!/usr/bin/env bash
set -e

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"

# Default connection URL (used when starting our own container)
DEFAULT_POSTGRES_URL="postgresql://typegraph:typegraph@localhost:5432/typegraph_test"

# If POSTGRES_URL is already set (e.g., in CI), use the existing database
if [[ -n "$POSTGRES_URL" ]]; then
  echo "Using existing PostgreSQL at $POSTGRES_URL"
else
  # Start PostgreSQL locally
  echo "Starting PostgreSQL..."
  docker compose -f "$PACKAGE_DIR/docker-compose.yml" up -d --wait

  # Ensure cleanup on exit (success or failure)
  cleanup() {
    echo "Stopping PostgreSQL..."
    docker compose -f "$PACKAGE_DIR/docker-compose.yml" down
  }
  trap cleanup EXIT

  POSTGRES_URL="$DEFAULT_POSTGRES_URL"
fi

# Run all postgres tests (backend-specific, integration, and graph-merge).
#
# Each suite provisions its own database off this URL (see
# `tests/postgres-test-database.ts`), so the schema-destructive DDL in their
# `beforeAll`/`beforeEach` hooks can no longer reach another suite's tables.
# Isolation therefore holds by construction, and running any subset of these
# files in parallel — the usual way to reproduce one failure — is safe.
#
# `--no-file-parallelism` stays for the CONNECTION BUDGET, not for isolation:
# every worker holds at least one pool against the same server, the
# graph-merge property fixtures keep several backends alive at once, and
# `max_connections` is 100 ("sorry, too many clients already"). Graph-merge
# fixtures additionally isolate per-fixture schemas.
#
# With POSTGRES_URL set, the graph-merge backendMatrix() gains its
# server-Postgres entry, so those suites run on SQLite, PGlite, AND the
# production pg driver in this lane.
echo "Running PostgreSQL tests..."
vitest_args=(
  run
  --no-file-parallelism
)

if [[ -n "${VITEST_SHARD:-}" ]]; then
  vitest_args+=("--shard=$VITEST_SHARD")
fi

# tests/backends/integration/ is deliberately absent: it holds suite
# definitions registered via createIntegrationTestSuite, not *.test.ts files,
# so listing it matches nothing and reads as coverage that is not there.
vitest_args+=(
  tests/backends/postgres/
  tests/graph-merge/
  tests/property/graph-merge/
  # Mixed-backend suites. These run the SQLite family in the default lane and
  # ADD a server-Postgres leg when POSTGRES_URL is set, so they live outside
  # tests/backends/postgres/ and have to be named one by one. Omitting one
  # costs nothing visible — its Postgres leg just never executes anywhere
  # (#386) — so `tests/postgres-lane-coverage.test.ts` fails when a suite that
  # resolves its URL through `provisionPostgresTestDatabase` is missing here.
  tests/backends/l2-score-scale-parity.test.ts
  tests/hybrid-single-statement.test.ts
  tests/search-filter-pushdown.test.ts
  tests/search-liveness.test.ts
  tests/similar-to-approximate.test.ts
  tests/vector-cross-backend-parity.test.ts
  # Self-skip unless TYPEGRAPH_PERF=1, so they cost the lane nothing by
  # default; listed so their Postgres legs have a lane when perf runs are
  # enabled.
  tests/perf/identity-current-traversal-scaling.test.ts
  tests/perf/identity-historical-traversal-scaling.test.ts
)

POSTGRES_URL="$POSTGRES_URL" vitest "${vitest_args[@]}"
