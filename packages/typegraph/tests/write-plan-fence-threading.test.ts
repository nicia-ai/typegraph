/**
 * THE FENCE-THREADING ORACLE.
 *
 * A fence is what a write's verdict READ, carried into the statement that
 * honors it. This file characterizes that threading for every fenced write
 * shape as it behaves TODAY, before any call site moves onto the write
 * pipeline, so the batches that move them have a before/after that is not
 * their own author's opinion. It is never edited again: a batch that needs it
 * edited has changed behavior, which the migration forbids.
 *
 * Two halves, both load-bearing, and they fail for different reasons:
 *
 *  - **The predicate is emitted when the verdict read the bound.** A node or
 *    edge update that names a `validTo` judges it against the row's stored
 *    `valid_from`, so the UPDATE's own `WHERE` must carry that bound — the
 *    racing recreate then matches nothing.
 *  - **…and NOT when it did not.** A props-only update names no window, reads
 *    no bound, and must stay unfenced. Predicating it on a value nobody
 *    claimed refuses writes that are legitimate, which is the same defect in
 *    the opposite direction — and the one interchange import actually shipped.
 *
 * Statements are read off drizzle's `logger`, which sees the emitted SQL
 * rather than the params object a caller assembled: what is under test is what
 * reached the engine.
 *
 * Named mutations (B0-time, since no call site is on the pipeline yet):
 *  - make `node-write-pipeline.ts`'s `expectedValidFrom` assignment
 *    unconditional → the props-only node case fails;
 *  - delete that assignment → the windowed node case fails;
 *  - drop `...windowVerdict.storedLowerBoundFence` from `edge-operations.ts`'s
 *    update params → the windowed edge case fails;
 *  - drop the identity `kind` from those params → the edge identity case
 *    fails.
 * From B1 onward the same cases are threaded by `applyValidityLowerBound` in
 * `write-fences.ts`, and its no-op mutation is what makes them fail; the
 * applier-level cases at the bottom of this file pin that today.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  defineEdge,
  defineGraph,
  defineNode,
} from "../src";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import { type GraphBackend } from "../src/backend/types";
import {
  type GraphData,
  importGraph,
  type ImportOptions,
  ImportOptionsSchema,
} from "../src/interchange";
import { createStore, type Store } from "../src/store";
import {
  applyWriteFences,
  createWriteParamsDraft,
  EDGE_UPDATE_FENCE_APPLIERS,
  NODE_SET_UPDATE_FENCE_APPLIERS,
  NODE_UPDATE_FENCE_APPLIERS,
  UnsupportedWriteFenceError,
} from "../src/store/operations/write-fences";
import { type WriteSession } from "../src/store/operations/write-session";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const knows = defineEdge("knows", { schema: z.object({ note: z.string() }) });

const graph = defineGraph({
  id: "write_plan_fence_threading",
  nodes: { Person: { type: Person } },
  edges: {
    knows: { type: knows, from: [Person], to: [Person], cardinality: "many" },
  },
});

const NODE_ID = "person-a";
const NODE_REF = asNodeId<typeof Person>(NODE_ID);
const OTHER_ID = "person-b";
const EDGE_ID = "edge-a";
const EDGE_REF = asEdgeId<typeof knows>(EDGE_ID);
const LATE_BOUND = "2090-01-01T00:00:00.000Z";
const LATER_BOUND = "2091-01-01T00:00:00.000Z";
const EXPORTED_AT = "2024-01-01T00:00:00.000Z";

/**
 * ONE PGlite instance and ONE store for the whole table, created once and
 * shared: instance creation plus DDL dominates the cost of these cases, and
 * paying it per case would put a characterization oracle well over the unit
 * lane's time budget for no additional coverage. The statement log is cleared
 * per case instead.
 *
 * PGlite rather than SQLite because drizzle's `logger` is the seam that sees
 * the emitted SQL: the SQLite adapter runs its writes through its own compiled
 * statement path, where a drizzle logger observes nothing.
 */
const statements: string[] = [];

let store: Store<typeof graph>;
let closeClient: () => Promise<void>;

beforeAll(async () => {
  const client = await PGlite.create();
  closeClient = () => client.close();
  await client.exec(generatePostgresDDL().join("\n\n"));
  const backend: GraphBackend = createPostgresBackend(
    drizzle(client, {
      logger: {
        logQuery(query: string): void {
          statements.push(query);
        },
      },
    }),
    { vector: false },
  );
  store = createStore(graph, backend);
  await store.nodes.Person.create({ name: "Alice" }, { id: NODE_ID });
  await store.nodes.Person.create({ name: "Bob" }, { id: OTHER_ID });
  await store.edges.knows.create(
    { kind: "Person", id: NODE_ID },
    { kind: "Person", id: OTHER_ID },
    { note: "original" },
    { id: EDGE_ID },
  );
});

afterAll(async () => {
  await closeClient();
});

beforeEach(() => {
  statements.splice(0);
});

/**
 * The predicate half of a statement. `valid_from` also appears in the SET
 * clause of a window-writing update, so "is this write fenced?" is a question
 * about the `WHERE` and nowhere else.
 */
function predicateOf(statement: string): string {
  const where = statement.toLowerCase().indexOf("where");
  return where === -1 ? "" : statement.slice(where);
}

function updatesOf(table: string): readonly string[] {
  return statements.filter(
    (statement) => /^\s*update/i.test(statement) && statement.includes(table),
  );
}

function fencedUpdatesOf(table: string): readonly string[] {
  return updatesOf(table).filter((statement) =>
    predicateOf(statement).includes("valid_from"),
  );
}

function importOptions(
  overrides: Partial<ImportOptions>,
): ReturnType<typeof ImportOptionsSchema.parse> {
  return ImportOptionsSchema.parse(overrides);
}

function importDocument(
  overrides: Readonly<{ note: string; validTo?: string }>,
): GraphData {
  const { note, ...temporal } = overrides;
  return {
    formatVersion: "2.0",
    exportedAt: EXPORTED_AT,
    source: { type: "external" },
    nodes: [],
    edges: [
      {
        kind: "knows",
        id: EDGE_ID,
        from: { kind: "Person", id: NODE_ID },
        to: { kind: "Person", id: OTHER_ID },
        properties: { note },
        ...temporal,
      },
    ],
  };
}

describe("a write carries exactly the bound its verdict read", () => {
  it("emits NO valid_from predicate for a props-only NODE update", async () => {
    await store.nodes.Person.update(NODE_REF, { name: "Alice II" });

    expect(updatesOf("typegraph_nodes").length).toBeGreaterThan(0);
    expect(fencedUpdatesOf("typegraph_nodes")).toEqual([]);
  });

  it("emits the valid_from predicate for a windowed NODE update", async () => {
    // A stated `validTo` with no `validFrom` is judged against the row's
    // STORED lower bound, so the write owes that bound as a predicate.
    await store.nodes.Person.update(
      NODE_REF,
      { name: "Alice III" },
      { validTo: LATE_BOUND },
    );

    expect(fencedUpdatesOf("typegraph_nodes").length).toBe(1);
  });

  it("emits NO valid_from predicate for a props-only EDGE update", async () => {
    await store.edges.knows.update(EDGE_REF, { note: "revised" });

    expect(updatesOf("typegraph_edges").length).toBeGreaterThan(0);
    expect(fencedUpdatesOf("typegraph_edges")).toEqual([]);
  });

  it("carries the asserted edge identity into every edge UPDATE", async () => {
    await store.edges.knows.update(EDGE_REF, { note: "identity leg" });

    // The kind the caller asserted is in the `WHERE` on every leg, fenced or
    // not: it is a component the caller CLAIMED, so the row written is
    // provably the row that was judged.
    const [update] = updatesOf("typegraph_edges");
    expect(predicateOf(update ?? "")).toContain("kind");
  });

  it("emits the valid_from predicate for a windowed EDGE update", async () => {
    await store.edges.knows.update(
      EDGE_REF,
      { note: "revised again" },
      { validTo: LATE_BOUND },
    );

    expect(fencedUpdatesOf("typegraph_edges").length).toBe(1);
  });

  it("emits NO valid_from predicate for a props-only IMPORT edge update", async () => {
    await importGraph(
      store,
      importDocument({ note: "imported" }),
      importOptions({ onConflict: "update" }),
    );

    expect(updatesOf("typegraph_edges").length).toBeGreaterThan(0);
    expect(fencedUpdatesOf("typegraph_edges")).toEqual([]);
  });

  it("emits the valid_from predicate for a windowed IMPORT edge update", async () => {
    await importGraph(
      store,
      importDocument({ note: "imported again", validTo: LATER_BOUND }),
      importOptions({ onConflict: "update" }),
    );

    expect(fencedUpdatesOf("typegraph_edges").length).toBe(1);
  });
});

/**
 * The appliers are the seam those cases move onto, so they are pinned
 * directly too: an applier that dropped its fence would leave every case above
 * passing until the batch that switches the call sites over.
 *
 * Named mutation: make `applyValidityLowerBound` a no-op → the "carries"
 * cases fail; make it apply unconditionally → the "asserts nothing" case
 * fails; replace the set-update applier's `throw` with a `return` → the
 * refusal case fails.
 */
describe("fence appliers", () => {
  it("carries a stated lower bound into the draft", () => {
    const draft = createWriteParamsDraft();
    applyWriteFences(
      NODE_UPDATE_FENCE_APPLIERS,
      { validityLowerBound: { expectedValidFrom: LATE_BOUND } },
      draft,
    );
    expect(draft).toEqual({ expectedValidFrom: LATE_BOUND });
  });

  it("carries an explicit `no lower bound` claim, which is not the same as none", () => {
    const draft = createWriteParamsDraft();
    applyWriteFences(
      NODE_UPDATE_FENCE_APPLIERS,
      // eslint-disable-next-line unicorn/no-null -- `null` asserts IS NULL; an absent key asserts nothing.
      { validityLowerBound: { expectedValidFrom: null } },
      draft,
    );
    // eslint-disable-next-line unicorn/no-null -- see above
    expect(draft).toEqual({ expectedValidFrom: null });
  });

  it("leaves the draft untouched when the fence asserts nothing", () => {
    const draft = createWriteParamsDraft();
    applyWriteFences(
      NODE_UPDATE_FENCE_APPLIERS,
      { validityLowerBound: {} },
      draft,
    );
    expect(draft).toEqual({});
  });

  it("carries every asserted edge identity component and no other", () => {
    const draft = createWriteParamsDraft();
    applyWriteFences(
      EDGE_UPDATE_FENCE_APPLIERS,
      {
        validityLowerBound: {},
        validityUpperBound: {},
        edgeIdentity: { kind: "knows", fromKind: "Person", fromId: NODE_ID },
      },
      draft,
    );
    expect(draft).toEqual({
      kind: "knows",
      fromKind: "Person",
      fromId: NODE_ID,
    });
  });

  it("carries the window END a reopen's verdict read, and only then", () => {
    // The claim architecture's `oneActive` reopen judges the row's stored
    // `valid_to` and re-admits the row to the counted active population, so its
    // UPDATE must assert that end. Every other edge update read no end and
    // asserts none — the same "only what the verdict read" rule the lower bound
    // follows, with the same failure mode if it is over-applied: a props-only
    // update predicated on `valid_to` refuses legitimate writes.
    const stated = createWriteParamsDraft();
    applyWriteFences(
      EDGE_UPDATE_FENCE_APPLIERS,
      {
        validityLowerBound: {},
        validityUpperBound: { expectedValidTo: LATE_BOUND },
        edgeIdentity: { kind: "knows" },
      },
      stated,
    );
    expect(stated).toEqual({ kind: "knows", expectedValidTo: LATE_BOUND });

    const empty = createWriteParamsDraft();
    applyWriteFences(
      EDGE_UPDATE_FENCE_APPLIERS,
      {
        validityLowerBound: {},
        validityUpperBound: {},
        edgeIdentity: { kind: "knows" },
      },
      empty,
    );
    expect(empty).toEqual({ kind: "knows" });
  });

  it("distinguishes an explicit `still open-ended` claim from none", () => {
    const draft = createWriteParamsDraft();
    applyWriteFences(
      EDGE_UPDATE_FENCE_APPLIERS,
      {
        validityLowerBound: {},
        // eslint-disable-next-line unicorn/no-null -- `null` asserts `valid_to IS NULL`; an absent key asserts nothing.
        validityUpperBound: { expectedValidTo: null },
        edgeIdentity: { kind: "knows" },
      },
      draft,
    );
    // eslint-disable-next-line unicorn/no-null -- see above
    expect(draft).toEqual({ kind: "knows", expectedValidTo: null });
  });

  it("refuses a lower-bound fence the set UPDATE has no field to carry", () => {
    const draft = createWriteParamsDraft();
    expect(() => {
      applyWriteFences(
        NODE_SET_UPDATE_FENCE_APPLIERS,
        { validityLowerBound: { expectedValidFrom: LATE_BOUND } },
        draft,
      );
    }).toThrow(UnsupportedWriteFenceError);
    // Refused, not degraded: nothing reached the statement either.
    expect(draft).toEqual({});
  });

  it("runs the same set update normally when it asserts nothing", () => {
    const draft = createWriteParamsDraft();
    applyWriteFences(
      NODE_SET_UPDATE_FENCE_APPLIERS,
      { validityLowerBound: {} },
      draft,
    );
    expect(draft).toEqual({});
  });
});

describe("a fenced session method cannot be called without its fence", () => {
  it("rejects an omitted fence record at compile time", () => {
    // I6(a): every key of a fence record is REQUIRED, so "I forgot to pass the
    // fence" is a type error rather than a silently unfenced write. This line
    // IS the check — if the key ever became optional the `@ts-expect-error`
    // would be unused and `pnpm typecheck` would fail (tsconfig includes
    // tests).
    // @ts-expect-error -- an empty fence record omits the required key
    const fences: Parameters<WriteSession["reviseNode"]>[1] = {};
    expect(fences).toEqual({});
  });

  it("rejects an omitted fence record on the SET update too", () => {
    // The same check for `reviseNodeSet`, landing with the method it
    // constrains (B1b). The set UPDATE cannot HONOR this fence — it has no
    // field for it — but the caller must still STATE that it asserts nothing:
    // "the statement cannot carry it" and "nobody passed it" must not look
    // the same at the call site.
    // @ts-expect-error -- an empty fence record omits the required key
    const fences: Parameters<WriteSession["reviseNodeSet"]>[1] = {};
    expect(fences).toEqual({});
  });

  it("rejects an edge update that states its window but not its identity", () => {
    // The same check for `reviseEdge` (B2), whose record has TWO required keys
    // — so the omission this catches is a PARTIAL fence, which is the shape a
    // real caller would get wrong: it stated the bound its verdict read and
    // forgot the identity components it also asserted.
    // @ts-expect-error -- `edgeIdentity` is required and is not stated here
    const fences: Parameters<WriteSession["reviseEdge"]>[1] = {
      validityLowerBound: {},
      validityUpperBound: {},
    };
    expect(fences).toEqual({
      validityLowerBound: {},
      validityUpperBound: {},
    });
  });
});
