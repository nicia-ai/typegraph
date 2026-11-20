/**
 * `readIdentityTransitionRetention` must decode both cuts' recorded-time
 * columns through the identity module's one timestamp owner
 * `toCanonicalIdentityTimestamp` (row-codec.ts) — exactly the decoder
 * `normalizeIdentityTransitionRow` in the SAME file already uses for
 * `recorded_at` / `valid_at`. A second, stricter inline decoder
 * (`asRowString`) throws on a JS `Date` (what node-postgres returns for a
 * `timestamp(..., { withTimezone: true })` column) and passes non-ISO text
 * through uncanonicalized (what a text-returning driver such as postgres-js
 * returns).
 *
 * `identityReplay` ALWAYS reads the retention row (replay.ts), so on real
 * PostgreSQL every replay would throw once a graph had been pruned even once.
 * Neither SQLite nor PGlite can reproduce this: both return canonical ISO
 * text for a timestamp column, which every decoder candidate accepts — so
 * this drives the reader directly with the two raw PostgreSQL driver value
 * shapes, bypassing the query layer entirely.
 *
 * Revert check: replacing `toCanonicalIdentityTimestamp(recordedAtValue)` in
 * `decodeIdentityTransitionCut` (`transition-log.ts`) with a plain string
 * cast leaves the `Date` case returning a `Date` and the raw-text case
 * returning `2026-09-08 22:08:27.154+00` verbatim — failing the
 * canonical-format assertions.
 */
import { describe, expect, it } from "vitest";

import { type IdentityTarget } from "../src/identity/sql-target";
import { readIdentityTransitionRetention } from "../src/identity/transition-log";
import { createSqlSchema } from "../src/query/compiler/schema";
import { isCanonicalIsoDate } from "../src/utils/date";

const schema = createSqlSchema();
const graphId = "g1r3_01_retention_decode";

function fakeTargetReturningCutTimes(recordedAt: unknown): IdentityTarget {
  return {
    execute: () =>
      Promise.resolve([
        {
          pruned_before_revision: 42,
          pruned_before_recorded_at: recordedAt,
          restored_pruned_before_revision: 7,
          restored_pruned_before_recorded_at: recordedAt,
        },
      ]),
  } as unknown as IdentityTarget;
}

describe("readIdentityTransitionRetention recorded-time decode", () => {
  for (const [label, raw] of [
    ["a node-postgres JS Date", new Date("2026-09-08T22:08:27.154Z")],
    ["postgres-js raw text", "2026-09-08 22:08:27.154+00"],
  ] as const) {
    it(`decodes ${label} on both cuts`, async () => {
      const retention = await readIdentityTransitionRetention(
        fakeTargetReturningCutTimes(raw),
        schema,
        graphId,
      );
      console.info("decoded retention", { label, retention });
      expect(retention).toEqual({
        pruned: { revision: 42, recordedAt: "2026-09-08T22:08:27.154Z" },
        restoredPruned: { revision: 7, recordedAt: "2026-09-08T22:08:27.154Z" },
      });
      expect(isCanonicalIsoDate(retention.pruned?.recordedAt ?? "")).toBe(true);
    });
  }
});
