/**
 * G1R3-01: `readTransitionRetentionDetails` must decode `pruned_at` through
 * the identity module's one owner `toCanonicalIdentityTimestamp`
 * (row-codec.ts) — exactly the decoder `normalizeIdentityTransitionRow` in
 * the SAME file already uses for `recorded_at` / `valid_at` (G1-05). A second,
 * stricter inline decoder (`asRowString`) throws on a JS `Date` (what
 * node-postgres returns for a `timestamp(..., { withTimezone: true })`
 * column) and passes non-ISO text through uncanonicalized (what a
 * text-returning driver such as postgres-js returns).
 *
 * `identityReplay` ALWAYS calls `readTransitionRetentionDetails`
 * (replay.ts), so on real PostgreSQL every replay would throw once a graph
 * had been pruned even once. Neither SQLite nor PGlite can reproduce this:
 * both return canonical ISO text for a timestamp column, which every decoder
 * candidate accepts — so this drives the reader directly with the two raw
 * PostgreSQL driver value shapes, bypassing the query layer entirely, the
 * same probe technique the finding used to reproduce it.
 *
 * Revert check: reverting `toCanonicalIdentityTimestamp(row.pruned_at)` to
 * `asRowString(row.pruned_at, "pruned_at")` in `transition-log.ts` makes the
 * first case below throw `ConfigurationError` (Date is not a string) and
 * leaves the second case returning `2026-09-08 22:08:27.154+00` verbatim —
 * failing the canonical-format assertion.
 */
import { describe, expect, it } from "vitest";

import { type IdentityTarget } from "../src/identity/sql-target";
import { readTransitionRetentionDetails } from "../src/identity/transition-log";
import { createSqlSchema } from "../src/query/compiler/schema";
import { isCanonicalIsoDate } from "../src/utils/date";

const schema = createSqlSchema();
const graphId = "g1r3_01_retention_decode";

function fakeTargetReturningPrunedAt(prunedAt: unknown): IdentityTarget {
  return {
    execute: () =>
      Promise.resolve([{ pruned_before_revision: 42, pruned_at: prunedAt }]),
  } as unknown as IdentityTarget;
}

describe("readTransitionRetentionDetails pruned_at decode (G1R3-01)", () => {
  it("decodes a node-postgres JS Date pruned_at without throwing", async () => {
    const target = fakeTargetReturningPrunedAt(
      new Date("2026-09-08T22:08:27.154Z"),
    );
    const details = await readTransitionRetentionDetails(
      target,
      schema,
      graphId,
    );
    expect(details.prunedBeforeRevision).toBe(42);
    expect(isCanonicalIsoDate(details.prunedAt)).toBe(true);
    expect(details.prunedAt).toBe("2026-09-08T22:08:27.154Z");
  });

  it("canonicalizes a postgres-js raw-text pruned_at", async () => {
    const target = fakeTargetReturningPrunedAt("2026-09-08 22:08:27.154+00");
    const details = await readTransitionRetentionDetails(
      target,
      schema,
      graphId,
    );
    expect(details.prunedBeforeRevision).toBe(42);
    expect(isCanonicalIsoDate(details.prunedAt)).toBe(true);
    expect(details.prunedAt).toBe("2026-09-08T22:08:27.154Z");
  });
});
