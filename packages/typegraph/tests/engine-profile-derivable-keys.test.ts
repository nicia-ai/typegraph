/**
 * The derivable/non-derivable partition of `SqlEngineProfile`'s own keys
 * (`src/backend/drizzle/engine/derive-profile.ts`).
 *
 * Two pinned reason maps, one per side of the partition, each a `Record`
 * keyed by exactly that side's key type — so a key added to
 * `SqlEngineProfile` that lands in neither `DERIVABLE_ENGINE_PROFILE_KEYS`
 * nor this file's own non-derivable list fails to typecheck HERE (the
 * `NonDerivableEngineProfileKey` computed type gains the new key, and the
 * `satisfies Record<NonDerivableEngineProfileKey, string>` literal below it
 * is then missing a property) before it can silently ship as neither
 * derivable nor accounted for. The two `satisfies Record<...>` clauses ARE
 * the type-level totality proof, both directions: `DERIVABLE_KEY_REASONS`
 * fails unless it has exactly one property per `DerivableEngineProfileKey`
 * (removing a key from `DERIVABLE_ENGINE_PROFILE_KEYS` drops a required
 * property, adding an unlisted one is excess), and
 * `NON_DERIVABLE_KEY_REASONS` fails the same way against
 * `NonDerivableEngineProfileKey`, which is computed as `Exclude<keyof
 * SqlEngineProfile<unknown>, DerivableEngineProfileKey>` — so a key that
 * belongs to neither map is a type error at ONE of the two literals, never
 * silently absent from both. The runtime assertion at the bottom checks the
 * same partition against a REAL bundled profile's own enumerable keys, so a
 * key present on an actual profile but absent from both lists (or vice
 * versa) fails there too, independent of the type-level check.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/pglite";
import { afterEach, describe, expect, it } from "vitest";

import {
  DERIVABLE_ENGINE_PROFILE_KEYS,
  type DerivableEngineProfileKey,
} from "../src/backend/drizzle/engine";
import type { SqlEngineProfile } from "../src/backend/drizzle/engine/profile";
import { buildPostgresEngineProfile } from "../src/backend/drizzle/postgres";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/**
 * Every `SqlEngineProfile` key `DERIVABLE_ENGINE_PROFILE_KEYS` does not
 * already cover. Computed FROM `DerivableEngineProfileKey`, not spelled
 * independently, so it always tracks that type rather than a second,
 * driftable copy of it.
 */
type NonDerivableEngineProfileKey = Exclude<
  keyof SqlEngineProfile<unknown>,
  DerivableEngineProfileKey
>;

/**
 * Why `createSqlBackend` reads each derivable key exclusively off `profile`
 * (never off a copy a dialect's own closure captured) — see
 * `derive-profile.ts`'s module doc comment for the fuller inventory this
 * summarizes.
 */
const DERIVABLE_KEY_REASONS = {
  declaredCapabilities:
    "read directly off `profile` by createSqlBackend's finalizeEngineCapabilities call, EXCEPT maxBindParameters and execution.interactiveTransactions, which the bundled PostgreSQL builder also bakes into its execution adapter's own options — deriveEngineProfile refuses an override that would change either of those two sub-values, see engine-profile-derivation.test.ts",
  fenceSql:
    "read directly off `profile` when createSqlBackend builds the one fence target",
  resourceAudit:
    "read directly off `profile` by createSqlBackend's own auditBackendResource call, EXCEPT `kind`, which the bundled PostgreSQL builder also bakes into its execution adapter's own options — deriveEngineProfile refuses an override that would change it, see engine-profile-derivation.test.ts",
  autocommit:
    "read directly off `profile` by applyEngineMarks's autocommit gate",
  contributionRuntime:
    "spread directly into createContributionMembers by createSqlBackend, captured by no dialect closure",
  identityRuntime:
    "spread directly into createIdentityMembers by createSqlBackend",
  graphTemplateRuntime:
    "spread directly into createGraphTemplateMembers by createSqlBackend",
  baseSchemaRuntime:
    "spread directly into createBaseSchemaMembers by createSqlBackend",
  indexMaterializationRuntime:
    "spread directly into createIndexMaterializationMembers by createSqlBackend",
  kindRemovalRuntime:
    "spread directly into createKindRemovalMembers by createSqlBackend",
  close:
    "read directly off `profile` and assigned to the backend's own close member",
} satisfies Record<DerivableEngineProfileKey, string>;

/**
 * Why each remaining key is captured by more than the profile head field
 * alone, so overriding the head field would leave some assembled member
 * reading the value a dialect's own closure captured instead.
 */
const NON_DERIVABLE_KEY_REASONS = {
  dialect: "the operation backend literal hardcodes it",
  tableNames: "captured by buildOperations and every transaction handle",
  execution: "captured by buildOperations and every transaction handle",
  strategy: "captured by buildOperations and every transaction handle",
  fulltext: "captured by buildOperations and every transaction handle",
  vector: "captured by buildOperations and every transaction handle",
  provisioning:
    "ensureTable and catalog are captured by migrations and transaction handles",
  assembly:
    "opaque, bundled-only; a derived profile carries the base's assembly by reference",
} satisfies Record<NonDerivableEngineProfileKey, string>;

async function createRealPostgresProfile(): Promise<
  ReturnType<typeof buildPostgresEngineProfile>
> {
  const client = await PGlite.create();
  cleanups.push(() => client.close());
  return buildPostgresEngineProfile(drizzlePg(client), { vector: false });
}

describe("the derivable/non-derivable engine-profile key partition", () => {
  it("DERIVABLE_ENGINE_PROFILE_KEYS matches DerivableEngineProfileKey's own pinned reason map", () => {
    expect([...DERIVABLE_ENGINE_PROFILE_KEYS].toSorted()).toEqual(
      Object.keys(DERIVABLE_KEY_REASONS).toSorted(),
    );
  });

  it("the derivable and non-derivable key lists do not overlap", () => {
    const derivable = new Set(DERIVABLE_ENGINE_PROFILE_KEYS);
    const nonDerivable = Object.keys(NON_DERIVABLE_KEY_REASONS);
    for (const key of nonDerivable) {
      expect(derivable.has(key as DerivableEngineProfileKey)).toBe(false);
    }
  });

  it("the two pinned lists together equal a REAL bundled profile's own enumerable keys, both directions", async () => {
    const bundledProfile = await createRealPostgresProfile();
    const pinnedKeys = [
      ...DERIVABLE_ENGINE_PROFILE_KEYS,
      ...Object.keys(NON_DERIVABLE_KEY_REASONS),
    ].toSorted();
    const bundledKeys = Object.keys(bundledProfile).toSorted();

    expect(pinnedKeys).toEqual(bundledKeys);
  });
});
