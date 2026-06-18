/**
 * Type-level contract for the backend role brands (`src/backend/branded.ts`).
 *
 * The brands exist to turn a silent footgun — routing a graph-entity write
 * through the capture-bypassing raw backend, losing history with no error —
 * into a compile error. This test pins that protection: every misuse direction
 * must be an error, every correct use must compile, and both brands must stay
 * usable wherever a plain `GraphBackend` is read.
 */
import { expectAssignable, expectError, expectNotAssignable } from "tsd";
import { type SQL } from "drizzle-orm";

import {
  asGraphWriteBackend,
  asRawBackend,
  type GraphWriteBackend,
  type RawBackend,
} from "../src/backend/branded";
import { createBackendOverlay, type GraphBackend } from "../src/backend/types";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
  type CompiledRowsSql,
  type CompiledStatementSql,
} from "../src/query/sql-intent";

declare const plain: GraphBackend;
declare const writeBackend: GraphWriteBackend;
declare const rawBackend: RawBackend;
declare const unbrandedSql: SQL;
declare const compiledRows: CompiledRowsSql;
declare const compiledStatement: CompiledStatementSql;

/** A bulk / DDL seam that bypasses capture — mirrors materializeRemovals. */
declare function runsRawBulkWork(backend: RawBackend): void;
/** A graph-entity write seam that must be captured. */
declare function runsGraphWrites(backend: GraphWriteBackend): void;

// The footgun: a graph-write backend routed into the raw/bulk seam (a write
// that would silently bypass recorded-time capture) is a type error.
expectError(runsRawBulkWork(writeBackend));

// The reverse: a raw/DDL backend handed to a graph-write seam.
expectError(runsGraphWrites(rawBackend));

// An untagged backend cannot drift into either role by accident — a role must
// be explicitly asserted via the `as*` taggers.
expectError(runsRawBulkWork(plain));
expectError(runsGraphWrites(plain));
expectNotAssignable<RawBackend>(plain);
expectNotAssignable<GraphWriteBackend>(plain);

// The two brands are not interchangeable with each other.
expectNotAssignable<RawBackend>(writeBackend);
expectNotAssignable<GraphWriteBackend>(rawBackend);

// Correct usage compiles, including bridging a plain backend at a sanctioned
// seam via the taggers.
runsRawBulkWork(rawBackend);
runsGraphWrites(writeBackend);
runsRawBulkWork(asRawBackend(plain));
runsGraphWrites(asGraphWriteBackend(plain));

// Both brands remain readable wherever a plain GraphBackend is expected, so
// read paths are unaffected.
expectAssignable<GraphBackend>(writeBackend);
expectAssignable<GraphBackend>(rawBackend);

// Row-returning execution is also branded. Internal query compilation returns
// the brand directly; direct raw SQL callers must mark the intent explicitly.
declare const rowExecutor: GraphBackend["execute"];
expectError(rowExecutor<unknown>(unbrandedSql));
void rowExecutor<unknown>(compiledRows);
void rowExecutor<unknown>(asCompiledRowsSql(unbrandedSql));

// Statement execution is intentionally branded. A random Drizzle SQL object is
// not enough to cross the non-row-returning raw-statement seam; callers must
// make the statement intent explicit.
declare const statementExecutor: NonNullable<GraphBackend["executeStatement"]>;
expectError(statementExecutor(unbrandedSql));
void statementExecutor(compiledStatement);
void statementExecutor(asCompiledStatementSql(unbrandedSql));

// Backend overlays must only replace real backend members. This catches typoed
// wrapper keys at compile time instead of silently dropping them at runtime.
expectAssignable<GraphBackend>(
  createBackendOverlay(plain, { dialect: "sqlite" }),
);
expectError(
  createBackendOverlay(plain, {
    doesNotExistOnBackend: () => undefined,
  }),
);
