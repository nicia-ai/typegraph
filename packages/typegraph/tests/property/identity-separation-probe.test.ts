/**
 * The separation probe against the ledger it derives from.
 *
 * `areDifferent` and the `assertSame` contradiction precheck answer current
 * different-ness with one index probe on `typegraph_identity_separation`
 * instead of resolving both identity classes and scanning their `different`
 * assertions. The probe is only correct while the relation stays in step with
 * the ledger through every operation that can move a class — so this walks
 * generated assert / bulk-assert / retract / delete sequences and, after each
 * step, requires the probe's answer to equal the same answer recomputed from
 * the assertion ledger and the closure alone.
 *
 * The oracle here reads the assertion table and the closure and never the
 * separation relation, so breaking the probe cannot break the oracle with it.
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asNodeId,
  defineGraph,
  defineNode,
  type GraphBackend,
} from "../../src";
import { IdentityContradictionError } from "../../src/errors";
import {
  loadCurrentStructuralClasses,
  refKey,
} from "../../src/identity/service";
import { type PlainNodeRef } from "../../src/identity/sql-target";
import { asIdentityAssertionId } from "../../src/identity/types";
import { createSqlSchema } from "../../src/query/compiler/schema";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../src/query/sql-intent";
import { storeRuntime } from "../../src/store/runtime-port";
import { type Store } from "../../src/store/store";
import { compareCodePoints } from "../../src/utils/compare";
import { requireDefined } from "../../src/utils/presence";
import { createInitializedStore, createTestBackend } from "../test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Alias = defineNode("Alias", {
  schema: z.object({ name: z.string() }),
});

// No disjoint kinds anywhere in this graph: `areDifferent` is then driven by
// the separation answer alone, so a broken probe cannot be masked by the
// disjointness half of the same expression.
const graph = defineGraph({
  id: "identity_separation_probe",
  nodes: { Person: { type: Person }, Alias: { type: Alias } },
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

/** A store plus the raw backend the ledger oracle reads through. */
type Probe = Readonly<{
  store: Store<typeof graph>;
  backend: GraphBackend;
  graphId: string;
}>;

type Ref = Readonly<{ kind: "Person" | "Alias"; id: string }>;

const NODE_IDS = ["n0", "n1", "n2"] as const;
const KINDS = ["Person", "Alias"] as const;

const ALL_REFS: readonly Ref[] = KINDS.flatMap((kind) =>
  NODE_IDS.map((id) => ({ kind, id })),
);

type Pair = readonly [Ref, Ref];

type Operation =
  | Readonly<{ type: "assertSame"; pair: Pair }>
  | Readonly<{ type: "assertDifferent"; pair: Pair }>
  | Readonly<{ type: "bulkAssertSame"; pairs: readonly Pair[] }>
  | Readonly<{ type: "retract"; index: number }>
  | Readonly<{ type: "delete"; ref: Ref }>;

const refArbitrary: fc.Arbitrary<Ref> = fc.constantFrom(...ALL_REFS);

const pairArbitrary: fc.Arbitrary<Pair> = fc
  .tuple(refArbitrary, refArbitrary)
  .filter(([first, second]) => refKey(first) !== refKey(second));

const operationArbitrary: fc.Arbitrary<Operation> = fc.oneof(
  pairArbitrary.map((pair) => ({ type: "assertSame", pair }) as const),
  pairArbitrary.map((pair) => ({ type: "assertDifferent", pair }) as const),
  fc
    .array(pairArbitrary, { minLength: 1, maxLength: 3 })
    .map((pairs) => ({ type: "bulkAssertSame", pairs }) as const),
  fc.nat({ max: 15 }).map((index) => ({ type: "retract", index }) as const),
  refArbitrary.map((ref) => ({ type: "delete", ref }) as const),
);

type RawAssertionRow = Readonly<{
  id: string;
  rel: string;
  a_kind: string;
  a_id: string;
  b_kind: string;
  b_id: string;
}>;

/** Every assertion the ledger currently holds open, in a stable order. */
async function currentLedgerAssertions(
  probe: Probe,
): Promise<readonly RawAssertionRow[]> {
  const schema = createSqlSchema(probe.backend.tableNames);
  const rows = await probe.backend.execute<RawAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT id, rel, a_kind, a_id, b_kind, b_id
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${probe.graphId}
        AND valid_to IS NULL
        AND deleted_at IS NULL
    `),
  );
  return rows.toSorted((left, right) => compareCodePoints(left.id, right.id));
}

/** The current identity class of each reference, straight from the closure. */
async function currentClassMembers(
  probe: Probe,
  references: readonly Ref[],
): Promise<(reference: Ref) => ReadonlySet<string>> {
  const classes = await loadCurrentStructuralClasses(
    probe.backend,
    createSqlSchema(probe.backend.tableNames),
    probe.graphId,
    references,
  );
  return (reference: Ref) =>
    new Set(
      requireDefined(classes.get(refKey(reference))).map(
        (member: PlainNodeRef) => refKey(member),
      ),
    );
}

/**
 * The computation the probe replaced: the ids of every current `different`
 * assertion whose endpoints straddle the two references' identity classes.
 */
async function ledgerSeparatingAssertionIds(
  probe: Probe,
  first: Ref,
  second: Ref,
): Promise<readonly string[]> {
  const membersOf = await currentClassMembers(probe, [first, second]);
  const firstMembers = membersOf(first);
  const secondMembers = membersOf(second);
  const assertions = await currentLedgerAssertions(probe);
  return assertions
    .filter((assertion) => {
      if (assertion.rel !== "different") return false;
      const a = refKey({ kind: assertion.a_kind, id: assertion.a_id });
      const b = refKey({ kind: assertion.b_kind, id: assertion.b_id });
      return (
        (firstMembers.has(a) && secondMembers.has(b)) ||
        (firstMembers.has(b) && secondMembers.has(a))
      );
    })
    .map((assertion) => assertion.id);
}

async function shareCurrentClass(
  probe: Probe,
  first: Ref,
  second: Ref,
): Promise<boolean> {
  const membersOf = await currentClassMembers(probe, [first, second]);
  return membersOf(first).has(refKey(second));
}

function currentAssertionFor(
  assertions: readonly RawAssertionRow[],
  relation: "same" | "different",
  first: Ref,
  second: Ref,
): RawAssertionRow | undefined {
  const firstKey = refKey(first);
  const secondKey = refKey(second);
  return assertions.find((assertion) => {
    if (assertion.rel !== relation) return false;
    const a = refKey({ kind: assertion.a_kind, id: assertion.a_id });
    const b = refKey({ kind: assertion.b_kind, id: assertion.b_id });
    return (
      (a === firstKey && b === secondKey) || (a === secondKey && b === firstKey)
    );
  });
}

type Outcome =
  Readonly<{ action: "created" | "existing" }> | Readonly<{ error: unknown }>;

async function attemptAssertion(
  attempt: () => Promise<Readonly<{ action: "created" | "existing" }>>,
): Promise<Outcome> {
  try {
    const result = await attempt();
    return { action: result.action };
  } catch (error) {
    return { error };
  }
}

function contradictionIn(outcome: Outcome): IdentityContradictionError {
  if ("action" in outcome) {
    throw new Error(
      `Expected an identity contradiction; the write was ${outcome.action}.`,
    );
  }
  // Anything else is rethrown untouched, so an unexpected failure reports
  // itself rather than being flattened into "not a contradiction".
  if (!(outcome.error instanceof IdentityContradictionError))
    throw outcome.error;
  return outcome.error;
}

/**
 * The `assertSame` precheck, differentially: predict the outcome from the
 * ledger, then require the write to produce exactly that outcome.
 */
async function expectAssertSameMatchesLedger(
  probe: Probe,
  [first, second]: Pair,
): Promise<void> {
  const assertions = await currentLedgerAssertions(probe);
  const existing = currentAssertionFor(assertions, "same", first, second);
  const separating = await ledgerSeparatingAssertionIds(probe, first, second);
  const outcome = await attemptAssertion(() =>
    probe.store.identity.assertSame(first, second),
  );

  if (existing !== undefined) {
    expect(outcome).toEqual({ action: "existing" });
    return;
  }
  if (separating.length === 0) {
    expect(outcome).toEqual({ action: "created" });
    return;
  }
  const error = contradictionIn(outcome);
  expect(error.details.reason).toBe("different-assertion");
  // Which witness the refusal names is the ledger's row order, not something
  // the oracle can pin; that it names one of the separating assertions is.
  expect(separating).toContain(error.details.conflictingAssertionId);
}

/** The unchanged `assertDifferent` branch, held to the same standard. */
async function expectAssertDifferentMatchesLedger(
  probe: Probe,
  [first, second]: Pair,
): Promise<void> {
  const assertions = await currentLedgerAssertions(probe);
  const existing = currentAssertionFor(assertions, "different", first, second);
  const shared = await shareCurrentClass(probe, first, second);
  const outcome = await attemptAssertion(() =>
    probe.store.identity.assertDifferent(first, second),
  );

  if (existing !== undefined) {
    expect(outcome).toEqual({ action: "existing" });
    return;
  }
  if (!shared) {
    expect(outcome).toEqual({ action: "created" });
    return;
  }
  expect(contradictionIn(outcome).details.reason).toBe("same-class");
}

async function expectProbeAgreesWithLedger(
  probe: Probe,
  live: readonly Ref[],
): Promise<void> {
  for (const [index, first] of live.entries()) {
    for (const second of live.slice(index + 1)) {
      const separating = await ledgerSeparatingAssertionIds(
        probe,
        first,
        second,
      );
      // Compared as one object so a failure names the pair it disagreed on.
      expect({
        first,
        second,
        areDifferent: await probe.store.identity.areDifferent(first, second),
      }).toEqual({ first, second, areDifferent: separating.length > 0 });
    }
  }
}

function collectionFor(probe: Probe, ref: Ref) {
  return ref.kind === "Person" ?
      probe.store.nodes.Person
    : probe.store.nodes.Alias;
}

async function applyOperation(
  probe: Probe,
  operation: Operation,
  live: Set<string>,
): Promise<void> {
  switch (operation.type) {
    case "assertSame": {
      if (!operation.pair.every((ref) => live.has(refKey(ref)))) return;
      await expectAssertSameMatchesLedger(probe, operation.pair);
      return;
    }
    case "assertDifferent": {
      if (!operation.pair.every((ref) => live.has(refKey(ref)))) return;
      await expectAssertDifferentMatchesLedger(probe, operation.pair);
      return;
    }
    case "bulkAssertSame": {
      // Bulk writes validate against an in-memory simulation rather than the
      // probe. They are here as a state builder: their closure repair is what
      // has to leave the separation relation correct for the next probe.
      const pairs = operation.pairs.filter((pair) =>
        pair.every((ref) => live.has(refKey(ref))),
      );
      if (pairs.length === 0) return;
      try {
        await probe.store.identity.bulkAssertSame(
          pairs.map(([a, b]) => ({ a, b })),
        );
      } catch (error) {
        if (!(error instanceof IdentityContradictionError)) throw error;
      }
      return;
    }
    case "retract": {
      const assertions = await currentLedgerAssertions(probe);
      if (assertions.length === 0) return;
      const target = requireDefined(
        assertions[operation.index % assertions.length],
      );
      await probe.store.identity.retractAssertion(
        asIdentityAssertionId(target.id),
      );
      return;
    }
    case "delete": {
      const key = refKey(operation.ref);
      if (!live.has(key)) return;
      await collectionFor(probe, operation.ref).delete(
        asNodeId(operation.ref.id),
      );
      live.delete(key);
      return;
    }
  }
}

async function runScenario(operations: readonly Operation[]): Promise<void> {
  const backend = createTestBackend();
  const store = await createInitializedStore(graph, backend);
  const probe: Probe = { store, backend, graphId: store.graphId };
  for (const ref of ALL_REFS) {
    await collectionFor(probe, ref).create(
      { name: `${ref.kind}-${ref.id}` },
      { id: ref.id },
    );
  }
  const live = new Set(ALL_REFS.map((ref) => refKey(ref)));
  const liveReferences = (): readonly Ref[] =>
    ALL_REFS.filter((ref) => live.has(refKey(ref)));

  await expectProbeAgreesWithLedger(probe, liveReferences());
  for (const operation of operations) {
    await applyOperation(probe, operation, live);
    await expectProbeAgreesWithLedger(probe, liveReferences());
  }

  // The relation must still equal the ledger's projection at the end: an
  // agreeing probe over a relation that drifted with the ledger would be a
  // pair of matching wrong answers.
  await expect(storeRuntime(store).validateIdentity()).resolves.toBeUndefined();
}

describe("separation probe versus the assertion ledger", () => {
  it("answers every current different-ness read exactly as the ledger does", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operationArbitrary, { minLength: 1, maxLength: 8 }),
        async (operations) => {
          await runScenario(operations);
        },
      ),
      { numRuns: 40 },
    );
  });

  it("keeps the probe correct across a fold, a fusion and a retraction", async () => {
    // A scenario the generator would only reach by luck: the same-id fold puts
    // Person/n0 and Alias/n0 in one class before any assertion exists, a
    // separation is asserted against that class, both sides then grow, an
    // assertion is retracted out from under them, and an endpoint leaves.
    const personZero = { kind: "Person", id: "n0" } as const;
    const aliasZero = { kind: "Alias", id: "n0" } as const;
    const aliasTwo = { kind: "Alias", id: "n2" } as const;
    const personOne = { kind: "Person", id: "n1" } as const;
    const personTwo = { kind: "Person", id: "n2" } as const;
    await runScenario([
      { type: "assertDifferent", pair: [personZero, personOne] },
      { type: "assertSame", pair: [personOne, personTwo] },
      { type: "assertSame", pair: [aliasZero, aliasTwo] },
      { type: "retract", index: 0 },
      { type: "delete", ref: personTwo },
    ]);
  });
});
