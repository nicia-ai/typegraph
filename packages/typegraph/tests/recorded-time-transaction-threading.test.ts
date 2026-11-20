/**
 * A profile-supplied `recordedTime` (`EngineProvisioning.recordedTime`) must
 * reach a `transaction()` handle, not only the root backend — the same
 * threading `tests/lineage-transaction-threading.test.ts` proves for
 * `lineage`, and for the identical reason: the transaction-scoped backend
 * each dialect's `lateMembers` builds is a SEPARATE object
 * (`createSqliteOperationBackend`/`createPostgresOperationBackend`,
 * `transactionScoped: true`), so a member the root literal spreads in must
 * also be threaded explicitly into that separate construction, or
 * `tx.recordedTime` is silently `undefined` on every `transaction()` handle
 * regardless of what the profile declared.
 *
 * `provisioning` is not one of `deriveEngineProfile`'s derivable keys (see
 * that function's own doc comment), so — exactly as the lineage suite does —
 * this attaches a scripted `recordedTime` by mutating the SAME
 * `provisioning` object `buildSqliteEngineProfile`/`buildPostgresEngineProfile`
 * already built, in place, before handing the profile to `createSqlBackend`.
 * A profile that declares `recordedTime` must also declare `lineage`
 * (`createSqlBackend`'s co-requirement refusal), so every case here attaches
 * both.
 */
import { PGlite } from "@electric-sql/pglite";
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqlBackend } from "../src/backend/drizzle/engine";
import { buildPostgresEngineProfile } from "../src/backend/drizzle/postgres";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import type {
  EngineRecordedTimeMembers,
  EngineRevision,
  LineageMembers,
} from "../src/backend/types";
import { sql } from "../src/query/sql-fragment";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function scriptedLineage(): LineageMembers {
  return {
    revision: () => Promise.resolve("engine-r0" as EngineRevision),
    changesSince: () => Promise.resolve({ kind: "unbounded" }),
  };
}

function scriptedRecordedTime(): EngineRecordedTimeMembers {
  return {
    source: (table) => sql.identifier(`engine_${table}`),
    revisionNow: () =>
      Promise.resolve({
        revision: "engine-r0",
        recordedAt: "2026-01-01T00:00:00.000Z",
      }),
  };
}

/**
 * Attaches `lineage`/`recordedTime` to `profile.provisioning` IN PLACE — see
 * the module doc comment for why this, rather than `deriveEngineProfile`, is
 * the way to script a bundled profile's `EngineProvisioning` members for a
 * test. `EngineProvisioning` is typed `Readonly<{ … }>` only at compile
 * time; the underlying object is a plain, mutable literal the bundled
 * builder constructs once and every closure reads by reference.
 */
function attachEngineNativeRecordedTime(
  provisioning: object,
  recordedTime: EngineRecordedTimeMembers,
  lineage: LineageMembers,
): void {
  const mutable = provisioning as {
    lineage?: LineageMembers;
    recordedTime?: EngineRecordedTimeMembers;
  };
  mutable.lineage = lineage;
  mutable.recordedTime = recordedTime;
}

describe("a profile-supplied recordedTime reaches a transaction() handle", () => {
  it("SQLite: tx.recordedTime is the SAME object the root backend exposes", async () => {
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
    });
    const profile = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
    });
    const recordedTime = scriptedRecordedTime();
    attachEngineNativeRecordedTime(
      profile.provisioning,
      recordedTime,
      scriptedLineage(),
    );

    const backend = createSqlBackend(profile);
    expect(backend.recordedTime).toBe(recordedTime);

    let observed: EngineRecordedTimeMembers | undefined;
    await backend.transaction((tx) => {
      observed = tx.recordedTime;
      return Promise.resolve();
    });
    expect(observed).toBe(recordedTime);
  });

  it("PGlite: tx.recordedTime is the SAME object the root backend exposes", async () => {
    const client = await PGlite.create();
    cleanups.push(() => client.close());
    const profile = buildPostgresEngineProfile(drizzlePg(client), {
      vector: false,
    });
    const recordedTime = scriptedRecordedTime();
    attachEngineNativeRecordedTime(
      profile.provisioning,
      recordedTime,
      scriptedLineage(),
    );

    const backend = createSqlBackend(profile);
    expect(backend.recordedTime).toBe(recordedTime);

    let observed: EngineRecordedTimeMembers | undefined;
    await backend.transaction((tx) => {
      observed = tx.recordedTime;
      return Promise.resolve();
    });
    expect(observed).toBe(recordedTime);
  });

  it("SQLite: a transaction-scoped backend built with no profile recordedTime carries none", async () => {
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
    });
    const profile = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
    });
    const backend = createSqlBackend(profile);
    expect(backend.recordedTime).toBeUndefined();

    let observed: EngineRecordedTimeMembers | undefined =
      scriptedRecordedTime();
    await backend.transaction((tx) => {
      observed = tx.recordedTime;
      return Promise.resolve();
    });
    expect(observed).toBeUndefined();
  });
});
