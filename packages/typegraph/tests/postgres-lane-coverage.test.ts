/**
 * Guards the `test:postgres` lane against silent coverage loss.
 *
 * A suite declares a server-PostgreSQL leg by resolving its connection URL
 * through `provisionPostgresTestDatabase`. Most of those suites live under
 * `tests/backends/postgres/`, which `scripts/test-postgres.sh` picks up by
 * directory. The mixed-backend ones — SQLite family in the default lane, plus
 * a Postgres leg when `POSTGRES_URL` is set — live outside that directory and
 * have to be named in the script individually.
 *
 * Forgetting one is invisible: the default lane skips the Postgres leg because
 * `POSTGRES_URL` is unset, and the Postgres lane never loads the file, so the
 * leg runs in no lane at all and the suite still reports green (#386). This
 * suite turns that omission into a failing test instead.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { requireDefined } from "../src/utils/presence";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const LANE_SCRIPT_RELATIVE_PATH = "scripts/test-postgres.sh";
const TESTS_DIRECTORY_NAME = "tests";

/** Importing this module is what marks a suite as needing a real server. */
const PROVISIONER_MODULE = "postgres-test-database";

/**
 * Matches the import rather than any mention of the module name, so a file
 * that merely talks about the provisioner (this one) is not mistaken for a
 * suite that uses it.
 */
const PROVISIONER_IMPORT_PATTERN = new RegExp(
  String.raw`from\s+"[^"]*/${PROVISIONER_MODULE}"`,
);

/**
 * Lane arguments as the script lists them: one `tests/…` path per line, either
 * a directory (trailing slash) or a single file. Comment lines are excluded by
 * the character class rather than skipped, so a commented-out entry does not
 * count as coverage.
 */
const LANE_TARGET_PATTERN = /^[^\S\n]*(tests\/[^\s#]+)[^\S\n]*$/gm;

function readLaneTargets(): readonly string[] {
  const script = readFileSync(
    path.join(PACKAGE_ROOT, LANE_SCRIPT_RELATIVE_PATH),
    "utf8",
  );
  return [...script.matchAll(LANE_TARGET_PATTERN)].map((match) =>
    requireDefined(
      match[1],
      `Lane target pattern matched without a path: ${match[0]}`,
    ),
  );
}

/** Package-relative POSIX paths of every `*.test.ts` file under `tests/`. */
function listTestFiles(): readonly string[] {
  const entries = readdirSync(path.join(PACKAGE_ROOT, TESTS_DIRECTORY_NAME), {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) =>
      path
        .relative(PACKAGE_ROOT, path.join(entry.parentPath, entry.name))
        .split(path.sep)
        .join("/"),
    );
}

function suitesWithPostgresLeg(): readonly string[] {
  return listTestFiles()
    .filter((file) =>
      PROVISIONER_IMPORT_PATTERN.test(
        readFileSync(path.join(PACKAGE_ROOT, file), "utf8"),
      ),
    )
    .toSorted();
}

/**
 * Vitest treats each positional argument as a path filter, so a directory
 * target covers everything beneath it and a file target covers only itself.
 */
function isCoveredByLane(
  file: string,
  laneTargets: readonly string[],
): boolean {
  return laneTargets.some((target) =>
    target.endsWith("/") ? file.startsWith(target) : file === target,
  );
}

describe("test:postgres lane coverage", () => {
  it("runs every suite that provisions a PostgreSQL database", () => {
    const laneTargets = readLaneTargets();
    const suites = suitesWithPostgresLeg();

    // Non-vacuity: a broken discovery step must not read as "all covered".
    expect(suites.length).toBeGreaterThan(0);

    const uncovered = suites.filter(
      (suite) => !isCoveredByLane(suite, laneTargets),
    );
    expect(
      uncovered,
      `These suites resolve a database through ${PROVISIONER_MODULE} but ${LANE_SCRIPT_RELATIVE_PATH} never loads them, so their PostgreSQL legs run in no lane. Add each one to the script's vitest arguments.`,
    ).toEqual([]);
  });

  it("names only paths that still exist", () => {
    const testFiles = new Set(listTestFiles());
    const missing = readLaneTargets().filter((target) =>
      target.endsWith("/") ?
        !existsSync(path.join(PACKAGE_ROOT, target))
      : !testFiles.has(target),
    );
    expect(
      missing,
      `${LANE_SCRIPT_RELATIVE_PATH} names paths that no longer exist. Vitest silently matches nothing for a stale filter, so the lane would quietly shrink.`,
    ).toEqual([]);
  });
});
