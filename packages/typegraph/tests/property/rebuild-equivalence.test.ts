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
 *    for the fulltext projection and its durable marker — and snapshot again;
 * 4. require the two snapshots to be equal, row for row.
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
} from "../../src";
import { createPostgresBackend } from "../../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { type GraphBackend } from "../../src/backend/types";
import { TypeGraphError } from "../../src/errors";
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
import { createTestBackend } from "../test-utils";
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

function buildGraph(id: string, sameIdAcrossKinds: "fold" | "ignore") {
  return defineGraph({
    id,
    nodes: {
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
    },
    edges: {
      knows: { type: knows, from: [Person], to: [Person] },
      premiseOf: { type: premiseOf, from: [Source, Fact], to: [Justification] },
      derives: { type: derives, from: [Justification], to: [Fact] },
    },
    identity: { sameIdAcrossKinds },
  });
}

type RebuildGraph = ReturnType<typeof buildGraph>;
type RebuildStore = HistoryStore<RebuildGraph>;

/**
 * What a write runs through: the store itself, or the context of a
 * caller-owned transaction (`store.transaction(async (tx) => ...)`).
 */
type WriteSurface = Pick<RebuildStore, "nodes" | "edges" | "identity">;

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

const writeOpArb: fc.Arbitrary<WriteOp> = fc.oneof(
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
  fc.record({
    type: fc.constant("softDelete" as const),
    kind: kindArb,
    id: idArb,
  }),
  fc.record({
    type: fc.constant("hardDelete" as const),
    kind: kindArb,
    id: idArb,
  }),
  fc.record({
    type: fc.constantFrom("bulkCreate" as const, "bulkUpsert" as const),
    kind: kindArb,
    ids: idsArb,
    word: wordArb,
  }),
  fc.record({
    type: fc.constantFrom("bulkSoftDelete" as const, "bulkHardDelete" as const),
    kind: kindArb,
    ids: idsArb,
  }),
  fc.record({
    type: fc.constant("endWindow" as const),
    kind: kindArb,
    id: idArb,
  }),
  fc.record({
    type: fc.constant("reopenWindow" as const),
    kind: kindArb,
    id: idArb,
  }),
  fc.record({
    type: fc.constant("createEdge" as const),
    from: idArb,
    to: idArb,
  }),
  fc.record({
    type: fc.constant("deleteEdge" as const),
    from: idArb,
    to: idArb,
    hard: fc.boolean(),
  }),
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
  fc.record({
    type: fc.constant("bulkRetract" as const),
    picks: fc.array(fc.nat(), { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    type: fc.constant("unassert" as const),
    relation: relationArb,
    a: refArb,
    b: refArb,
  }),
);

const opArb: fc.Arbitrary<Op> = fc.oneof(
  {
    arbitrary: writeOpArb.map((write) => ({ type: "write" as const, write })),
    weight: 20,
  },
  fc.record({ type: fc.constant("retractSource" as const), source: sourceArb }),
  fc.record({
    type: fc.constant("unRetractSource" as const),
    source: sourceArb,
  }),
  fc.record({ type: fc.constant("advanceClock" as const) }),
  fc.record({ type: fc.constant("checkpoint" as const) }),
  fc.record({
    type: fc.constant("transaction" as const),
    writes: fc.array(writeOpArb, { minLength: 1, maxLength: 4 }),
  }),
);

const MAX_OPS = 30;

// ============================================================
// Executing operations
// ============================================================

type NodeWrites = Readonly<{
  create: (id: string, word: string) => Promise<unknown>;
  update: (id: string, word: string) => Promise<unknown>;
  softDelete: (id: string) => Promise<unknown>;
  hardDelete: (id: string) => Promise<unknown>;
  bulkCreate: (ids: readonly string[], word: string) => Promise<unknown>;
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

function nodeWrites(store: WriteSurface, kind: WritableKind): NodeWrites {
  switch (kind) {
    case "Person": {
      const nodes = store.nodes.Person;
      const id = (raw: string) => asNodeId<typeof Person>(raw);
      const props = (word: string) => ({
        name: word,
        email: personEmail(word),
      });
      return {
        create: (raw, word) => nodes.create(props(word), { id: raw }),
        update: (raw, word) => nodes.update(id(raw), props(word)),
        softDelete: (raw) => nodes.delete(id(raw)),
        hardDelete: (raw) => nodes.hardDelete(id(raw)),
        bulkCreate: (raws, word) =>
          nodes.bulkCreate(
            raws.map((raw) => ({ props: props(word), id: raw })),
          ),
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
        create: (raw, word) => nodes.create(props(word), { id: raw }),
        update: (raw, word) => nodes.update(id(raw), props(word)),
        softDelete: (raw) => nodes.delete(id(raw)),
        hardDelete: (raw) => nodes.hardDelete(id(raw)),
        bulkCreate: (raws, word) =>
          nodes.bulkCreate(
            raws.map((raw) => ({ props: props(word), id: raw })),
          ),
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
        create: (raw, word) => nodes.create(props(word), { id: raw }),
        update: (raw, word) => nodes.update(id(raw), props(word)),
        softDelete: (raw) => nodes.delete(id(raw)),
        hardDelete: (raw) => nodes.hardDelete(id(raw)),
        bulkCreate: (raws, word) =>
          nodes.bulkCreate(
            raws.map((raw) => ({ props: props(word), id: raw })),
          ),
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

type Run = Readonly<{
  store: RebuildStore;
  provenance: ReturnType<
    typeof createRetractionCapability<RebuildGraph, typeof PROVENANCE_CONFIG>
  >;
  /** Every assertion id a write returned, in order, for `retract` picks. */
  assertionIds: IdentityAssertionId[];
}>;

function nowPlus(milliseconds: number): string {
  return new Date(Date.now() + milliseconds).toISOString();
}

/**
 * A refused write is part of the sequence, not a failure of the property: a
 * typed refusal (duplicate id, uniqueness, identity contradiction, missing
 * node, window conflict) leaves the store as it was, and the snapshot after it
 * still has to equal its rebuild. Anything that is not a TypeGraph error is a
 * real failure and propagates.
 */
async function attempt(write: () => Promise<unknown>): Promise<unknown> {
  try {
    return await write();
  } catch (error) {
    if (error instanceof TypeGraphError) return undefined;
    throw error;
  }
}

function identityRef(ref: Ref) {
  return { kind: ref.kind, id: ref.id };
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
      await attempt(() =>
        run.provenance.retract({
          kind: "Source",
          id: requireDefined(SOURCES[op.source]),
        }),
      );
      return;
    }
    case "unRetractSource": {
      await attempt(() =>
        run.provenance.unRetract({
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
      await expectRebuildEquivalent(run.store, "checkpoint");
      return;
    }
    case "transaction": {
      // The caller catches each refused write inside its own transaction
      // and commits the rest: whatever a refused write left behind commits
      // with it.
      await attempt(() =>
        run.store.transaction(async (tx) => {
          for (const write of op.writes) await applyWrite(run, write, tx);
        }),
      );
      return;
    }
    case "write": {
      await applyWrite(run, op.write, run.store);
      return;
    }
  }
}

async function applyWrite(
  run: Run,
  op: WriteOp,
  store: WriteSurface,
): Promise<void> {
  switch (op.type) {
    case "create":
    case "update": {
      await attempt(() =>
        nodeWrites(store, op.kind)[op.type](
          requireDefined(IDS[op.id]),
          requireDefined(WORDS[op.word]),
        ),
      );
      return;
    }
    case "softDelete":
    case "hardDelete": {
      await attempt(() =>
        nodeWrites(store, op.kind)[op.type](requireDefined(IDS[op.id])),
      );
      return;
    }
    case "bulkCreate":
    case "bulkUpsert": {
      await attempt(() =>
        nodeWrites(store, op.kind)[op.type](
          op.ids.map((index) => requireDefined(IDS[index])),
          requireDefined(WORDS[op.word]),
        ),
      );
      return;
    }
    case "bulkSoftDelete":
    case "bulkHardDelete": {
      await attempt(() =>
        nodeWrites(store, op.kind)[op.type](
          op.ids.map((index) => requireDefined(IDS[index])),
        ),
      );
      return;
    }
    case "endWindow": {
      await attempt(() =>
        nodeWrites(store, op.kind).endWindow(
          requireDefined(IDS[op.id]),
          nowPlus(WINDOW_LENGTH_MS),
        ),
      );
      return;
    }
    case "reopenWindow": {
      await attempt(() =>
        nodeWrites(store, op.kind).reopenWindow(requireDefined(IDS[op.id])),
      );
      return;
    }
    case "createEdge": {
      const from = requireDefined(IDS[op.from]);
      const to = requireDefined(IDS[op.to]);
      await attempt(() =>
        store.edges.knows.create(
          { kind: "Person", id: from },
          { kind: "Person", id: to },
          {},
          { id: `knows-${from}-${to}` },
        ),
      );
      return;
    }
    case "deleteEdge": {
      const edgeId = `knows-${requireDefined(IDS[op.from])}-${requireDefined(IDS[op.to])}`;
      await attempt(() =>
        op.hard ?
          store.edges.knows.hardDelete(asEdgeId<typeof knows>(edgeId))
        : store.edges.knows.delete(asEdgeId<typeof knows>(edgeId)),
      );
      return;
    }
    case "assert": {
      // Identity refuses a validity end in the future, so a windowed
      // assertion is a CLOSED one: it ended a moment ago and is history
      // the moment it lands. It is refused until the clock has moved far
      // enough for its endpoints to cover the window.
      const window =
        op.windowed ?
          { validFrom: nowPlus(-WINDOW_LENGTH_MS), validTo: nowPlus(-1) }
        : undefined;
      const result = await attempt(() =>
        op.relation === "same" ?
          store.identity.assertSame(
            identityRef(op.a),
            identityRef(op.b),
            window,
          )
        : store.identity.assertDifferent(
            identityRef(op.a),
            identityRef(op.b),
            window,
          ),
      );
      noteAssertion(run, result);
      return;
    }
    case "bulkAssert": {
      const pairs = op.pairs.map(([a, b]) => ({
        a: identityRef(a),
        b: identityRef(b),
      }));
      const results = await attempt(() =>
        op.relation === "same" ?
          store.identity.bulkAssertSame(pairs)
        : store.identity.bulkAssertDifferent(pairs),
      );
      if (Array.isArray(results)) {
        for (const result of results) noteAssertion(run, result);
      }
      return;
    }
    case "retract": {
      const id = pickAssertion(run, op.pick);
      if (id !== undefined) {
        await attempt(() => store.identity.retractAssertion(id));
      }
      return;
    }
    case "bulkRetract": {
      const ids = op.picks.flatMap((pick) => {
        const id = pickAssertion(run, pick);
        return id === undefined ? [] : [id];
      });
      await attempt(() => store.identity.bulkRetractAssertions(ids));
      return;
    }
    case "unassert": {
      await attempt(() =>
        op.relation === "same" ?
          store.identity.retractSameAssertion(
            identityRef(op.a),
            identityRef(op.b),
          )
        : store.identity.retractDifferentAssertion(
            identityRef(op.a),
            identityRef(op.b),
          ),
      );
      return;
    }
  }
}

/**
 * The world every run starts from: Persons `n0`–`n3` and Robots `n0`–`n1`
 * live, so identity writes mostly land. The provenance part: `j0` is justified by `s0` and
 * derives facts `n0` and `n1`; `j1` is justified by `s1` and fact `n0` and
 * derives fact `n2`. Fact ids deliberately reuse the generic node ids, so a
 * provenance transition, a node write, and an identity assertion can all
 * touch the same reference.
 */
async function seedWorld(store: RebuildStore): Promise<void> {
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
  /** One entry per contribution marker row this graph owns. */
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

/**
 * Every derived row this graph owns, read straight from the tables (default
 * table names) and spelled as canonically ordered strings.
 *
 * Excluded columns, each because it records when a row was written, not what
 * it derives: fulltext `updated_at` (and PostgreSQL's generated `tsv`, a pure
 * function of `language` and `content`, both compared); contribution marker
 * `materialized_at` (compared as present/absent) and `last_attempted_at`.
 */
async function snapshotDerived(store: RebuildStore): Promise<DerivedSnapshot> {
  const backend = storeBackend(store);
  const graphId = store.graphId;
  const closure = await readRows(
    backend,
    sql`
      SELECT member_kind, member_id, class_kind, class_id
      FROM ${sql.raw("typegraph_identity_closure")}
      WHERE graph_id = ${graphId}
    `,
  );
  const separation = await readRows(
    backend,
    sql`
      SELECT class_key_low, class_key_high
      FROM ${sql.raw("typegraph_identity_separation")}
      WHERE graph_id = ${graphId}
    `,
  );
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
      SELECT logical_name, owner, table_name, signature,
        CASE WHEN materialized_at IS NULL THEN 0 ELSE 1 END AS materialized,
        last_error
      FROM ${sql.raw("typegraph_contribution_materializations")}
      WHERE graph_id = ${graphId}
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
          row["logical_name"],
          row["owner"],
          row["table_name"],
          row["signature"],
          Number(row["materialized"]) === 1 ? "materialized" : "pending",
          row["last_error"] ?? "",
        ]
          .map(String)
          .join(" | "),
      ),
    ),
  };
}

/** Every library rebuild of a derived relation, run in place. */
async function rebuildAll(store: RebuildStore): Promise<void> {
  await rebuildIdentityClosure(store);
  await store.rebuildContribution("fulltext");
}

async function expectRebuildEquivalent(
  store: RebuildStore,
  label: string,
): Promise<void> {
  const stored = await snapshotDerived(store);
  await rebuildAll(store);
  const rebuilt = await snapshotDerived(store);
  expect({ at: label, derived: stored }).toEqual({
    at: label,
    derived: rebuilt,
  });
}

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
}>;

const LANES: readonly Lane[] = [
  {
    name: "SQLite",
    runs: propertyRuns({ ci: 40, local: 100 }),
    shared: false,
    open: () =>
      Promise.resolve({
        backend: createTestBackend(),
        close: () => Promise.resolve(),
      }),
  },
  {
    name: "PGlite",
    runs: propertyRuns({ ci: 15, local: 40 }),
    shared: true,
    open: async () => {
      const local = await createLocalPgliteBackend({ vector: false });
      return { backend: local.backend, close: () => local.backend.close() };
    },
  },
  {
    // The root backend over the same database: fused command paths write
    // the derived rows here, by a route the store-mediated lane never takes.
    name: "PGlite root (fused-capable)",
    runs: propertyRuns({ ci: 15, local: 40 }),
    shared: true,
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

  it("stored derived rows equal their rebuild after every random write sequence", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom("fold" as const, "ignore" as const),
          fc.array(opArb, { maxLength: MAX_OPS, size: "max" }),
          async (profile, ops) => {
            graphSerial += 1;
            vi.setSystemTime(START_INSTANT);
            const opened = shared ?? (await lane.open());
            try {
              const graph = buildGraph(
                `rebuild_eq_${profile}_${graphSerial}`,
                profile,
              );
              const [store] = await createStoreWithSchema(
                graph,
                opened.backend,
                { history: true },
              );
              await seedWorld(store);
              const run: Run = {
                store,
                provenance: createRetractionCapability(
                  store,
                  PROVENANCE_CONFIG,
                ),
                assertionIds: [],
              };
              for (const op of ops) await applyOp(run, op);
              await expectRebuildEquivalent(store, "end");
            } finally {
              if (shared === undefined) await opened.close();
            }
          },
        ),
        { numRuns: lane.runs },
      );
    } finally {
      vi.useRealTimers();
    }
  }, 600_000);
});
