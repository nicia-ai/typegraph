/**
 * Rebuild equivalence: the STORED derived rows equal what the library's own
 * rebuild produces from the surviving base rows.
 *
 * The other model suites compare what READS observe with a model. A derived
 * row that depends on operation history but that every read filters out — a
 * class canonical chosen by insertion order, a separation row left behind by a
 * retired class key, a fulltext row for a node whose content moved on — passes
 * all of them. This suite reads the derived tables directly instead:
 *
 * 1. run a random sequence of the writes that maintain each derived relation
 *    (node create / update / soft delete / hard delete and their bulk forms,
 *    validity-window end and reopen, edge writes, identity assert / retract /
 *    unassert in single and bulk form, windowed identity assertions,
 *    provenance retract / unRetract, and the clock moving past window ends);
 * 2. at random interior points and at the end, snapshot every derived table
 *    as raw rows in canonical order;
 * 3. run the rebuild in place — `rebuildIdentityClosure` for the closure and
 *    separation relations, the destructive `rebuildContribution("fulltext")`
 *    for the fulltext projection and its durable markers — and snapshot again;
 * 4. require the two snapshots to be equal, row for row.
 *
 * Two fixtures drive it. The identity fixture enables identity, history and
 * provenance, so every derived relation is maintained; each of those settings
 * routes a node create away from the fused root command. The root-fusion
 * fixture turns them off and lets the store generate node ids, so a create of
 * a searchable kind writes its fulltext row through the fused `node.create`
 * command. On a lane whose root fuses creates, the property proves from the
 * command trace that one did before it compares the rows with the rebuild.
 *
 * Columns that record WHEN a row was written rather than WHAT it derives
 * (`updated_at`, `materialized_at`, `last_attempted_at`) and the PostgreSQL
 * generated `tsv` column are the only exclusions; each is named in
 * {@link snapshotDerived}. Relations without a library rebuild (unique and
 * edge claim reservations, which keep tombstoned and takeover-in-place rows by
 * design) are out of scope here; `dumpRoundTripState` covers their standing
 * subset.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  searchable,
  type Store,
} from "../../src";
import { createPostgresBackend } from "../../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { DEPLOYMENT_CONTRIBUTION_GRAPH_ID } from "../../src/backend/table-contribution";
import { type GraphBackend } from "../../src/backend/types";
import type { TypeGraphError } from "../../src/errors";
import {
  EndpointNotFoundError,
  IdentityContradictionError,
  IdentityEndpointValidityError,
  NodeNotFoundError,
  RestrictedDeleteError,
  UniquenessError,
  ValidationError,
} from "../../src/errors";
import { asIdentityAssertionId } from "../../src/identity/types";
import {
  type IdentityAssertionId,
  rebuildIdentityClosure,
} from "../../src/identity-entry";
import { createRetractionCapability } from "../../src/provenance";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../src/query/sql-intent";
import { storeBackend } from "../../src/store/runtime-port";
import type { HistoryStore } from "../../src/store-entry";
import { compareStrings } from "../../src/utils/compare";
import { requireDefined } from "../../src/utils/presence";
import { propertyRuns } from "./run-budget";

// ============================================================
// Graph
// ============================================================

const Person = defineNode("Person", {
  schema: z.object({ name: searchable(), email: z.string() }),
});
const Robot = defineNode("Robot", {
  schema: z.object({ label: searchable() }),
});
const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const Fact = defineNode("Fact", { schema: z.object({ code: searchable() }) });
const Justification = defineNode("Justification", {
  schema: z.object({ label: z.string() }),
});

const knows = defineEdge("knows");
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const NODES = {
  Person: {
    type: Person,
    unique: [
      {
        name: "person_email",
        fields: ["email"],
        scope: "kind",
        collation: "binary",
      },
    ],
  },
  Robot: { type: Robot },
  Source: { type: Source },
  Fact: { type: Fact },
  Justification: { type: Justification },
} as const;

const EDGES = {
  knows: { type: knows, from: [Person], to: [Person] },
  premiseOf: { type: premiseOf, from: [Source, Fact], to: [Justification] },
  derives: { type: derives, from: [Justification], to: [Fact] },
} as const;

function buildGraph(id: string, sameIdAcrossKinds: "fold" | "ignore") {
  return defineGraph({
    id,
    nodes: NODES,
    edges: EDGES,
    identity: { sameIdAcrossKinds },
  });
}

/**
 * The same kinds without identity. Robot and Fact are searchable and carry no
 * unique constraint, so their generated-id creates are fused-root eligible;
 * Person keeps its unique constraint and takes the portable path.
 */
function buildFusionGraph(id: string) {
  return defineGraph({ id, nodes: NODES, edges: EDGES });
}

type RebuildGraph = ReturnType<typeof buildGraph>;
type RebuildStore = HistoryStore<RebuildGraph>;
type FusionStore = Store<ReturnType<typeof buildFusionGraph>>;

/**
 * What a write runs through: the store itself, or the context of a
 * caller-owned transaction (`store.transaction(async (tx) => ...)`).
 * `identity` is absent on the root-fusion fixture, which never generates an
 * identity write.
 */
type WriteSurface = Readonly<{
  data: Pick<FusionStore, "nodes" | "edges">;
  identity: RebuildStore["identity"] | undefined;
  inTransaction: boolean;
}>;

const PROVENANCE_CONFIG = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Fact"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

// ============================================================
// Operations
// ============================================================

/** The node kinds the generic node operations write. */
const WRITABLE_KINDS = ["Person", "Robot", "Fact"] as const;
type WritableKind = (typeof WRITABLE_KINDS)[number];

/** The kinds identity assertions name. Facts join through provenance. */
const IDENTITY_KINDS = ["Person", "Robot", "Fact"] as const;
type IdentityKind = (typeof IDENTITY_KINDS)[number];

/** Few ids so writes collide: same id across kinds, re-creation after delete. */
const IDS = ["n0", "n1", "n2", "n3"] as const;
const WORDS = ["alpha", "beta", "gamma", "delta"] as const;
const SOURCES = ["s0", "s1"] as const;

const START_INSTANT = new Date("2030-01-01T00:00:00.000Z");
/** A window end opened by an operation lands this far after "now". */
const WINDOW_LENGTH_MS = 30 * 60 * 1000;
/** One clock step, long enough to carry every open window end into the past. */
const CLOCK_STEP_MS = 60 * 60 * 1000;

type Ref = Readonly<{ kind: IdentityKind; id: string }>;

/** A write through the store or a transaction context. */
type WriteOp =
  | Readonly<{ type: "create"; kind: WritableKind; id: number; word: number }>
  | Readonly<{ type: "update"; kind: WritableKind; id: number; word: number }>
  | Readonly<{ type: "softDelete"; kind: WritableKind; id: number }>
  | Readonly<{ type: "hardDelete"; kind: WritableKind; id: number }>
  | Readonly<{
      type: "bulkCreate" | "bulkUpsert";
      kind: WritableKind;
      ids: readonly number[];
      word: number;
    }>
  | Readonly<{
      type: "bulkSoftDelete" | "bulkHardDelete";
      kind: WritableKind;
      ids: readonly number[];
    }>
  | Readonly<{ type: "endWindow"; kind: WritableKind; id: number }>
  | Readonly<{ type: "reopenWindow"; kind: WritableKind; id: number }>
  | Readonly<{ type: "createEdge"; from: number; to: number }>
  | Readonly<{ type: "deleteEdge"; from: number; to: number; hard: boolean }>
  | Readonly<{
      type: "assert";
      relation: "same" | "different";
      a: Ref;
      b: Ref;
      windowed: boolean;
    }>
  | Readonly<{
      type: "bulkAssert";
      relation: "same" | "different";
      pairs: readonly (readonly [Ref, Ref])[];
    }>
  | Readonly<{ type: "retract"; pick: number }>
  | Readonly<{ type: "bulkRetract"; picks: readonly number[] }>
  | Readonly<{
      type: "unassert";
      relation: "same" | "different";
      a: Ref;
      b: Ref;
    }>;

type Op =
  | Readonly<{ type: "write"; write: WriteOp }>
  | Readonly<{ type: "transaction"; writes: readonly WriteOp[] }>
  | Readonly<{ type: "retractSource"; source: number }>
  | Readonly<{ type: "unRetractSource"; source: number }>
  | Readonly<{ type: "advanceClock" }>
  | Readonly<{ type: "checkpoint" }>;

const kindArb = fc.constantFrom(...WRITABLE_KINDS);
const idArb = fc.nat({ max: IDS.length - 1 });
const wordArb = fc.nat({ max: WORDS.length - 1 });
const idsArb = fc.uniqueArray(idArb, { minLength: 1, maxLength: 3 });
const refArb: fc.Arbitrary<Ref> = fc.record({
  kind: fc.constantFrom(...IDENTITY_KINDS),
  id: fc.constantFrom(...IDS),
});
const relationArb = fc.constantFrom("same" as const, "different" as const);
const sourceArb = fc.nat({ max: SOURCES.length - 1 });

/** Node and edge writes: every fixture generates these. */
const DATA_WRITE_ARBS: readonly fc.WeightedArbitrary<WriteOp>[] = [
  {
    arbitrary: fc.record({
      type: fc.constant("create" as const),
      kind: kindArb,
      id: idArb,
      word: wordArb,
    }),
    weight: 4,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("update" as const),
      kind: kindArb,
      id: idArb,
      word: wordArb,
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("softDelete" as const),
      kind: kindArb,
      id: idArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("hardDelete" as const),
      kind: kindArb,
      id: idArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constantFrom("bulkCreate" as const, "bulkUpsert" as const),
      kind: kindArb,
      ids: idsArb,
      word: wordArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constantFrom(
        "bulkSoftDelete" as const,
        "bulkHardDelete" as const,
      ),
      kind: kindArb,
      ids: idsArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("endWindow" as const),
      kind: kindArb,
      id: idArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("reopenWindow" as const),
      kind: kindArb,
      id: idArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("createEdge" as const),
      from: idArb,
      to: idArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("deleteEdge" as const),
      from: idArb,
      to: idArb,
      hard: fc.boolean(),
    }),
    weight: 1,
  },
];

/** Identity writes: only the identity fixture generates these. */
const IDENTITY_WRITE_ARBS: readonly fc.WeightedArbitrary<WriteOp>[] = [
  {
    arbitrary: fc.record({
      type: fc.constant("assert" as const),
      relation: relationArb,
      a: refArb,
      b: refArb,
      windowed: fc.boolean(),
    }),
    // Heaviest: a class canonical only depends on history once one class
    // has absorbed another and then meets a third.
    weight: 8,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("bulkAssert" as const),
      relation: relationArb,
      pairs: fc.array(fc.tuple(refArb, refArb), {
        minLength: 1,
        maxLength: 3,
      }),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("retract" as const),
      pick: fc.nat(),
    }),
    weight: 2,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("bulkRetract" as const),
      picks: fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("unassert" as const),
      relation: relationArb,
      a: refArb,
      b: refArb,
    }),
    weight: 1,
  },
];

/** Provenance transitions: only the identity fixture (history on) has them. */
const PROVENANCE_OP_ARBS: readonly fc.WeightedArbitrary<Op>[] = [
  {
    arbitrary: fc.record({
      type: fc.constant("retractSource" as const),
      source: sourceArb,
    }),
    weight: 1,
  },
  {
    arbitrary: fc.record({
      type: fc.constant("unRetractSource" as const),
      source: sourceArb,
    }),
    weight: 1,
  },
];

function opArbitrary(
  writeArbs: readonly fc.WeightedArbitrary<WriteOp>[],
  extraOpArbs: readonly fc.WeightedArbitrary<Op>[],
): fc.Arbitrary<Op> {
  const writeOpArb = fc.oneof(...writeArbs);
  return fc.oneof(
    {
      arbitrary: writeOpArb.map((write) => ({ type: "write" as const, write })),
      weight: 20,
    },
    ...extraOpArbs,
    {
      arbitrary: fc.record({ type: fc.constant("advanceClock" as const) }),
      weight: 1,
    },
    {
      arbitrary: fc.record({ type: fc.constant("checkpoint" as const) }),
      weight: 1,
    },
    {
      arbitrary: fc.record({
        type: fc.constant("transaction" as const),
        writes: fc.array(writeOpArb, { minLength: 1, maxLength: 4 }),
      }),
      weight: 1,
    },
  );
}

const MAX_OPS = 30;

// ============================================================
// Expected refusals
// ============================================================

type RefusalClass = abstract new (...args: never[]) => TypeGraphError;

/** Every operation the property wraps in {@link attempt}. */
type AttemptedOperation =
  WriteOp["type"] | "retractSource" | "unRetractSource" | "transaction";

/**
 * The refusals each operation can legitimately produce from the states this
 * property reaches. A refused write is part of the sequence: it leaves the
 * store as it was, and the snapshot after it still has to equal its rebuild.
 * Any other error — a `DatabaseOperationError` from a write that should have
 * landed, a `CompilerInvariantError`, a refusal an operation cannot produce
 * here — fails the property.
 *
 * - `ValidationError`: a create naming an id that already holds a live node
 *   or edge; an identity assertion naming one node twice.
 * - `UniquenessError`: two Person words share an e-mail.
 * - `NodeNotFoundError`: the node to update, bound or reopen is absent; an
 *   identity assertion names an absent node.
 * - `RestrictedDeleteError`: the node still has a live edge (`knows`, a
 *   provenance premise or derivation), and the graph's default node-delete
 *   behaviour is `restrict`. Deleting an absent node, or an absent edge, is
 *   not a refusal.
 * - `EndpointNotFoundError`: an edge create names an absent endpoint.
 * - `IdentityContradictionError`: a same / different assertion against an
 *   existing different / same relation.
 * - `IdentityEndpointValidityError`: an identity assertion whose window its
 *   endpoints do not cover, or a window end that would uncover an assertion.
 * - `transaction`: only the edge-create refusals {@link applyWrite} lets
 *   propagate out of a transaction; every other write in it catches its own.
 */
const EXPECTED_REFUSALS = {
  create: [ValidationError, UniquenessError],
  update: [NodeNotFoundError, UniquenessError],
  softDelete: [RestrictedDeleteError],
  hardDelete: [RestrictedDeleteError],
  bulkCreate: [ValidationError, UniquenessError],
  bulkUpsert: [UniquenessError],
  bulkSoftDelete: [RestrictedDeleteError],
  bulkHardDelete: [RestrictedDeleteError],
  endWindow: [NodeNotFoundError, IdentityEndpointValidityError],
  reopenWindow: [NodeNotFoundError],
  createEdge: [EndpointNotFoundError, ValidationError],
  deleteEdge: [],
  assert: [
    ValidationError,
    NodeNotFoundError,
    IdentityContradictionError,
    IdentityEndpointValidityError,
  ],
  bulkAssert: [
    ValidationError,
    NodeNotFoundError,
    IdentityContradictionError,
    IdentityEndpointValidityError,
  ],
  retract: [],
  bulkRetract: [],
  unassert: [],
  retractSource: [],
  unRetractSource: [],
  transaction: [EndpointNotFoundError, ValidationError],
} as const satisfies Record<AttemptedOperation, readonly RefusalClass[]>;

async function attempt<T>(
  operation: AttemptedOperation,
  write: () => Promise<T>,
): Promise<T | undefined> {
  try {
    return await write();
  } catch (error) {
    const expected: readonly RefusalClass[] = EXPECTED_REFUSALS[operation];
    if (expected.some((refusal) => error instanceof refusal)) return undefined;
    throw error;
  }
}

// ============================================================
// Executing operations
// ============================================================

type CreatedNode = Readonly<{ id: string }>;

type NodeWrites = Readonly<{
  /** `id` undefined leaves the id to the store. */
  create: (id: string | undefined, word: string) => Promise<CreatedNode>;
  update: (id: string, word: string) => Promise<unknown>;
  softDelete: (id: string) => Promise<unknown>;
  hardDelete: (id: string) => Promise<unknown>;
  /** An `undefined` entry leaves that node's id to the store. */
  bulkCreate: (
    ids: readonly (string | undefined)[],
    word: string,
  ) => Promise<readonly CreatedNode[]>;
  bulkUpsert: (ids: readonly string[], word: string) => Promise<unknown>;
  bulkSoftDelete: (ids: readonly string[]) => Promise<unknown>;
  bulkHardDelete: (ids: readonly string[]) => Promise<unknown>;
  endWindow: (id: string, validTo: string) => Promise<unknown>;
  reopenWindow: (id: string) => Promise<unknown>;
}>;

/** The Person e-mail: two words share one, so uniqueness refusals happen. */
function personEmail(word: string): string {
  return `${word.length}@example.test`;
}

function createOptions(
  id: string | undefined,
): Readonly<{ id: string }> | undefined {
  return id === undefined ? undefined : { id };
}

function bulkCreateItem<P>(
  props: P,
  id: string | undefined,
): Readonly<{ props: P; id?: string }> {
  return id === undefined ? { props } : { props, id };
}

function nodeWrites(
  store: WriteSurface["data"],
  kind: WritableKind,
): NodeWrites {
  switch (kind) {
    case "Person": {
      const nodes = store.nodes.Person;
      const id = (raw: string) => asNodeId<typeof Person>(raw);
      const props = (word: string) => ({
        name: word,
        email: personEmail(word),
      });
      return {
        create: (raw, word) => nodes.create(props(word), createOptions(raw)),
        update: (raw, word) => nodes.update(id(raw), props(word)),
        softDelete: (raw) => nodes.delete(id(raw)),
        hardDelete: (raw) => nodes.hardDelete(id(raw)),
        bulkCreate: (raws, word) =>
          nodes.bulkCreate(raws.map((raw) => bulkCreateItem(props(word), raw))),
        bulkUpsert: (raws, word) =>
          nodes.bulkUpsertById(
            raws.map((raw) => ({ id: raw, props: props(word) })),
          ),
        bulkSoftDelete: (raws) => nodes.bulkDelete(raws.map((raw) => id(raw))),
        bulkHardDelete: (raws) =>
          nodes.bulkHardDelete(raws.map((raw) => id(raw))),
        endWindow: (raw, validTo) => nodes.update(id(raw), {}, { validTo }),
        reopenWindow: (raw) =>
          nodes.update(id(raw), {}, { clearValidTo: true }),
      };
    }
    case "Robot": {
      const nodes = store.nodes.Robot;
      const id = (raw: string) => asNodeId<typeof Robot>(raw);
      const props = (word: string) => ({ label: word });
      return {
        create: (raw, word) => nodes.create(props(word), createOptions(raw)),
        update: (raw, word) => nodes.update(id(raw), props(word)),
        softDelete: (raw) => nodes.delete(id(raw)),
        hardDelete: (raw) => nodes.hardDelete(id(raw)),
        bulkCreate: (raws, word) =>
          nodes.bulkCreate(raws.map((raw) => bulkCreateItem(props(word), raw))),
        bulkUpsert: (raws, word) =>
          nodes.bulkUpsertById(
            raws.map((raw) => ({ id: raw, props: props(word) })),
          ),
        bulkSoftDelete: (raws) => nodes.bulkDelete(raws.map((raw) => id(raw))),
        bulkHardDelete: (raws) =>
          nodes.bulkHardDelete(raws.map((raw) => id(raw))),
        endWindow: (raw, validTo) => nodes.update(id(raw), {}, { validTo }),
        reopenWindow: (raw) =>
          nodes.update(id(raw), {}, { clearValidTo: true }),
      };
    }
    case "Fact": {
      const nodes = store.nodes.Fact;
      const id = (raw: string) => asNodeId<typeof Fact>(raw);
      const props = (word: string) => ({ code: word });
      return {
        create: (raw, word) => nodes.create(props(word), createOptions(raw)),
        update: (raw, word) => nodes.update(id(raw), props(word)),
        softDelete: (raw) => nodes.delete(id(raw)),
        hardDelete: (raw) => nodes.hardDelete(id(raw)),
        bulkCreate: (raws, word) =>
          nodes.bulkCreate(raws.map((raw) => bulkCreateItem(props(word), raw))),
        bulkUpsert: (raws, word) =>
          nodes.bulkUpsertById(
            raws.map((raw) => ({ id: raw, props: props(word) })),
          ),
        bulkSoftDelete: (raws) => nodes.bulkDelete(raws.map((raw) => id(raw))),
        bulkHardDelete: (raws) =>
          nodes.bulkHardDelete(raws.map((raw) => id(raw))),
        endWindow: (raw, validTo) => nodes.update(id(raw), {}, { validTo }),
        reopenWindow: (raw) =>
          nodes.update(id(raw), {}, { clearValidTo: true }),
      };
    }
  }
}

type Provenance = ReturnType<
  typeof createRetractionCapability<RebuildGraph, typeof PROVENANCE_CONFIG>
>;

type Run = Readonly<{
  graphId: string;
  backend: GraphBackend;
  /** Whether the graph maintains the identity closure and separation. */
  identity: boolean;
  root: WriteSurface;
  /** Runs `body` inside one caller-owned transaction. */
  transaction: (
    body: (surface: WriteSurface) => Promise<void>,
  ) => Promise<void>;
  /** Every library rebuild of a derived relation the graph maintains. */
  rebuild: () => Promise<void>;
  provenance: Provenance | undefined;
  /** Every assertion id a write returned, in order, for `retract` picks. */
  assertionIds: IdentityAssertionId[];
  /**
   * Store-generated node ids by `kind:slot`, when creates leave the id to the
   * store; `undefined` when every create supplies its slot's id.
   */
  generatedIds: Map<string, string> | undefined;
}>;

function nowPlus(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

function slotKey(kind: WritableKind, slot: number): string {
  return `${kind}:${slot}`;
}

/** The id a slot names now: its generated id once a create has bound one. */
function nodeId(run: Run, kind: WritableKind, slot: number): string {
  return (
    run.generatedIds?.get(slotKey(kind, slot)) ?? requireDefined(IDS[slot])
  );
}

/** The id a create supplies for a slot, or `undefined` to let the store pick. */
function createId(run: Run, slot: number): string | undefined {
  return run.generatedIds === undefined ? requireDefined(IDS[slot]) : undefined;
}

function bindGeneratedId(
  run: Run,
  kind: WritableKind,
  slot: number,
  node: CreatedNode | undefined,
): void {
  if (node !== undefined) run.generatedIds?.set(slotKey(kind, slot), node.id);
}

function identityRef(ref: Ref) {
  return { kind: ref.kind, id: ref.id };
}

function requireIdentity(surface: WriteSurface): RebuildStore["identity"] {
  return requireDefined(
    surface.identity,
    "an identity write on a fixture without identity",
  );
}

function noteAssertion(run: Run, result: unknown): void {
  if (typeof result !== "object" || result === null) return;
  if (!("assertion" in result)) return;
  const assertion = result.assertion;
  if (typeof assertion !== "object" || assertion === null) return;
  if (!("id" in assertion) || typeof assertion.id !== "string") return;
  run.assertionIds.push(asIdentityAssertionId(assertion.id));
}

function pickAssertion(
  run: Run,
  pick: number,
): IdentityAssertionId | undefined {
  if (run.assertionIds.length === 0) return undefined;
  return run.assertionIds[pick % run.assertionIds.length];
}

async function applyOp(run: Run, op: Op): Promise<void> {
  switch (op.type) {
    case "retractSource": {
      const provenance = requireDefined(run.provenance, "provenance");
      await attempt("retractSource", () =>
        provenance.retract({
          kind: "Source",
          id: requireDefined(SOURCES[op.source]),
        }),
      );
      return;
    }
    case "unRetractSource": {
      const provenance = requireDefined(run.provenance, "provenance");
      await attempt("unRetractSource", () =>
        provenance.unRetract({
          kind: "Source",
          id: requireDefined(SOURCES[op.source]),
        }),
      );
      return;
    }
    case "advanceClock": {
      vi.setSystemTime(Date.now() + CLOCK_STEP_MS);
      return;
    }
    case "checkpoint": {
      await expectRebuildEquivalent(run, "checkpoint");
      return;
    }
    case "transaction": {
      // The caller catches each refused write inside its own transaction
      // and commits the rest: whatever a refused write left behind commits
      // with it. An edge-create refusal is the exception: it propagates and
      // rolls the transaction back (see `applyWrite`).
      await attempt("transaction", () =>
        run.transaction(async (tx) => {
          for (const write of op.writes) await applyWrite(run, write, tx);
        }),
      );
      return;
    }
    case "write": {
      await applyWrite(run, op.write, run.root);
      return;
    }
  }
}

async function applyWrite(
  run: Run,
  op: WriteOp,
  surface: WriteSurface,
): Promise<void> {
  const store = surface.data;
  switch (op.type) {
    case "create": {
      const node = await attempt("create", () =>
        nodeWrites(store, op.kind).create(
          createId(run, op.id),
          requireDefined(WORDS[op.word]),
        ),
      );
      bindGeneratedId(run, op.kind, op.id, node);
      return;
    }
    case "update": {
      await attempt("update", () =>
        nodeWrites(store, op.kind).update(
          nodeId(run, op.kind, op.id),
          requireDefined(WORDS[op.word]),
        ),
      );
      return;
    }
    case "softDelete":
    case "hardDelete": {
      await attempt(op.type, () =>
        nodeWrites(store, op.kind)[op.type](nodeId(run, op.kind, op.id)),
      );
      return;
    }
    case "bulkCreate": {
      const nodes = await attempt("bulkCreate", () =>
        nodeWrites(store, op.kind).bulkCreate(
          op.ids.map((slot) => createId(run, slot)),
          requireDefined(WORDS[op.word]),
        ),
      );
      for (const [index, slot] of op.ids.entries()) {
        bindGeneratedId(run, op.kind, slot, nodes?.[index]);
      }
      return;
    }
    case "bulkUpsert": {
      await attempt("bulkUpsert", () =>
        nodeWrites(store, op.kind).bulkUpsert(
          op.ids.map((slot) => nodeId(run, op.kind, slot)),
          requireDefined(WORDS[op.word]),
        ),
      );
      return;
    }
    case "bulkSoftDelete":
    case "bulkHardDelete": {
      await attempt(op.type, () =>
        nodeWrites(store, op.kind)[op.type](
          op.ids.map((slot) => nodeId(run, op.kind, slot)),
        ),
      );
      return;
    }
    case "endWindow": {
      await attempt("endWindow", () =>
        nodeWrites(store, op.kind).endWindow(
          nodeId(run, op.kind, op.id),
          nowPlus(WINDOW_LENGTH_MS),
        ),
      );
      return;
    }
    case "reopenWindow": {
      await attempt("reopenWindow", () =>
        nodeWrites(store, op.kind).reopenWindow(nodeId(run, op.kind, op.id)),
      );
      return;
    }
    case "createEdge": {
      const from = nodeId(run, "Person", op.from);
      const to = nodeId(run, "Person", op.to);
      const create = () =>
        store.edges.knows.create(
          { kind: "Person", id: from },
          { kind: "Person", id: to },
          {},
          { id: `knows-${from}-${to}` },
        );
      // Inside a transaction an edge-create refusal propagates and rolls the
      // transaction back. On PostgreSQL a duplicate edge id reaches the
      // database as a failed INSERT: the store reports it as a
      // `ValidationError`, but the transaction is left aborted and the next
      // statement on it throws an untyped driver error, so catching it and
      // writing on is not a sequence the store can complete.
      if (surface.inTransaction) await create();
      else await attempt("createEdge", create);
      return;
    }
    case "deleteEdge": {
      const edgeId = `knows-${nodeId(run, "Person", op.from)}-${nodeId(run, "Person", op.to)}`;
      await attempt("deleteEdge", () =>
        op.hard ?
          store.edges.knows.hardDelete(asEdgeId<typeof knows>(edgeId))
        : store.edges.knows.delete(asEdgeId<typeof knows>(edgeId)),
      );
      return;
    }
    case "assert": {
      const identity = requireIdentity(surface);
      // Identity refuses a validity end in the future, so a windowed
      // assertion is a CLOSED one: it ended a moment ago and is history
      // the moment it lands. It is refused until the clock has moved far
      // enough for its endpoints to cover the window.
      const window =
        op.windowed ?
          { validFrom: nowPlus(-WINDOW_LENGTH_MS), validTo: nowPlus(-1) }
        : undefined;
      const result = await attempt("assert", () =>
        op.relation === "same" ?
          identity.assertSame(identityRef(op.a), identityRef(op.b), window)
        : identity.assertDifferent(
            identityRef(op.a),
            identityRef(op.b),
            window,
          ),
      );
      noteAssertion(run, result);
      return;
    }
    case "bulkAssert": {
      const identity = requireIdentity(surface);
      const pairs = op.pairs.map(([a, b]) => ({
        a: identityRef(a),
        b: identityRef(b),
      }));
      const results = await attempt("bulkAssert", () =>
        op.relation === "same" ?
          identity.bulkAssertSame(pairs)
        : identity.bulkAssertDifferent(pairs),
      );
      if (Array.isArray(results)) {
        for (const result of results) noteAssertion(run, result);
      }
      return;
    }
    case "retract": {
      const identity = requireIdentity(surface);
      const id = pickAssertion(run, op.pick);
      if (id !== undefined) {
        await attempt("retract", () => identity.retractAssertion(id));
      }
      return;
    }
    case "bulkRetract": {
      const identity = requireIdentity(surface);
      const ids = op.picks.flatMap((pick) => {
        const id = pickAssertion(run, pick);
        return id === undefined ? [] : [id];
      });
      await attempt("bulkRetract", () => identity.bulkRetractAssertions(ids));
      return;
    }
    case "unassert": {
      const identity = requireIdentity(surface);
      await attempt("unassert", () =>
        op.relation === "same" ?
          identity.retractSameAssertion(identityRef(op.a), identityRef(op.b))
        : identity.retractDifferentAssertion(
            identityRef(op.a),
            identityRef(op.b),
          ),
      );
      return;
    }
  }
}

/**
 * The world every identity-fixture run starts from: Persons `n0`–`n3` and
 * Robots `n0`–`n1` live, so identity writes mostly land. The provenance part:
 * `j0` is justified by `s0` and derives facts `n0` and `n1`; `j1` is justified
 * by `s1` and fact `n0` and derives fact `n2`. Fact ids deliberately reuse the
 * generic node ids, so a provenance transition, a node write, and an identity
 * assertion can all touch the same reference.
 */
async function seedIdentityWorld(store: RebuildStore): Promise<void> {
  for (const [index, id] of IDS.entries()) {
    const word = requireDefined(WORDS[index]);
    await store.nodes.Person.create(
      { name: word, email: `${id}@example.test` },
      { id },
    );
    if (index < 2) await store.nodes.Robot.create({ label: word }, { id });
  }
  for (const id of SOURCES) {
    await store.nodes.Source.create({ label: id, retracted: false }, { id });
  }
  for (const [index, id] of ["n0", "n1", "n2"].entries()) {
    await store.nodes.Fact.create(
      { code: requireDefined(WORDS[index]) },
      { id },
    );
  }
  for (const id of ["j0", "j1"]) {
    await store.nodes.Justification.create({ label: id }, { id });
  }
  const premises = [
    ["Source", "s0", "j0"],
    ["Source", "s1", "j1"],
    ["Fact", "n0", "j1"],
  ] as const;
  for (const [kind, from, to] of premises) {
    await store.edges.premiseOf.create(
      { kind, id: from },
      { kind: "Justification", id: to },
      {},
      { id: `premise-${from}-${to}` },
    );
  }
  for (const [from, to] of [
    ["j0", "n0"],
    ["j0", "n1"],
    ["j1", "n2"],
  ] as const) {
    await store.edges.derives.create(
      { kind: "Justification", id: from },
      { kind: "Fact", id: to },
      {},
      { id: `derives-${from}-${to}` },
    );
  }
}

/**
 * The world every root-fusion run starts from: Persons in slots 0–3, Robots
 * in 0–1 and Facts in 0–2, each created at the root with a store-generated
 * id, so every Robot and Fact here is a fused-root create candidate.
 */
async function seedFusionWorld(run: Run): Promise<void> {
  const nodes = run.root.data.nodes;
  for (const [slot, word] of WORDS.entries()) {
    bindGeneratedId(
      run,
      "Person",
      slot,
      await nodes.Person.create({ name: word, email: `${slot}@example.test` }),
    );
    if (slot < 2) {
      bindGeneratedId(
        run,
        "Robot",
        slot,
        await nodes.Robot.create({ label: word }),
      );
    }
    if (slot < 3) {
      bindGeneratedId(
        run,
        "Fact",
        slot,
        await nodes.Fact.create({ code: word }),
      );
    }
  }
}

// ============================================================
// Command trace
// ============================================================

/**
 * Records every command the root backend's command port executes, so a run
 * can prove a fused command — not the portable path — wrote a fulltext row.
 */
function traceRootCommands(backend: GraphBackend) {
  const spy = vi.spyOn(backend.commands, "execute");
  return {
    /** Fused node creates that reported `created` with a fulltext projection. */
    fulltextCreates: () =>
      spy.mock.calls.filter(([command], index) => {
        const settled = spy.mock.settledResults[index];
        return (
          command.kind === "node.create" &&
          command.plan.projections.some(
            (projection) => projection.kind === "fulltext",
          ) &&
          settled?.type === "fulfilled" &&
          settled.value.outcome === "created"
        );
      }).length,
    restore: () => {
      spy.mockRestore();
    },
  };
}

// ============================================================
// Snapshot and rebuild
// ============================================================

type DerivedSnapshot = Readonly<{
  /** `member -> class`, one entry per closure row. */
  closure: readonly string[];
  /** `low | high`, one entry per separation row. */
  separation: readonly string[];
  /** `kind:id [language] content`, one entry per fulltext row. */
  fulltext: readonly string[];
  /**
   * One entry per contribution marker row in either scope: the graph's own
   * activation marker and the deployment-wide physical attestation.
   */
  contributionMarkers: readonly string[];
}>;

function sorted(values: readonly string[]): readonly string[] {
  return values.toSorted(compareStrings);
}

async function readRows(
  backend: GraphBackend,
  query: ReturnType<typeof sql>,
): Promise<readonly Record<string, unknown>[]> {
  return backend.execute<Record<string, unknown>>(asCompiledRowsSql(query));
}

/** `last_error` as stored: SQL `NULL` and an empty string stay distinct. */
function describeLastError(value: unknown): string {
  return value === null || value === undefined ? "NULL" : JSON.stringify(value);
}

/**
 * Every derived row this graph owns, read straight from the tables (default
 * table names) and spelled as canonically ordered strings.
 *
 * Excluded columns, each because it records when a row was written, not what
 * it derives: fulltext `updated_at` (and PostgreSQL's generated `tsv`, a pure
 * function of `language` and `content`, both compared); contribution marker
 * `materialized_at` (compared as present/absent) and `last_attempted_at`.
 */
async function snapshotDerived(run: Run): Promise<DerivedSnapshot> {
  const { backend, graphId } = run;
  const closure =
    run.identity ?
      await readRows(
        backend,
        sql`
          SELECT member_kind, member_id, class_kind, class_id
          FROM ${sql.raw("typegraph_identity_closure")}
          WHERE graph_id = ${graphId}
        `,
      )
    : [];
  const separation =
    run.identity ?
      await readRows(
        backend,
        sql`
          SELECT class_key_low, class_key_high
          FROM ${sql.raw("typegraph_identity_separation")}
          WHERE graph_id = ${graphId}
        `,
      )
    : [];
  const fulltext = await readRows(
    backend,
    sql`
      SELECT node_kind, node_id, CAST(language AS TEXT) AS language, content
      FROM ${sql.raw("typegraph_node_fulltext")}
      WHERE graph_id = ${graphId}
    `,
  );
  const markers = await readRows(
    backend,
    sql`
      SELECT graph_id, logical_name, owner, table_name, signature,
        CASE WHEN materialized_at IS NULL THEN 0 ELSE 1 END AS materialized,
        last_error
      FROM ${sql.raw("typegraph_contribution_materializations")}
      WHERE graph_id IN (${graphId}, ${DEPLOYMENT_CONTRIBUTION_GRAPH_ID})
    `,
  );
  return {
    closure: sorted(
      closure.map(
        (row) =>
          `${String(row["member_kind"])}:${String(row["member_id"])} -> ${String(row["class_kind"])}:${String(row["class_id"])}`,
      ),
    ),
    separation: sorted(
      separation.map(
        (row) =>
          `${String(row["class_key_low"])} | ${String(row["class_key_high"])}`,
      ),
    ),
    fulltext: sorted(
      fulltext.map(
        (row) =>
          `${String(row["node_kind"])}:${String(row["node_id"])} [${String(row["language"])}] ${String(row["content"])}`,
      ),
    ),
    contributionMarkers: sorted(
      markers.map((row) =>
        [
          row["graph_id"] === DEPLOYMENT_CONTRIBUTION_GRAPH_ID ?
            "deployment"
          : "graph",
          String(row["logical_name"]),
          String(row["owner"]),
          String(row["table_name"]),
          String(row["signature"]),
          Number(row["materialized"]) === 1 ? "materialized" : "pending",
          describeLastError(row["last_error"]),
        ].join(" | "),
      ),
    ),
  };
}

async function expectRebuildEquivalent(run: Run, label: string): Promise<void> {
  const stored = await snapshotDerived(run);
  await run.rebuild();
  const rebuilt = await snapshotDerived(run);
  expect({ at: label, derived: stored }).toEqual({
    at: label,
    derived: rebuilt,
  });
}

// ============================================================
// Fixtures
// ============================================================

type Fixture = Readonly<{
  name: string;
  /** Generated node and op sequences, with an identity profile per run. */
  arbitrary: fc.Arbitrary<
    Readonly<{ profile: "fold" | "ignore"; ops: readonly Op[] }>
  >;
  /** Creates the graph and its seeded store on `backend`. */
  open: (
    backend: GraphBackend,
    graphId: string,
    profile: "fold" | "ignore",
  ) => Promise<Run>;
  /**
   * Whether a run must show, on a lane that fuses root creates, a fused
   * fulltext create in its command trace.
   */
  requiresFusedFulltext: boolean;
}>;

const FIXTURES: readonly Fixture[] = [
  {
    name: "identity, history and provenance",
    arbitrary: fc.record({
      profile: fc.constantFrom("fold" as const, "ignore" as const),
      ops: fc.array(
        opArbitrary(
          [...DATA_WRITE_ARBS, ...IDENTITY_WRITE_ARBS],
          PROVENANCE_OP_ARBS,
        ),
        { maxLength: MAX_OPS, size: "max" },
      ),
    }),
    requiresFusedFulltext: false,
    open: async (backend, graphId, profile) => {
      const [store] = await createStoreWithSchema(
        buildGraph(graphId, profile),
        backend,
        { history: true },
      );
      await seedIdentityWorld(store);
      return {
        graphId,
        backend: storeBackend(store),
        identity: true,
        root: { data: store, identity: store.identity, inTransaction: false },
        transaction: (body) =>
          store.transaction((tx) =>
            body({ data: tx, identity: tx.identity, inTransaction: true }),
          ),
        rebuild: async () => {
          await rebuildIdentityClosure(store);
          await store.rebuildContribution("fulltext");
        },
        provenance: createRetractionCapability(store, PROVENANCE_CONFIG),
        assertionIds: [],
        generatedIds: undefined,
      };
    },
  },
  {
    name: "root fusion",
    arbitrary: fc.record({
      // No identity: the profile is unused, fixed so shrinking ignores it.
      profile: fc.constant("fold" as const),
      ops: fc.array(opArbitrary(DATA_WRITE_ARBS, []), {
        maxLength: MAX_OPS,
        size: "max",
      }),
    }),
    requiresFusedFulltext: true,
    open: async (backend, graphId) => {
      const [store] = await createStoreWithSchema(
        buildFusionGraph(graphId),
        backend,
      );
      const run: Run = {
        graphId,
        backend: storeBackend(store),
        identity: false,
        root: { data: store, identity: undefined, inTransaction: false },
        transaction: (body) =>
          store.transaction((tx) =>
            body({ data: tx, identity: undefined, inTransaction: true }),
          ),
        rebuild: async () => {
          await store.rebuildContribution("fulltext");
        },
        provenance: undefined,
        assertionIds: [],
        generatedIds: new Map(),
      };
      await seedFusionWorld(run);
      return run;
    },
  },
];

// ============================================================
// Lanes
// ============================================================

type Lane = Readonly<{
  name: string;
  runs: number;
  /** A backend for one run; `shared` lanes reuse one across runs. */
  open: () => Promise<
    Readonly<{ backend: GraphBackend; close: () => Promise<void> }>
  >;
  shared: boolean;
  /**
   * Whether an eligible root create on this backend takes the fused
   * `node.create` command. The SQLite lane's root creates take the portable
   * path; both PGlite backends are bundled roots and fuse them.
   */
  fusesRootNodeCreates: boolean;
}>;

const LANES: readonly Lane[] = [
  {
    name: "SQLite",
    runs: propertyRuns({ ci: 40, local: 100 }),
    shared: false,
    fusesRootNodeCreates: false,
    open: () => {
      // Closed by the run that opened it: a native database per run held to
      // the end of the property grows the worker by hundreds of megabytes.
      const { backend } = createLocalSqliteBackend();
      return Promise.resolve({ backend, close: () => backend.close() });
    },
  },
  {
    name: "PGlite",
    runs: propertyRuns({ ci: 15, local: 40 }),
    shared: true,
    fusesRootNodeCreates: true,
    open: async () => {
      const local = await createLocalPgliteBackend({ vector: false });
      return { backend: local.backend, close: () => local.backend.close() };
    },
  },
  {
    // The unwrapped `createPostgresBackend` root over the same database,
    // without the local factory's managed-close wrapper.
    name: "PGlite root (fused-capable)",
    runs: propertyRuns({ ci: 15, local: 40 }),
    shared: true,
    fusesRootNodeCreates: true,
    open: async () => {
      const local = await createLocalPgliteBackend({ vector: false });
      return {
        backend: createPostgresBackend(local.db, { vector: false }),
        close: () => local.backend.close(),
      };
    },
  },
];

let graphSerial = 0;

describe.each(LANES)("rebuild equivalence ($name)", (lane) => {
  let shared: Awaited<ReturnType<Lane["open"]>> | undefined;

  beforeAll(async () => {
    if (lane.shared) shared = await lane.open();
  });

  afterAll(async () => {
    await shared?.close();
  });

  it.each(FIXTURES)(
    "stored derived rows equal their rebuild after every random write sequence ($name)",
    async (fixture) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        await fc.assert(
          fc.asyncProperty(fixture.arbitrary, async ({ profile, ops }) => {
            graphSerial += 1;
            vi.setSystemTime(START_INSTANT);
            const opened = shared ?? (await lane.open());
            const trace = traceRootCommands(opened.backend);
            try {
              const run = await fixture.open(
                opened.backend,
                `rebuild_eq_${profile}_${graphSerial}`,
                profile,
              );
              for (const op of ops) await applyOp(run, op);
              // Where the lane fuses root creates, a fused command wrote at
              // least one fulltext row the comparison below checks against
              // its rebuild.
              const requiredFusedCreates =
                fixture.requiresFusedFulltext && lane.fusesRootNodeCreates ?
                  1
                : 0;
              expect(trace.fulltextCreates()).toBeGreaterThanOrEqual(
                requiredFusedCreates,
              );
              await expectRebuildEquivalent(run, "end");
            } finally {
              trace.restore();
              if (shared === undefined) await opened.close();
            }
          }),
          { numRuns: lane.runs },
        );
      } finally {
        vi.useRealTimers();
      }
    },
    600_000,
  );
});
