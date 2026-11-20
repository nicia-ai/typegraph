/**
 * Where a deleted node's data survives, on every backend.
 *
 * `delete()`, `hardDelete()` and `bulkHardDelete()` each remove a different
 * amount of a node, and a store's configuration (plain, `revisionTracking`,
 * `history`) decides what else holds a copy. None of the three is an erasure:
 * nothing removes a node's recorded history, and nothing done to a base store
 * reaches a branch forked from it. This suite records, for one node that
 * touches every derived structure, what each operation leaves readable through
 * the public API and present in the tables, so the documentation's statements
 * about deletion (`core-concepts.md`, `schemas-stores.md`, `limitations.md`)
 * are backed by a test.
 *
 * The subject node carries {@link SENTINEL} in every string it owns (a
 * property in two versions, its unique key, its searchable text) and in its
 * incident edge's properties, and a distinctive id. It is the canonical member
 * of its identity class, so the identity transition log names it. Each case
 * first proves every place below holds the subject (so a "gone" verdict is not
 * a place that was never written), runs the operation, then asks every public
 * read whether the sentinel comes back and scans every graph-scoped relation,
 * plus the graph's per-field vector tables, for the sentinel and the id.
 *
 * These tests pin CURRENT behaviour. Every expectation that a copy SURVIVES a
 * hard delete is marked with #922 (an erasure operation that reaches recorded
 * history and every derived copy). When that capability lands, change those
 * expectations deliberately, together with the documentation that cites them.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  embedding,
  searchable,
} from "../../../src";
import {
  GRAPH_RELATION_KEYS,
  type GraphRelationKey,
} from "../../../src/backend/graph-relations";
import type { GraphBackend } from "../../../src/backend/types";
import type { RecordedInstant } from "../../../src/core";
import {
  createRecordedInstant,
  recordedInstantOwner,
  recordedInstantRevision,
  recordedInstantWallTime,
} from "../../../src/core/temporal";
import { branch, unwrap } from "../../../src/graph-merge";
import { pruneIdentityTransitions } from "../../../src/identity-entry";
import { inspectGraphStorage } from "../../../src/maintenance";
import { createRetractionCapability } from "../../../src/provenance";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import type { HistoryStore, Store } from "../../../src/store/store";
import type { TransactionReceipt } from "../../../src/store/types";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

/** A token no tokenizer or stemmer rewrites, and nothing else contains. */
const SENTINEL = "qqerasuresentinelqq";
/**
 * Sorts before {@link WITNESS_ID}, and its kind before the witness kind, so the
 * subject is its identity class's canonical member and the transition log
 * names it.
 */
const SUBJECT_ID = "a-subject-zx81";
const WITNESS_ID = "z-witness-1";
const KNOWS_EDGE_ID = "knows-1";
const PREMISE_EDGE_ID = "premise-1";
const FIRST_NOTE = `${SENTINEL} version one`;
const SECOND_NOTE = `${SENTINEL} version two`;
const SUBJECT_EMAIL = `${SENTINEL}@example.com`;
const SUBJECT_VECTOR = [0.25, 0.5, 1] as const;
const EMAIL_CONSTRAINT = "erasure_subject_email";

const ErasureSubject = defineNode("ErasureSubject", {
  schema: z.object({
    email: z.string(),
    note: z.string(),
    bio: searchable({ language: "english" }),
    retracted: z.boolean().default(false),
    vector: embedding(3).optional(),
  }),
});
const ErasureWitness = defineNode("ErasureWitness", {
  schema: z.object({ name: z.string() }),
});
const ErasureJustification = defineNode("ErasureJustification", {
  schema: z.object({ label: z.string() }),
});
const ErasureFact = defineNode("ErasureFact", {
  schema: z.object({ label: z.string() }),
});

const erasureKnows = defineEdge("erasureKnows", {
  schema: z.object({ note: z.string() }),
});
const erasurePremiseOf = defineEdge("erasurePremiseOf");
const erasureDerives = defineEdge("erasureDerives");

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      ErasureSubject: {
        type: ErasureSubject,
        unique: [
          {
            name: EMAIL_CONSTRAINT,
            fields: ["email"],
            scope: "kind",
            collation: "binary",
          },
        ],
        // A `restrict` node with edges refuses a hard delete; cascade lets
        // every operation reach the node's incident edges.
        onDelete: "cascade",
      },
      ErasureWitness: { type: ErasureWitness },
      ErasureJustification: { type: ErasureJustification },
      ErasureFact: { type: ErasureFact },
    },
    edges: {
      erasureKnows: {
        type: erasureKnows,
        from: [ErasureSubject],
        to: [ErasureWitness],
      },
      erasurePremiseOf: {
        type: erasurePremiseOf,
        from: [ErasureSubject],
        to: [ErasureJustification],
      },
      erasureDerives: {
        type: erasureDerives,
        from: [ErasureJustification],
        to: [ErasureFact],
      },
    },
    identity: { sameIdAcrossKinds: "ignore" },
  });
}

/** The subject is a provenance premise: a source of the justification. */
const PROVENANCE_CONFIG = {
  source: { kind: "ErasureSubject" },
  justification: { kind: "ErasureJustification" },
  fact: { kinds: ["ErasureFact"] },
  premiseOf: { kind: "erasurePremiseOf" },
  derives: { kind: "erasureDerives" },
} as const;

type ErasureGraph = ReturnType<typeof buildGraph>;
type ErasureStore = Store<ErasureGraph> & Readonly<{ backend: GraphBackend }>;

type StoreConfiguration = "plain" | "revisionTracking" | "history";
type Operation = "delete" | "hardDelete" | "bulkHardDelete";

const STORE_CONFIGURATIONS = [
  "plain",
  "revisionTracking",
  "history",
] as const satisfies readonly StoreConfiguration[];
const OPERATIONS = [
  "delete",
  "hardDelete",
  "bulkHardDelete",
] as const satisfies readonly Operation[];

let graphCounter = 0;
function nextGraphId(): string {
  graphCounter += 1;
  return `erasure_audit_${graphCounter}`;
}

const subjectRef = { kind: "ErasureSubject", id: SUBJECT_ID } as never;
const witnessRef = { kind: "ErasureWitness", id: WITNESS_ID } as never;

/** JSON that tolerates the bigint and byte values engines return. */
function renderJson(value: unknown): string {
  return JSON.stringify(value, (_key, element: unknown) => {
    if (typeof element === "bigint") return element.toString();
    if (element instanceof Uint8Array) return "<bytes>";
    return element;
  });
}

/** Whether `value`, rendered as JSON, mentions `needle`. */
function mentions(value: unknown, needle: string): boolean {
  if (value === undefined) return false;
  return renderJson(value).includes(needle);
}

type Row = Readonly<Record<string, unknown>>;

/** The label a relation is reported under: per-field vector tables are `vectors`. */
type RelationLabel = GraphRelationKey | "vectors";

const BUNDLED_RELATIONS: ReadonlySet<string> = new Set(GRAPH_RELATION_KEYS);

type TableScan = Readonly<{
  /** Relations with a row of this graph whose text contains the sentinel. */
  sentinel: readonly RelationLabel[];
  /** Relations with a row of this graph whose text contains the subject id. */
  subjectId: readonly RelationLabel[];
}>;

/**
 * Reads every row this store's graph holds, in every relation that can hold
 * one, straight from the tables, and reports which relations mention the
 * sentinel and which mention the subject's id.
 */
async function scanTables(store: ErasureStore): Promise<TableScan> {
  const inspection = await inspectGraphStorage(store);
  const sentinel = new Set<RelationLabel>();
  const subjectId = new Set<RelationLabel>();
  for (const relation of inspection.relations) {
    if (relation.rows === 0) continue;
    const label: RelationLabel =
      BUNDLED_RELATIONS.has(relation.relation) ?
        (relation.relation as GraphRelationKey)
      : "vectors";
    const rows = await store.backend.execute<Row>(
      asCompiledRowsSql(sql`
        SELECT * FROM ${sql.identifier(relation.table)}
        WHERE graph_id = ${store.graphId}
      `),
    );
    for (const row of rows) {
      const rendered = renderJson(row);
      if (rendered.includes(SENTINEL)) sentinel.add(label);
      if (rendered.includes(SUBJECT_ID)) subjectId.add(label);
    }
  }
  return {
    sentinel: [...sentinel].toSorted(),
    subjectId: [...subjectId].toSorted(),
  };
}

type Fixture = Readonly<{
  store: ErasureStore;
  history: HistoryStore<ErasureGraph> | undefined;
  /** After the subject's first version committed. */
  afterCreate: RecordedInstant | undefined;
  /** After the update, the edges and the assertion: just before the delete. */
  beforeDelete: RecordedInstant | undefined;
  /** The receipt the subject's create transaction returned. */
  createReceipt: TransactionReceipt;
  fulltext: boolean;
  /** The backend keeps embeddings in per-field vector tables. */
  vectors: boolean;
}>;

async function createFixtureStore(
  context: IntegrationTestContext,
  configuration: StoreConfiguration,
): Promise<
  Readonly<{
    store: ErasureStore;
    history: HistoryStore<ErasureGraph> | undefined;
  }>
> {
  const graph = buildGraph(nextGraphId());
  switch (configuration) {
    case "plain": {
      return { store: await context.createStore(graph), history: undefined };
    }
    case "revisionTracking": {
      const store = await context.createStore(graph, {
        revisionTracking: true,
      });
      return { store, history: undefined };
    }
    case "history": {
      const history = await context.createHistoryStore(graph);
      return { store: history as unknown as ErasureStore, history };
    }
  }
}

/**
 * The subject, written in two versions, with an incident edge to a witness, a
 * provenance premise edge, a `same` assertion with the witness, a unique key, a
 * fulltext row and (where the backend stores vectors) an embedding.
 */
async function seedFixture(
  context: IntegrationTestContext,
  configuration: StoreConfiguration,
): Promise<Fixture> {
  const { store, history } = await createFixtureStore(context, configuration);
  const vectors =
    store.backend.capabilities.vector?.supported === true &&
    store.backend.vectorStrategy !== undefined;
  const fulltext = store.backend.capabilities.fulltext?.supported === true;
  await store.nodes.ErasureWitness.create(
    { name: "witness" },
    { id: WITNESS_ID },
  );
  const justification = await store.nodes.ErasureJustification.create(
    { label: "justification" },
    { id: "justification-1" },
  );
  const fact = await store.nodes.ErasureFact.create(
    { label: "fact" },
    { id: "fact-1" },
  );
  await store.edges.erasureDerives.create(
    justification,
    fact,
    {},
    { id: "derives-1" },
  );
  const { receipt: createReceipt } = await store.transactionWithReceipt(
    async (tx) => {
      await tx.nodes.ErasureSubject.create(
        {
          email: SUBJECT_EMAIL,
          note: FIRST_NOTE,
          bio: `biography ${SENTINEL}`,
          retracted: false,
          ...(vectors ? { vector: [...SUBJECT_VECTOR] } : {}),
        },
        { id: SUBJECT_ID },
      );
    },
  );
  const afterCreate = await history?.recordedNow();
  await store.edges.erasureKnows.create(
    subjectRef,
    witnessRef,
    { note: `edge ${SENTINEL}` },
    { id: KNOWS_EDGE_ID },
  );
  await store.edges.erasurePremiseOf.create(
    subjectRef,
    justification,
    {},
    { id: PREMISE_EDGE_ID },
  );
  await store.identity.assertSame(subjectRef, witnessRef);
  await store.nodes.ErasureSubject.update(SUBJECT_ID as never, {
    note: SECOND_NOTE,
  });
  const beforeDelete = await history?.recordedNow();
  return {
    store,
    history,
    afterCreate,
    beforeDelete,
    createReceipt,
    fulltext,
    vectors,
  };
}

async function runOperation(
  store: ErasureStore,
  operation: Operation,
): Promise<void> {
  const subjects = store.nodes.ErasureSubject;
  switch (operation) {
    case "delete": {
      await subjects.delete(SUBJECT_ID as never);
      return;
    }
    case "hardDelete": {
      await subjects.hardDelete(SUBJECT_ID as never);
      return;
    }
    case "bulkHardDelete": {
      await subjects.bulkHardDelete([SUBJECT_ID as never]);
      return;
    }
  }
}

/** What a history store reconstructs at instants before and after the delete. */
type RecordedReads = Readonly<{
  noteAfterCreate: string | undefined;
  noteBeforeDelete: string | undefined;
  noteNow: string | undefined;
  knowsEdgeBeforeDelete: boolean;
  premiseEdgeBeforeDelete: boolean;
  witnessClassBeforeDelete: readonly string[];
  /** Entries `identity.transitionsOf(subject)` returns. */
  subjectTransitions: number;
}>;

type PublicReads = Readonly<{
  current: boolean;
  includeTombstones: boolean;
  includeEnded: boolean;
  knowsEdgeCurrent: boolean;
  knowsEdgeIncludeTombstones: boolean;
  premiseEdgeIncludeTombstones: boolean;
  uniqueKeyLookup: boolean;
  fulltextSearch: boolean;
  vectorSearch: boolean;
  subjectAssertions: number;
  witnessClass: readonly string[];
  recorded: RecordedReads | undefined;
}>;

/** What the public API returns for the subject, each answer as "mentions the sentinel". */
async function observePublicReads(fixture: Fixture): Promise<PublicReads> {
  const { store, history } = fixture;
  const tombstones = store.view({ mode: "includeTombstones" });
  const ended = store.view({ mode: "includeEnded" });
  const fulltextHits =
    fixture.fulltext ?
      await store.search.fulltext("ErasureSubject", {
        query: SENTINEL,
        limit: 10,
      })
    : [];
  const vectorHits =
    fixture.vectors ?
      await store.search.vector("ErasureSubject", {
        fieldPath: "vector",
        queryEmbedding: [...SUBJECT_VECTOR],
        limit: 10,
      })
    : [];
  const subjectAssertions = await store.identity.assertionsOf(subjectRef);
  const witnessClass = await store.identity.membersOf(witnessRef);
  return {
    current: mentions(
      await store.nodes.ErasureSubject.getById(SUBJECT_ID as never),
      SENTINEL,
    ),
    includeTombstones: mentions(
      await tombstones.nodes.ErasureSubject.getById(SUBJECT_ID as never),
      SENTINEL,
    ),
    includeEnded: mentions(
      await ended.nodes.ErasureSubject.getById(SUBJECT_ID as never),
      SENTINEL,
    ),
    knowsEdgeCurrent: mentions(
      await store.edges.erasureKnows.getById(KNOWS_EDGE_ID as never),
      SENTINEL,
    ),
    knowsEdgeIncludeTombstones: mentions(
      await tombstones.edges.erasureKnows.getById(KNOWS_EDGE_ID as never),
      SENTINEL,
    ),
    premiseEdgeIncludeTombstones:
      (await tombstones.edges.erasurePremiseOf.getById(
        PREMISE_EDGE_ID as never,
      )) !== undefined,
    uniqueKeyLookup: mentions(
      await store.nodes.ErasureSubject.findByConstraint(EMAIL_CONSTRAINT, {
        email: SUBJECT_EMAIL,
        note: "",
        bio: "",
      }),
      SENTINEL,
    ),
    fulltextSearch: fulltextHits.some(
      (hit) => (hit.node.id as string) === SUBJECT_ID,
    ),
    vectorSearch: vectorHits.some(
      (hit) => (hit.node.id as string) === SUBJECT_ID,
    ),
    subjectAssertions: subjectAssertions.length,
    witnessClass: memberIds(witnessClass),
    recorded:
      history === undefined ? undefined : (
        await observeRecordedReads(fixture, history)
      ),
  };
}

function memberIds(
  members: readonly Readonly<{ id: string }>[],
): readonly string[] {
  return members.map((member) => member.id).toSorted();
}

/** The facts the retraction capability holds, on a history store. */
async function provenanceHolding(
  fixture: Fixture,
): Promise<readonly string[] | undefined> {
  if (fixture.history === undefined) return undefined;
  const provenance = createRetractionCapability(
    fixture.history,
    PROVENANCE_CONFIG,
  );
  const holding = await provenance.holding();
  return holding.map((fact) => fact.id);
}

async function observeRecordedReads(
  fixture: Fixture,
  history: HistoryStore<ErasureGraph>,
): Promise<RecordedReads> {
  const afterCreate = history.asOfRecorded(requireDefined(fixture.afterCreate));
  const beforeDelete = history.asOfRecorded(
    requireDefined(fixture.beforeDelete),
  );
  const now = history.asOfRecorded(requireDefined(await history.recordedNow()));
  const noteAt = async (view: typeof now) => {
    const subject = await view.nodes.ErasureSubject.getById(
      SUBJECT_ID as never,
    );
    return subject?.note;
  };
  const witnessClassBeforeDelete =
    await beforeDelete.identity.membersOf(witnessRef);
  const transitions = await history.identity.transitionsOf(subjectRef);
  return {
    noteAfterCreate: await noteAt(afterCreate),
    noteBeforeDelete: await noteAt(beforeDelete),
    noteNow: await noteAt(now),
    knowsEdgeBeforeDelete: mentions(
      await beforeDelete.edges.erasureKnows.getById(KNOWS_EDGE_ID as never),
      SENTINEL,
    ),
    premiseEdgeBeforeDelete:
      (await beforeDelete.edges.erasurePremiseOf.getById(
        PREMISE_EDGE_ID as never,
      )) !== undefined,
    witnessClassBeforeDelete: memberIds(witnessClassBeforeDelete),
    subjectTransitions: transitions.transitions.length,
  };
}

/**
 * A scan without the revision journal, which the cases assert on its own: on
 * PostgreSQL it is trigger-maintained for the whole database, so whether a
 * graph that does not track revisions has journal rows depends on what else
 * ran there.
 */
function withoutJournal(scan: TableScan): TableScan {
  return {
    sentinel: scan.sentinel.filter((label) => label !== "revisionChanges"),
    subjectId: scan.subjectId.filter((label) => label !== "revisionChanges"),
  };
}

function journalNamesSubject(scan: TableScan): boolean {
  return scan.subjectId.includes("revisionChanges");
}

/** Every place the subject reaches before the operation, on this fixture. */
function expectedBaselineReads(
  fixture: Fixture,
  configuration: StoreConfiguration,
): PublicReads {
  return {
    current: true,
    includeTombstones: true,
    includeEnded: true,
    knowsEdgeCurrent: true,
    knowsEdgeIncludeTombstones: true,
    premiseEdgeIncludeTombstones: true,
    uniqueKeyLookup: true,
    fulltextSearch: fixture.fulltext,
    vectorSearch: fixture.vectors,
    subjectAssertions: 1,
    witnessClass: [SUBJECT_ID, WITNESS_ID],
    recorded:
      configuration === "history" ?
        {
          noteAfterCreate: FIRST_NOTE,
          noteBeforeDelete: SECOND_NOTE,
          noteNow: SECOND_NOTE,
          knowsEdgeBeforeDelete: true,
          premiseEdgeBeforeDelete: true,
          witnessClassBeforeDelete: [SUBJECT_ID, WITNESS_ID],
          subjectTransitions: 1,
        }
      : undefined,
  };
}

function sortedLabels(
  labels: readonly (RelationLabel | false)[],
): readonly RelationLabel[] {
  return labels
    .filter((label): label is RelationLabel => label !== false)
    .toSorted();
}

function expectedBaselineTables(
  fixture: Fixture,
  configuration: StoreConfiguration,
): TableScan {
  const history = configuration === "history";
  return {
    sentinel: sortedLabels([
      "nodes",
      "edges",
      "uniques",
      fixture.fulltext && "fulltext",
      history && "recordedNodes",
      history && "recordedEdges",
    ]),
    subjectId: sortedLabels([
      "nodes",
      "edges",
      "uniques",
      "identityAssertions",
      "identityClosure",
      fixture.fulltext && "fulltext",
      fixture.vectors && "vectors",
      history && "recordedNodes",
      history && "recordedEdges",
      history && "recordedIdentityAssertions",
      history && "identityTransitions",
    ]),
  };
}

/**
 * What the public API returns after the operation.
 *
 * Every operation hides the subject from current reads, search, uniqueness
 * lookups and the live identity class. A soft delete keeps the row and its
 * edges readable under `includeTombstones`. On a history store every
 * operation, hard deletes included, leaves both earlier versions of the
 * subject, its edges and its class membership readable at recorded instants
 * before the delete (#922).
 */
function expectedReadsAfter(
  configuration: StoreConfiguration,
  operation: Operation,
): PublicReads {
  const soft = operation === "delete";
  return {
    current: false,
    includeTombstones: soft,
    includeEnded: false,
    knowsEdgeCurrent: false,
    knowsEdgeIncludeTombstones: soft,
    premiseEdgeIncludeTombstones: soft,
    uniqueKeyLookup: false,
    fulltextSearch: false,
    vectorSearch: false,
    subjectAssertions: 0,
    witnessClass: [WITNESS_ID],
    recorded:
      configuration === "history" ?
        {
          // #922: recorded versions survive hardDelete and bulkHardDelete.
          noteAfterCreate: FIRST_NOTE,
          noteBeforeDelete: SECOND_NOTE,
          noteNow: undefined,
          // #922: the incident edges' recorded versions survive too.
          knowsEdgeBeforeDelete: true,
          premiseEdgeBeforeDelete: true,
          // #922: so does the subject's recorded class membership...
          witnessClassBeforeDelete: [SUBJECT_ID, WITNESS_ID],
          // ...and the transition log entries that name it (assert, detach).
          subjectTransitions: 2,
        }
      : undefined,
  };
}

/**
 * The relations that still mention the subject after the operation (the
 * revision journal aside).
 *
 * A soft delete keeps the node, edge and unique rows (all with the sentinel)
 * and the ended identity assertion, and removes the fulltext, embedding and
 * closure rows. A hard delete leaves nothing in the live relations; on a
 * history store the recorded node, edge and assertion rows and the transition
 * log keep the subject (#922).
 */
function expectedTablesAfter(
  configuration: StoreConfiguration,
  operation: Operation,
): TableScan {
  const history = configuration === "history";
  const soft = operation === "delete";
  return {
    sentinel: sortedLabels([
      soft && "nodes",
      soft && "edges",
      soft && "uniques",
      // #922: recorded node and edge versions keep the property values.
      history && "recordedNodes",
      history && "recordedEdges",
    ]),
    subjectId: sortedLabels([
      soft && "nodes",
      soft && "edges",
      soft && "uniques",
      soft && "identityAssertions",
      // #922: recorded rows and the transition log keep the subject's id.
      history && "recordedNodes",
      history && "recordedEdges",
      history && "recordedIdentityAssertions",
      history && "identityTransitions",
    ]),
  };
}

export function registerErasureAuditIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Erasure audit: what survives a node delete", () => {
    for (const configuration of STORE_CONFIGURATIONS) {
      for (const operation of OPERATIONS) {
        it(`${operation}() on a ${configuration} store`, async () => {
          const fixture = await seedFixture(context, configuration);
          // The retraction capability needs a history store. The subject is
          // the premise the fact holds through.
          expect(await provenanceHolding(fixture)).toEqual(
            configuration === "history" ? ["fact-1"] : undefined,
          );
          // A working copy forked before the delete holds its own copy.
          const forked = unwrap(
            await branch(fixture.store, () => context.createIsolatedBackend()),
          );
          const receiptBefore = renderJson(fixture.createReceipt);

          const baselineScan = await scanTables(fixture.store);
          expect(await observePublicReads(fixture)).toEqual(
            expectedBaselineReads(fixture, configuration),
          );
          expect(withoutJournal(baselineScan)).toEqual(
            expectedBaselineTables(fixture, configuration),
          );
          // A revision-tracked store journals every write's entity key.
          expect(
            configuration !== "revisionTracking" ||
              journalNamesSubject(baselineScan),
          ).toBe(true);

          await runOperation(fixture.store, operation);

          const scan = await scanTables(fixture.store);
          expect(await observePublicReads(fixture)).toEqual(
            expectedReadsAfter(configuration, operation),
          );
          expect(withoutJournal(scan)).toEqual(
            expectedTablesAfter(configuration, operation),
          );
          // The revision journal records entity keys, never property values:
          // it keeps the subject's id through every operation, never the
          // sentinel. (On PostgreSQL the journal is trigger-maintained for the
          // whole database once installed, so whether a history store's graph
          // has journal rows depends on what else ran there; the comparison
          // with the baseline holds either way.)
          expect(journalNamesSubject(scan)).toBe(
            journalNamesSubject(baselineScan),
          );
          expect(scan.sentinel).not.toContain("revisionChanges");

          // #922: the branch keeps the subject's properties after the base
          // store deletes it.
          const branchCopy = await forked.store.nodes.ErasureSubject.getById(
            SUBJECT_ID as never,
          );
          await forked.close();
          expect(branchCopy?.note).toBe(SECOND_NOTE);

          // A transaction receipt is a plain in-memory value of write counts:
          // it never held the subject's properties or id, and a later delete
          // does not touch it.
          expect(renderJson(fixture.createReceipt)).toBe(receiptBefore);
          expect(mentions(fixture.createReceipt, SENTINEL)).toBe(false);
          expect(mentions(fixture.createReceipt, SUBJECT_ID)).toBe(false);
        });
      }
    }

    it("an edge's hardDelete() and bulkHardDelete() on a history store leave its recorded versions readable", async () => {
      const fixture = await seedFixture(context, "history");
      const history = requireDefined(fixture.history);
      await history.edges.erasureKnows.hardDelete(KNOWS_EDGE_ID as never);
      await history.edges.erasurePremiseOf.bulkHardDelete([
        PREMISE_EDGE_ID as never,
      ]);
      const tombstones = history.view({ mode: "includeTombstones" });
      expect(
        await tombstones.edges.erasureKnows.getById(KNOWS_EDGE_ID as never),
      ).toBeUndefined();
      expect(
        await tombstones.edges.erasurePremiseOf.getById(
          PREMISE_EDGE_ID as never,
        ),
      ).toBeUndefined();

      // #922: both edges' recorded versions survive their hard deletes.
      const beforeDelete = history.asOfRecorded(
        requireDefined(fixture.beforeDelete),
      );
      const knows = await beforeDelete.edges.erasureKnows.getById(
        KNOWS_EDGE_ID as never,
      );
      expect(knows?.note).toBe(`edge ${SENTINEL}`);
      const premise = await beforeDelete.edges.erasurePremiseOf.getById(
        PREMISE_EDGE_ID as never,
      );
      expect(premise?.id).toBe(PREMISE_EDGE_ID);
      const scan = withoutJournal(await scanTables(fixture.store));
      expect(scan.sentinel).not.toContain("edges");
      expect(scan.sentinel).toContain("recordedEdges");
    });

    it("pruning recorded instants and identity transitions after hardDelete() keeps the recorded versions", async () => {
      const fixture = await seedFixture(context, "history");
      const history = requireDefined(fixture.history);
      await runOperation(fixture.store, "hardDelete");

      // Retire every allocation-log row, and every transition up to the next
      // commit (the highest watermark the log accepts).
      await history.pruneRecordedInstants("9999-12-31T23:59:59.999Z", {
        limit: 10_000,
      });
      const clock = requireDefined(await history.recordedNow());
      await pruneIdentityTransitions(history, {
        beforeRecorded: createRecordedInstant(
          recordedInstantRevision(clock) + 1,
          recordedInstantWallTime(clock),
          recordedInstantOwner(clock),
        ),
      });

      // The transition log no longer names the subject; the recorded node,
      // edge and assertion rows still do.
      const scan = withoutJournal(await scanTables(fixture.store));
      expect(scan.subjectId).not.toContain("identityTransitions");
      // #922: neither prune removes a recorded version.
      expect(scan).toEqual({
        sentinel: ["recordedEdges", "recordedNodes"],
        subjectId: [
          "recordedEdges",
          "recordedIdentityAssertions",
          "recordedNodes",
        ],
      });
      const beforeDelete = history.asOfRecorded(
        requireDefined(fixture.beforeDelete),
      );
      const subject = await beforeDelete.nodes.ErasureSubject.getById(
        SUBJECT_ID as never,
      );
      expect(subject?.note).toBe(SECOND_NOTE);
    });

    it("store.clear() after hardDelete() leaves no row of a history store's graph mentioning the subject", async () => {
      const fixture = await seedFixture(context, "history");
      await runOperation(fixture.store, "hardDelete");
      expect(withoutJournal(await scanTables(fixture.store)).sentinel).toEqual(
        expectedTablesAfter("history", "hardDelete").sentinel,
      );

      await fixture.store.clear();

      expect(await scanTables(fixture.store)).toEqual({
        sentinel: [],
        subjectId: [],
      });
    });
  });
}
