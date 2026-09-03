#!/usr/bin/env bash
set -e

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"

# Default connection URL (used when starting our own container)
DEFAULT_POSTGRES_URL="postgresql://typegraph:typegraph@localhost:5432/typegraph_test"

# If POSTGRES_URL is already set (e.g., in CI), use the existing database
EXTERNAL_POSTGRES=0
if [[ -n "$POSTGRES_URL" ]]; then
  echo "Using existing PostgreSQL at $POSTGRES_URL"
  EXTERNAL_POSTGRES=1
else
  # Start PostgreSQL locally. `up -d --wait` is idempotent, so a container
  # left warm by a previous run is reused as-is, and the container is left
  # running afterwards: repeat runs skip the start/stop cycle, and one
  # invocation's exit can no longer tear the server out from under a
  # concurrent invocation (which shows up as a wall of ECONNREFUSED
  # failures that reads as a code regression). Per-suite databases are
  # dropped and recreated by each run, so a warm server carries no state
  # between runs. Set TYPEGRAPH_POSTGRES_DOWN=1 to restore teardown, or
  # stop it manually: docker compose -f packages/typegraph/docker-compose.yml down
  echo "Starting PostgreSQL (reused if already running)..."
  docker compose -f "$PACKAGE_DIR/docker-compose.yml" up -d --wait

  if [[ "${TYPEGRAPH_POSTGRES_DOWN:-}" == "1" ]]; then
    cleanup() {
      echo "Stopping PostgreSQL..."
      docker compose -f "$PACKAGE_DIR/docker-compose.yml" down
    }
    trap cleanup EXIT
  fi

  POSTGRES_URL="$DEFAULT_POSTGRES_URL"
fi

# Run all postgres tests (backend-specific, integration, and graph-merge).
#
# Each suite provisions its own database off this URL (see
# `tests/postgres-test-database.ts`), so the schema-destructive DDL in their
# `beforeAll`/`beforeEach` hooks can no longer reach another suite's tables.
# Isolation therefore holds by construction, and the suites run file-parallel.
#
# The worker cap exists for the CONNECTION BUDGET, not for isolation: every
# worker holds at least one pool against the same server, and the graph-merge
# property fixtures keep several backends alive at once. Parallelism is
# therefore tied to WHO provisioned the server:
#
# - The bundled docker-compose.yml raises max_connections to 400, which gives
#   6 workers comfortable headroom, so the compose path defaults to
#   min(6, cores).
# - An externally supplied POSTGRES_URL has an UNKNOWN budget — a stock
#   server's max_connections=100 cannot absorb six workers' pools, and "sorry,
#   too many clients already" mid-suite is the failure mode — so it defaults
#   to the pre-parallel behaviour of ONE worker. An owner who has budgeted
#   their server states the cap explicitly via TYPEGRAPH_PG_MAX_WORKERS
#   (CI does: it raises max_connections on its service container first, and
#   the workflow sets the cap beside that step).
#
# Graph-merge fixtures additionally isolate per-fixture schemas.
#
# With POSTGRES_URL set, the graph-merge backendMatrix() gains its
# server-Postgres entry, so those suites run on SQLite, PGlite, AND the
# production pg driver in this lane.
CORES="$(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
if [[ -n "${TYPEGRAPH_PG_MAX_WORKERS:-}" ]]; then
  MAX_WORKERS="$TYPEGRAPH_PG_MAX_WORKERS"
elif [[ "$EXTERNAL_POSTGRES" == "1" ]]; then
  MAX_WORKERS=1
else
  MAX_WORKERS=$(( CORES < 6 ? CORES : 6 ))
fi

# The graph-merge and pglite vitest projects serialize their files by
# default to keep PGlite startup latency out of the default lane; this
# lane opts them back in only when it actually runs multi-worker (see
# vitest.config.ts) — with one worker the opt-in would change nothing but
# still advertise a parallelism the connection budget never approved.
if [[ "$MAX_WORKERS" -gt 1 ]]; then
  export TYPEGRAPH_HEAVY_FILE_PARALLELISM=1
fi

echo "Running PostgreSQL tests ($MAX_WORKERS workers)..."
vitest_args=(
  run
  --maxWorkers="$MAX_WORKERS"
)

# GitHub's non-TTY default reporter prints every successful test, and expected
# negative-path PostgreSQL errors can add hundreds of thousands of log lines.
# Keep local runs unchanged, but make CI compact while retaining console output
# for failed tests and Vitest's full failure diagnostics.
if [[ -n "${CI:-}" ]]; then
  vitest_args+=(--reporter=dot --silent=passed-only)
fi

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
  tests/identity-frontier-bounded.test.ts
  tests/identity-maintenance-schema-race.test.ts
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
