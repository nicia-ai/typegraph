/**
 * A profile-supplied `lineage` (`EngineProvisioning.lineage`) must reach a
 * `transaction()` handle, not only the root backend.
 *
 * `createSqlBackend` (`src/backend/drizzle/engine/create-sql-backend.ts`)
 * threads `profile.provisioning.lineage` onto the assembled ROOT backend
 * through its own conditional spread, so the root always carries it. The
 * transaction-scoped backend each dialect's `lateMembers` builds is a
 * SEPARATE object (`createSqliteOperationBackend`/
 * `createPostgresOperationBackend`, `transactionScoped: true`) — before this
 * fix it threaded `catalog` from the root's own bag but nothing for
 * `lineage`, so `tx.lineage` was silently `undefined` on every
 * `transaction()` handle regardless of what the profile declared.
 *
 * `provisioning` is not one of `deriveEngineProfile`'s derivable keys (see
 * that function's own doc comment: the bundled builders' closures capture
 * it directly, so overriding only the head field would leave some of those
 * closures reading the base value) — the one way to attach a scripted
 * `lineage` to a bundled profile for a test is to mutate the SAME
 * `provisioning` object `buildSqliteEngineProfile`/`buildPostgresEngineProfile`
 * already built, in place, before handing the profile to `createSqlBackend`.
 * Every closure that reads `provisioning.lineage` — `buildOperations` and
 * every `lateMembers` closure alike — reads the SAME object by reference, so
 * the mutation reaches all of them.
 */
import { PGlite } from "@electric-sql/pglite";
import RealDatabase from "better-sqlite3";
import { drizzle as drizzleSqlite } from "drizzle-orm/better-sqlite3";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import { createSqlBackend } from "../src/backend/drizzle/engine";
import { buildPostgresEngineProfile } from "../src/backend/drizzle/postgres";
import { buildSqliteEngineProfile } from "../src/backend/drizzle/sqlite";
import type { EngineRevision, LineageMembers } from "../src/backend/types";

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

/**
 * Attaches `lineage` to `profile.provisioning` IN PLACE — see the module
 * doc comment for why this, rather than `deriveEngineProfile`, is the way
 * to script a bundled profile's `EngineProvisioning.lineage` for a test.
 * `EngineProvisioning` is typed `Readonly<{ lineage?: LineageMembers }>`
 * only at compile time; the underlying object is a plain, mutable literal
 * the bundled builder constructs once and every closure reads by
 * reference.
 */
function attachLineage(provisioning: object, lineage: LineageMembers): void {
  (provisioning as { lineage?: LineageMembers }).lineage = lineage;
}

describe("a profile-supplied lineage reaches a transaction() handle", () => {
  it("SQLite: tx.lineage is the SAME object the root backend exposes", async () => {
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
    });
    const profile = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
    });
    const lineage = scriptedLineage();
    attachLineage(profile.provisioning, lineage);

    const backend = createSqlBackend(profile);
    expect(backend.lineage).toBe(lineage);

    let observed: LineageMembers | undefined;
    await backend.transaction((tx) => {
      observed = tx.lineage;
      return Promise.resolve();
    });
    expect(observed).toBe(lineage);
  });

  it("PGlite: tx.lineage is the SAME object the root backend exposes", async () => {
    const client = await PGlite.create();
    cleanups.push(() => client.close());
    const profile = buildPostgresEngineProfile(drizzlePg(client), {
      vector: false,
    });
    const lineage = scriptedLineage();
    attachLineage(profile.provisioning, lineage);

    const backend = createSqlBackend(profile);
    expect(backend.lineage).toBe(lineage);

    let observed: LineageMembers | undefined;
    await backend.transaction((tx) => {
      observed = tx.lineage;
      return Promise.resolve();
    });
    expect(observed).toBe(lineage);
  });

  it("SQLite: a transaction-scoped backend built with no profile lineage carries none", async () => {
    const sqlite = new RealDatabase(":memory:");
    cleanups.push(() => {
      sqlite.close();
    });
    const profile = buildSqliteEngineProfile(drizzleSqlite(sqlite), {
      executionProfile: { isSync: true },
    });
    const backend = createSqlBackend(profile);
    expect(backend.lineage).toBeUndefined();

    let observed: LineageMembers | undefined = scriptedLineage();
    await backend.transaction((tx) => {
      observed = tx.lineage;
      return Promise.resolve();
    });
    expect(observed).toBeUndefined();
  });
});
