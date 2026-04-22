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

# Run all postgres tests (backend-specific and integration).
#
# `--no-file-parallelism` serializes test-file execution: every PG test
# suite targets the same `typegraph_test` database, and several files'
# `beforeAll` hooks run schema-destructive DDL (DROP TABLE). Running
# files in parallel is a recipe for flaky mid-test table disappearance.
echo "Running PostgreSQL tests..."
POSTGRES_URL="$POSTGRES_URL" vitest run --no-file-parallelism tests/backends/postgres/ tests/backends/integration/
