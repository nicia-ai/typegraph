import { describe, expect, it } from "vitest";

import { type GraphBackend } from "../../../src";
import { IdentitySeparationViolationError } from "../../../src/errors";
import { identityClassKey } from "../../../src/identity/separation";
import {
  loadCurrentStructuralClasses,
  refKey,
} from "../../../src/identity/service";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import { storeRuntime } from "../../../src/store/runtime-port";
import { compareCodePoints } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

/**
 * The database-level contradiction backstop.
 *
 * Every other identity guard is code deciding whether a write is legal. This
 * suite drives contradictions in through paths that skip those decisions —
 * raw INSERTs straight into the assertion ledger, the way a planner bug or a
 * hand-run repair script would — and asserts the ENGINE refuses the resulting
 * transaction. The refusal must look identical on every backend, so these cases
 * belong to the shared cross-backend suite rather than a per-dialect file.
 */

type Ref = Readonly<{ kind: string; id: string }>;

type IntegrationStoreLike = Readonly<{
  backend: GraphBackend;
  graphId: string;
}>;

function compareReferences(left: Ref, right: Ref): number {
  const byKind = compareCodePoints(left.kind, right.kind);
  return byKind === 0 ? compareCodePoints(left.id, right.id) : byKind;
}

function requireStatementBackend(
  backend: GraphBackend,
): NonNullable<GraphBackend["executeStatement"]> {
  const executeStatement = backend.executeStatement;
  if (executeStatement === undefined) {
    throw new Error("Integration backend cannot execute raw statements");
  }
  return executeStatement;
}

/**
 * Writes an assertion row straight into the ledger, skipping every validation
 * the identity facade would run. This is the bypass the backstop exists for:
 * the ledger now claims something no application call could have asserted.
 */
async function injectLedgerAssertion(
  store: IntegrationStoreLike,
  relation: "same" | "different",
  first: Ref,
  second: Ref,
): Promise<string> {
  const schema = createSqlSchema(store.backend.tableNames);
  const executeStatement = requireStatementBackend(store.backend);
  const [a, b] =
    compareReferences(first, second) <= 0 ? [first, second] : [second, first];
  const id = `injected-${relation}-${a.id}-${b.id}`;
  const now = new Date().toISOString();
  await executeStatement(
    asCompiledStatementSql(sql`
      INSERT INTO ${schema.identityAssertionsTable} (
        graph_id, id, rel, a_kind, a_id, b_kind, b_id,
        valid_from, valid_to, created_at, updated_at, deleted_at
      ) VALUES (
        ${store.graphId}, ${id}, ${relation}, ${a.kind}, ${a.id}, ${b.kind}, ${b.id},
        ${now}, NULL, ${now}, ${now}, NULL
      )
    `),
  );
  return id;
}

type RawSeparationRow = Readonly<{
  class_key_low: string;
  class_key_high: string;
}>;

async function readSeparationRows(
  store: IntegrationStoreLike,
): Promise<readonly RawSeparationRow[]> {
  const schema = createSqlSchema(store.backend.tableNames);
  const rows = await store.backend.execute<RawSeparationRow>(
    asCompiledRowsSql(sql`
      SELECT class_key_low, class_key_high
      FROM ${schema.identitySeparationTable}
      WHERE graph_id = ${store.graphId}
    `),
  );
  return rows.map((row) => ({
    class_key_low: row.class_key_low,
    class_key_high: row.class_key_high,
  }));
}

type RawLedgerAssertionRow = Readonly<{
  id: string;
  a_kind: string;
  a_id: string;
  b_kind: string;
  b_id: string;
}>;

/**
 * The computation the separation probe replaced, rebuilt here from the ledger:
 * every CURRENT `different` assertion, scanned for one whose endpoints land on
 * opposite sides of the two nodes' identity classes.
 *
 * It reads the assertion table and the closure and never touches the separation
 * relation, so it is an independent oracle for what the probe now answers.
 */
async function ledgerSeparatingAssertionIds(
  store: IntegrationStoreLike,
  first: Ref,
  second: Ref,
): Promise<readonly string[]> {
  const schema = createSqlSchema(store.backend.tableNames);
  const classes = await loadCurrentStructuralClasses(
    store.backend,
    schema,
    store.graphId,
    [first, second],
  );
  const memberKeys = (ref: Ref): ReadonlySet<string> =>
    new Set(
      requireDefined(classes.get(refKey(ref))).map((member) => refKey(member)),
    );
  const firstKeys = memberKeys(first);
  const secondKeys = memberKeys(second);
  const rows = await store.backend.execute<RawLedgerAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT id, a_kind, a_id, b_kind, b_id
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${store.graphId}
        AND rel = ${"different"}
        AND valid_to IS NULL
        AND deleted_at IS NULL
    `),
  );
  return rows
    .filter((row) => {
      const a = refKey({ kind: row.a_kind, id: row.a_id });
      const b = refKey({ kind: row.b_kind, id: row.b_id });
      return (
        (firstKeys.has(a) && secondKeys.has(b)) ||
        (firstKeys.has(b) && secondKeys.has(a))
      );
    })
    .map((row) => row.id);
}

function separationPairOf(low: Ref, high: Ref): RawSeparationRow {
  const [first, second] =
    compareCodePoints(identityClassKey(low), identityClassKey(high)) <= 0 ?
      [low, high]
    : [high, low];
  return {
    class_key_low: identityClassKey(first),
    class_key_high: identityClassKey(second),
  };
}

export function registerIdentitySeparationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("identity separation backstop", () => {
    it("provisions the ordered-pair constraint on the separation relation", async () => {
      const store = context.getStore();
      const schema = createSqlSchema(store.backend.tableNames);
      const executeStatement = requireStatementBackend(store.backend);

      // A degenerate pair is what a fused-but-separated class collapses to.
      // The engine must refuse it with no TypeGraph code in the way.
      await expect(
        executeStatement(
          asCompiledStatementSql(sql`
            INSERT INTO ${schema.identitySeparationTable} (
              graph_id, class_key_low, class_key_high
            ) VALUES (${store.graphId}, ${"same-key"}, ${"same-key"})
          `),
        ),
      ).rejects.toThrow();

      expect(await readSeparationRows(store)).toEqual([]);
    });

    it("materializes one row per separated class pair and relabels it on a fuse", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const alias = await store.nodes.Person.create({ name: "Ally" });
      const bob = await store.nodes.Person.create({ name: "Bob" });

      await store.identity.assertDifferent(alice, bob);
      expect(await readSeparationRows(store)).toEqual([
        separationPairOf(alice, bob),
      ]);

      await store.identity.assertSame(alice, alias);
      const fusedClass = requireDefined(
        await store.identity.representativeOf(alice),
      );

      expect(await readSeparationRows(store)).toEqual([
        separationPairOf(fusedClass, bob),
      ]);
      await expect(
        storeRuntime(store).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("keeps the pair while any assertion still separates the classes", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const alias = await store.nodes.Person.create({ name: "Ally" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.identity.assertSame(alice, alias);

      await store.identity.assertDifferent(alice, bob);
      await store.identity.assertDifferent(alias, bob);
      const fusedClass = requireDefined(
        await store.identity.representativeOf(alice),
      );

      // Two assertions, one separated class pair: the relation records the
      // separation, not its witnesses.
      expect(await readSeparationRows(store)).toEqual([
        separationPairOf(fusedClass, bob),
      ]);

      await store.identity.retractDifferentAssertion(alice, bob);
      expect(await readSeparationRows(store)).toEqual([
        separationPairOf(fusedClass, bob),
      ]);

      await store.identity.retractDifferentAssertion(alias, bob);
      expect(await readSeparationRows(store)).toEqual([]);
    });

    it("re-keys the pair onto the surviving class when a fuse is retracted", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const alias = await store.nodes.Person.create({ name: "Ally" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.identity.assertSame(alice, alias);
      await store.identity.assertDifferent(alias, bob);

      await store.identity.retractSameAssertion(alice, alias);

      // The `different` assertion names `alias`, so the split leaves it
      // separating alias-alone from bob — never the retired fused key.
      expect(await readSeparationRows(store)).toEqual([
        separationPairOf(alias, bob),
      ]);
      await expect(
        storeRuntime(store).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("aborts a class fusion the ledger bypass made contradictory", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const alias = await store.nodes.Person.create({ name: "Ally" });
      const rival = await store.nodes.Person.create({ name: "Rival" });
      const outsider = await store.nodes.Person.create({ name: "Outsider" });

      await store.identity.assertSame(alice, alias);
      const { assertion: separation } = await store.identity.assertDifferent(
        alice,
        rival,
      );

      // The bypass: a `same` assertion nothing validated. Every code-level
      // guard reads the materialized closure, which this write does not touch,
      // so the contradiction stays invisible to them.
      await injectLedgerAssertion(store, "same", alias, rival);
      expect(await store.identity.areSame(alias, rival)).toBe(false);

      // A perfectly ordinary fusion. Its closure repair recomputes the class
      // from the ledger, which absorbs `rival` — and the separation relabel
      // that rides along with it collapses the separated pair onto one key.
      const failure = await store.identity
        .bulkAssertSame([{ a: alias, b: outsider }])
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(IdentitySeparationViolationError);
      expect(
        (failure as IdentitySeparationViolationError).details,
      ).toMatchObject({
        enforcedBy: "database",
        graphId: store.graphId,
        assertionId: separation.id,
      });

      // Aborted, not partially applied: the fusion never reached the ledger.
      expect(await store.identity.areSame(alias, outsider)).toBe(false);
      expect(await store.identity.assertionsOf(outsider)).toEqual([]);
    });

    it("aborts a separation write contradicted by an injected class", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const alias = await store.nodes.Person.create({ name: "Ally" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.identity.assertSame(alice, alias);

      // A `different` assertion inside one identity class: the contradiction
      // the ledger is not allowed to hold, injected past validation.
      const injectedId = await injectLedgerAssertion(
        store,
        "different",
        alice,
        alias,
      );

      const failure = await store.identity
        .assertDifferent(alice, bob)
        .catch((error: unknown) => error);

      expect(failure).toBeInstanceOf(IdentitySeparationViolationError);
      expect(
        (failure as IdentitySeparationViolationError).details,
      ).toMatchObject({ enforcedBy: "database", assertionId: injectedId });
      expect(await store.identity.areDifferent(alice, bob)).toBe(false);
    });

    it("clears separation rows for a node that leaves the graph", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.identity.assertDifferent(alice, bob);

      await store.nodes.Person.delete(bob.id);

      expect(await readSeparationRows(store)).toEqual([]);
      await expect(
        storeRuntime(store).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("rebuilds the separation relation from the ledger alone", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const alias = await store.nodes.Person.create({ name: "Ally" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.identity.assertSame(alice, alias);
      await store.identity.assertDifferent(alias, bob);
      const expected = await readSeparationRows(store);

      const schema = createSqlSchema(store.backend.tableNames);
      const executeStatement = requireStatementBackend(store.backend);
      await executeStatement(
        asCompiledStatementSql(sql`
          DELETE FROM ${schema.identitySeparationTable}
          WHERE graph_id = ${store.graphId}
        `),
      );
      await expect(
        storeRuntime(store).validateIdentity(),
      ).rejects.toMatchObject({
        details: { code: "IDENTITY_SCHEMA_CONTRADICTION" },
      });

      await storeRuntime(store).rebuildIdentityClosure();

      expect(await readSeparationRows(store)).toEqual(expected);
      await expect(
        storeRuntime(store).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("answers current different-ness from the relation, agreeing with the ledger throughout a lifecycle", async () => {
      const store = context.getStore();
      // `sameIdAcrossKinds: "fold"` makes the shared id a structural same
      // assertion nobody wrote, so the walk below covers class formation by
      // fold as well as by assertion.
      const alice = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "shared" },
      );
      const acme = await store.nodes.Company.create(
        { name: "Acme" },
        { id: "shared" },
      );
      const bob = await store.nodes.Person.create({ name: "Bob" }, { id: "b" });
      const carol = await store.nodes.Person.create(
        { name: "Carol" },
        { id: "c" },
      );
      const dave = await store.nodes.Person.create(
        { name: "Dave" },
        { id: "d" },
      );
      const references = [
        { kind: "Person", id: "shared" },
        { kind: "Company", id: "shared" },
        { kind: "Person", id: "b" },
        { kind: "Person", id: "c" },
        { kind: "Person", id: "d" },
      ] as const satisfies readonly Ref[];

      async function expectProbeAgreesWithLedger(
        live: readonly (typeof references)[number][],
      ): Promise<void> {
        for (const [index, first] of live.entries()) {
          for (const second of live.slice(index + 1)) {
            const separating = await ledgerSeparatingAssertionIds(
              store,
              first,
              second,
            );
            expect({
              first,
              second,
              different: await store.identity.areDifferent(first, second),
            }).toEqual({ first, second, different: separating.length > 0 });
          }
        }
      }

      await expectProbeAgreesWithLedger(references);

      const { assertion: separation } = await store.identity.assertDifferent(
        alice,
        bob,
      );
      await expectProbeAgreesWithLedger(references);

      // The fused class inherits the separation: `acme` shares `alice`'s class
      // through the fold, and `carol` joins it by assertion.
      await store.identity.assertSame(alice, carol);
      await expectProbeAgreesWithLedger(references);

      // The precheck must refuse exactly what the ledger says it should, with
      // the assertion the ledger names.
      const conflict = await store.identity
        .assertSame(acme, bob)
        .catch((error: unknown) => error);
      expect(conflict).toMatchObject({
        details: {
          operation: "assertSame",
          reason: "different-assertion",
          conflictingAssertionId: separation.id,
        },
      });
      expect(
        await ledgerSeparatingAssertionIds(store, acme, bob),
      ).toStrictEqual([separation.id]);

      // A second witness for the same class pair: the relation records one row
      // for both, so retracting one must not clear the separation.
      const { assertion: second } = await store.identity.assertDifferent(
        carol,
        bob,
      );
      await expectProbeAgreesWithLedger(references);
      await store.identity.retractAssertion(second.id);
      await expectProbeAgreesWithLedger(references);

      await store.identity.retractAssertion(separation.id);
      await expectProbeAgreesWithLedger(references);

      // Deleting an endpoint retires the assertion and the relation row with it.
      await store.identity.assertDifferent(dave, bob);
      await expectProbeAgreesWithLedger(references);
      await store.nodes.Person.delete(dave.id);
      await expectProbeAgreesWithLedger(
        references.filter((ref) => ref.id !== dave.id),
      );

      await expect(
        storeRuntime(store).validateIdentity(),
      ).resolves.toBeUndefined();
    });

    it("refuses a different-ness read when the separation relation is gone", async () => {
      const store = context.getStore();
      const schema = createSqlSchema(store.backend.tableNames);
      const executeStatement = requireStatementBackend(store.backend);
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      await store.identity.assertDifferent(alice, bob);

      // Renamed rather than dropped, and put back in a `finally`: backends
      // whose harness resets by TRUNCATE over a fixed table list cannot recover
      // from a relation this test destroyed.
      const stashed = `${schema.tables.identitySeparation}_stashed`;
      await executeStatement(
        asCompiledStatementSql(sql`
          ALTER TABLE ${schema.identitySeparationTable}
          RENAME TO ${sql.identifier(stashed)}
        `),
      );
      try {
        // Not `false`. The ledger still says these two are held apart, and a
        // read that cannot consult the relation has no basis for any answer.
        const missing = {
          details: {
            code: "IDENTITY_STORAGE_MISSING",
            graphId: store.graphId,
            tables: [schema.tables.identitySeparation],
          },
        };
        await expect(
          store.identity.areDifferent(alice, bob),
        ).rejects.toMatchObject(missing);
        await expect(
          store.identity.assertSame(alice, bob),
        ).rejects.toMatchObject(missing);
      } finally {
        await executeStatement(
          asCompiledStatementSql(sql`
            ALTER TABLE ${sql.identifier(stashed)}
            RENAME TO ${schema.identitySeparationTable}
          `),
        );
      }

      // Restored, and the refused write left nothing behind.
      expect(await store.identity.areDifferent(alice, bob)).toBe(true);
      await expect(
        storeRuntime(store).validateIdentity(),
      ).resolves.toBeUndefined();
    });
  });
}
