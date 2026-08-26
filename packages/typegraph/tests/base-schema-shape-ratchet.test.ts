/**
 * A physical TypeGraph relation cannot change invisibly.
 *
 * These digests cover every base-owned CREATE TABLE / CREATE INDEX statement,
 * excluding strategy-owned runtime contributions. A shape change must add a
 * new immutable BASE_SCHEMA_RELEASES entry. Advancing that ledger also raises
 * CURRENT_BASE_SCHEMA_VERSION, so both bundled backend constructors refuse to
 * start until they register the matching adoption step.
 */
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  BASE_SCHEMA_RELEASES,
  CURRENT_BASE_SCHEMA_VERSION,
} from "../src/backend/drizzle/base-schema";
import {
  postgresContributions,
  sqliteContributions,
} from "../src/backend/drizzle/ddl";
import { BASE_CONTRIBUTION_OWNER } from "../src/backend/table-contribution";

function shapeDigest(
  contributions: ReturnType<
    typeof postgresContributions | typeof sqliteContributions
  >,
): string {
  const canonicalDdl = contributions
    .filter((contribution) => contribution.owner === BASE_CONTRIBUTION_OWNER)
    .flatMap((contribution) => [...contribution.createDdl])
    .map((statement) => statement.replaceAll(/\s+/g, " ").trim())
    .toSorted()
    .join("\n");
  return createHash("sha256").update(canonicalDdl).digest("hex");
}

describe("base schema shape ratchet", () => {
  it("keeps the immutable release ledger contiguous", () => {
    expect(BASE_SCHEMA_RELEASES.map((release) => release.version)).toEqual(
      BASE_SCHEMA_RELEASES.map((_, index) => index + 1),
    );
    expect(BASE_SCHEMA_RELEASES.at(-1)?.version).toBe(
      CURRENT_BASE_SCHEMA_VERSION,
    );
  });

  it("binds current SQLite base DDL to the latest adoption release", () => {
    expect(shapeDigest(sqliteContributions())).toBe(
      BASE_SCHEMA_RELEASES.at(-1)?.shapeDigests.sqlite,
    );
  });

  it("binds current PostgreSQL base DDL to the latest adoption release", () => {
    expect(shapeDigest(postgresContributions())).toBe(
      BASE_SCHEMA_RELEASES.at(-1)?.shapeDigests.postgres,
    );
  });
});
