/**
 * A uniqueness claim is released by its owner, and keyed from validated
 * props only.
 *
 * Every write that moves a node off a unique value, or removes the node, gives
 * back "the claims this node holds for this constraint" — for an update, those
 * not equal to the key it now claims — rather than a claim whose key it
 * recomputes from the row it read back. A claim's key is derived from the
 * props the write validated, by the one key function, on every path.
 *
 * Recomputing a key from another representation of the same value is what
 * leaked: a `Date` keys as JSON while its stored ISO text keys raw, a
 * PostgreSQL JSONB object comes back in another key order, and an import under
 * `onUnknownProperty: "allow"` stated the document's text rather than the
 * value its schema produced. Each case below moves a row through one write
 * path and then requires the claim rows to be exactly the keys of the live
 * constrained nodes, read straight from the claim relation.
 *
 * REVERT CHECK: restoring main's `src` fails the date move and remove cases on
 * the lanes whose release is keyed (every move path; the per-row soft delete),
 * the lazy and nullable-union date kinds, the import cases, the piped
 * get-or-create resurrection and the provenance reopen; on PostgreSQL it also
 * fails every object-valued case (update, soft-delete resurrection, provenance
 * reopen, verbatim import). The revision before the stored-row key walk
 * ordered object keys by shape (e049992a) fails the last three on PostgreSQL. The legacy raw-form claim and recursive-union cases pass
 * on main and fail on the previous head of this change (aa064e84), which
 * keyed date fields from schema introspection; they guard against that shape
 * coming back.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type NodeId,
  UniquenessError,
} from "../../../src";
import { deriveBackend } from "../../../src/backend/derive-backend";
import { type TransactionBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import {
  exportGraph,
  FORMAT_VERSION,
  type GraphData,
  importGraph,
} from "../../../src/interchange";
import { createRetractionCapability } from "../../../src/provenance";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import { compareStrings } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

const DATE_KIND_NAMES = [
  "OcrEvent",
  "OcrLazyEvent",
  "OcrNullableEvent",
] as const;
type DateKindName = (typeof DATE_KIND_NAMES)[number];

const OcrEvent = defineNode("OcrEvent", {
  schema: z.object({ name: z.string(), at: z.date() }),
});

/** A date behind `z.lazy`: no introspection of the field can see it. */
const OcrLazyEvent = defineNode("OcrLazyEvent", {
  schema: z.object({ name: z.string(), at: z.lazy(() => z.date()) }),
});

/** A date inside a union with `null`. */
const OcrNullableEvent = defineNode("OcrNullableEvent", {
  schema: z.object({ name: z.string(), at: z.union([z.date(), z.null()]) }),
});

/** A date reached through a pipe: its input is text, its output a `Date`. */
const OcrPipedEvent = defineNode("OcrPipedEvent", {
  schema: z.object({
    name: z.string(),
    at: z.string().pipe(z.coerce.date()),
  }),
});

type OcrCode = string | Readonly<{ next: OcrCode }>;
const OcrCodeSchema: z.ZodType<OcrCode> = z.union([
  z.string(),
  z.object({
    get next() {
      return OcrCodeSchema;
    },
  }),
]);

/** A constrained field whose type is a recursive union. */
const OcrRecursive = defineNode("OcrRecursive", {
  schema: z.object({ code: OcrCodeSchema }),
});

/** An object-valued unique property, declared longest key first. */
const OcrBadge = defineNode("OcrBadge", {
  schema: z.object({ code: z.object({ zeta: z.string(), a: z.string() }) }),
});

/** A record-valued unique property: its validated key order is its input's. */
const OcrTagged = defineNode("OcrTagged", {
  schema: z.object({ tags: z.record(z.string(), z.string()) }),
});

/** A partial constraint: `email` is unique among rows not archived. */
const OcrMember = defineNode("OcrMember", {
  schema: z.object({
    name: z.string(),
    email: z.string(),
    archived: z.string().optional(),
  }),
});

/** Two constraints over different fields. */
const OcrPair = defineNode("OcrPair", {
  schema: z.object({ name: z.string(), left: z.string(), right: z.string() }),
});

const OcrSource = defineNode("OcrSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const OcrJustification = defineNode("OcrJustification", {
  schema: z.object({ label: z.string() }),
});

const ocrPremiseOf = defineEdge("ocrPremiseOf");
const ocrDerives = defineEdge("ocrDerives");

function uniqueOn(name: string, field: string, collation = "binary" as const) {
  return [{ name, fields: [field], scope: "kind", collation }] as const;
}

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      OcrEvent: { type: OcrEvent, unique: uniqueOn("OcrEvent_at", "at") },
      OcrLazyEvent: {
        type: OcrLazyEvent,
        unique: uniqueOn("OcrLazyEvent_at", "at"),
      },
      OcrNullableEvent: {
        type: OcrNullableEvent,
        unique: uniqueOn("OcrNullableEvent_at", "at"),
      },
      OcrPipedEvent: {
        type: OcrPipedEvent,
        unique: [
          {
            name: "OcrPipedEvent_at",
            fields: ["at"],
            scope: "kind",
            collation: "caseInsensitive",
          },
        ],
      },
      OcrRecursive: {
        type: OcrRecursive,
        unique: uniqueOn("OcrRecursive_code", "code"),
      },
      OcrBadge: { type: OcrBadge, unique: uniqueOn("OcrBadge_code", "code") },
      OcrTagged: {
        type: OcrTagged,
        unique: uniqueOn("OcrTagged_tags", "tags"),
      },
      OcrMember: {
        type: OcrMember,
        unique: [
          {
            name: "OcrMember_email",
            fields: ["email"],
            where: (fields) => requireDefined(fields["archived"]).isNull(),
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      OcrPair: {
        type: OcrPair,
        unique: [
          ...uniqueOn("OcrPair_left", "left"),
          ...uniqueOn("OcrPair_right", "right"),
        ],
      },
      OcrSource: { type: OcrSource },
      OcrJustification: { type: OcrJustification },
    },
    edges: {
      ocrPremiseOf: {
        type: ocrPremiseOf,
        from: [OcrSource, OcrEvent],
        to: [OcrJustification],
      },
      ocrDerives: {
        type: ocrDerives,
        from: [OcrJustification],
        to: [OcrEvent, OcrBadge],
      },
    },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `owner_claim_release_${graphIdCounter}`;
}

const A = new Date("2024-01-01T00:00:00.000Z");
const B = new Date("2024-02-01T00:00:00.000Z");

/**
 * The port a case's store writes through: the lane's bundled backend, or a
 * conformance double that implements `releaseUniquesByOwner` itself.
 */
type ClaimPort = Readonly<{
  name: string;
  wrap: (backend: GraphBackend) => GraphBackend;
  /** How many times the double's own release ran, when it has one. */
  releases?: () => number;
}>;

/**
 * A hand-written `releaseUniquesByOwner`: the reference implementation the
 * backend-authoring guide gives, one `UPDATE` over the claim relation by
 * owner and constraint, run on the target it is called on (a store write's
 * transaction), never the bundled operation strategy's statement.
 */
function referenceReleaseUniquesByOwner(
  target: GraphBackend | TransactionBackend,
  onRelease: () => void,
): GraphBackend["releaseUniquesByOwner"] {
  const executeStatement = requireDefined(target.executeStatement);
  const { uniques } = createSqlSchema(target.tableNames).tables;
  return async (params) => {
    onRelease();
    if (params.constraintNames.length === 0) return;
    const constraints = sql.join(
      params.constraintNames.map((name) => sql`${name}`),
      sql`, `,
    );
    const kept =
      params.keep.length === 0 ?
        sql``
      : sql` AND ("constraint_name", "key") NOT IN (VALUES ${sql.join(
          params.keep.map((held) => sql`(${held.constraintName}, ${held.key})`),
          sql`, `,
        )})`;
    await executeStatement(
      asCompiledStatementSql(sql`
        UPDATE ${sql.identifier(uniques)}
        SET "deleted_at" = ${new Date().toISOString()}
        WHERE "graph_id" = ${params.graphId}
          AND "concrete_kind" = ${params.concreteKind}
          AND "node_id" = ${params.nodeId}
          AND "deleted_at" IS NULL
          AND "constraint_name" IN (${constraints})${kept}
      `),
    );
  };
}

function referenceReleasePort(): ClaimPort {
  let releases = 0;
  const onRelease = () => {
    releases += 1;
  };
  return {
    name: "a hand-written releaseUniquesByOwner",
    wrap: (backend) =>
      deriveBackend(backend, {
        releaseUniquesByOwner: referenceReleaseUniquesByOwner(
          backend,
          onRelease,
        ),
        transaction: (fn, options) =>
          backend.transaction(
            (transaction) =>
              fn(
                deriveBackend(transaction, {
                  releaseUniquesByOwner: referenceReleaseUniquesByOwner(
                    transaction,
                    onRelease,
                  ),
                }),
              ),
            options,
          ),
      }),
    releases: () => releases,
  };
}

const BUNDLED_PORT: ClaimPort = {
  name: "the bundled backend",
  wrap: (backend) => backend,
};

async function createGraphStore(
  context: IntegrationTestContext,
  port: ClaimPort,
) {
  const graphId = nextGraphId();
  const backend = port.wrap(context.getBackend());
  const [store] = await createStoreWithSchema(buildGraph(graphId), backend);
  return { graphId, store, backend };
}

type OcrStore = Awaited<ReturnType<typeof createGraphStore>>["store"];
type EventCollection = OcrStore["nodes"]["OcrEvent"];
type EventId = NodeId<typeof OcrEvent>;

/**
 * The collection of one date kind. The three date kinds share their props'
 * TypeScript shape, so one collection type serves them all.
 */
function dateNodes(store: OcrStore, kind: DateKindName): EventCollection {
  return store.nodes[kind] as unknown as EventCollection;
}

/** The key the store claims for a validated value of one field. */
function keyOf(field: string, value: unknown, collation = "binary" as const) {
  return computeUniqueKey({ [field]: value }, [field], collation);
}

type LiveClaim = Readonly<{
  constraint_name: string;
  key: string;
  node_id: string;
}>;

/** Every live claim of the graph, read straight from the claim relation. */
async function liveClaims(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
  constraintName: string,
): Promise<readonly LiveClaim[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<LiveClaim>(
    asCompiledRowsSql(sql`
      SELECT constraint_name, key, node_id
      FROM ${sql.identifier(schema.tables.uniques)}
      WHERE graph_id = ${graphId}
        AND constraint_name = ${constraintName}
        AND deleted_at IS NULL
    `),
  );
  return rows
    .map((row) => ({
      constraint_name: row.constraint_name,
      key: row.key,
      node_id: row.node_id,
    }))
    .toSorted((left, right) => compareStrings(left.node_id, right.node_id));
}

function claim(constraintName: string, key: string, nodeId: string) {
  return { constraint_name: constraintName, key, node_id: nodeId };
}

async function expectNoViolations(store: OcrStore): Promise<void> {
  expect(await store.verifyConstraintFences()).toEqual([]);
}

/** Whether a write was refused, by error name, or completed. */
async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "written";
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

/** A call's result, or the name of the error it threw. */
async function outcomeOf<T>(call: () => Promise<T>): Promise<T | string> {
  try {
    return await call();
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

/** Replaces a node's claim with the one an earlier writer left in its place. */
async function plantClaim(
  backend: GraphBackend,
  graphId: string,
  kind: string,
  nodeId: string,
  constraintName: string,
  keys: Readonly<{ taken: string; planted: string }>,
): Promise<void> {
  await backend.deleteUnique({
    graphId,
    nodeKind: kind,
    constraintName,
    key: keys.taken,
    concreteKind: kind,
    nodeId,
  });
  await backend.insertUnique({
    graphId,
    nodeKind: kind,
    constraintName,
    key: keys.planted,
    nodeId,
    concreteKind: kind,
  });
}

type MovePath = Readonly<{
  name: string;
  move: (nodes: EventCollection, store: OcrStore, id: EventId) => Promise<void>;
}>;

/** Write paths that move the row `id` from A to B. */
const MOVE_PATHS: readonly MovePath[] = [
  {
    name: "update",
    move: async (nodes, _store, id) => {
      await nodes.update(id, { at: B });
    },
  },
  {
    name: "upsertById",
    move: async (nodes, _store, id) => {
      await nodes.upsertById(id, { name: "row", at: B });
    },
  },
  {
    name: "bulkUpsertById",
    move: async (nodes, _store, id) => {
      await nodes.bulkUpsertById([{ id, props: { name: "row", at: B } }]);
    },
  },
  {
    name: "bulkReplaceById",
    move: async (nodes, _store, id) => {
      await nodes.bulkReplaceById([{ id, props: { name: "row", at: B } }]);
    },
  },
  {
    name: "update inside a transaction",
    move: async (_nodes, store, id) => {
      await store.transaction(async (tx) => {
        await tx.nodes.OcrEvent.update(id, { at: B });
      });
    },
  },
];

type RemovePath = Readonly<{
  name: string;
  remove: (
    nodes: EventCollection,
    store: OcrStore,
    id: EventId,
  ) => Promise<void>;
}>;

/** Write paths that remove the row `id`. */
const REMOVE_PATHS: readonly RemovePath[] = [
  { name: "delete", remove: (nodes, _store, id) => nodes.delete(id) },
  { name: "bulkDelete", remove: (nodes, _store, id) => nodes.bulkDelete([id]) },
  { name: "hardDelete", remove: (nodes, _store, id) => nodes.hardDelete(id) },
  {
    name: "delete inside a transaction",
    remove: (_nodes, store, id) =>
      store.transaction(async (tx) => {
        await tx.nodes.OcrEvent.delete(id);
      }),
  },
];

/** The claim members of the backend port, each one statement when it runs. */
const CLAIM_MEMBERS = [
  "checkUnique",
  "checkUniqueBatch",
  "insertUnique",
  "insertUniqueBatch",
  "deleteUnique",
  "releaseUniquesByOwner",
] as const;
type ClaimMember = (typeof CLAIM_MEMBERS)[number];

type ClaimCallCounter = Readonly<{
  backend: GraphBackend;
  calls: () => Readonly<Partial<Record<ClaimMember, number>>>;
  reset: () => void;
}>;

/**
 * A derived backend that counts every call to a claim member, on the root
 * backend and on every transaction it opens (a store write runs its claim
 * statements on its transaction).
 */
function createClaimCallCounter(backend: GraphBackend): ClaimCallCounter {
  let counts: Partial<Record<ClaimMember, number>> = {};
  function counted<B extends GraphBackend | TransactionBackend>(target: B) {
    const overrides: Record<string, unknown> = {};
    for (const member of CLAIM_MEMBERS) {
      const original = target[member] as
        ((...args: readonly unknown[]) => Promise<unknown>) | undefined;
      if (original === undefined) continue;
      overrides[member] = (...args: readonly unknown[]) => {
        counts = { ...counts, [member]: (counts[member] ?? 0) + 1 };
        return original(...args);
      };
    }
    return deriveBackend(target, overrides as never);
  }
  const counting = deriveBackend(counted(backend), {
    transaction: (fn, options) =>
      backend.transaction((transaction) => fn(counted(transaction)), options),
  });
  return {
    backend: counting,
    calls: () => counts,
    reset: () => {
      counts = {};
    },
  };
}

function interchangeDocument(
  nodes: GraphData["nodes"],
  description = "owner claim release",
): GraphData {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external", description },
    nodes,
    edges: [],
  };
}

export function registerOwnerClaimReleaseIntegrationTests(
  context: IntegrationTestContext,
): void {
  for (const port of [BUNDLED_PORT, referenceReleasePort()]) {
    describe(`through ${port.name}`, () => {
      registerOwnerClaimReleaseCases(context, port);
    });
  }
  registerPatchStatementCases(context);
  registerInterleavedUpdateCases(context);
}

function registerOwnerClaimReleaseCases(
  context: IntegrationTestContext,
  port: ClaimPort,
): void {
  describe("a uniqueness claim is released by its owner", () => {
    for (const kind of DATE_KIND_NAMES) {
      const constraintName = `${kind}_at`;
      // The transaction paths address `OcrEvent` directly.
      const movePaths =
        kind === "OcrEvent" ? MOVE_PATHS : (
          MOVE_PATHS.filter((path) => !path.name.includes("transaction"))
        );
      const removePaths =
        kind === "OcrEvent" ? REMOVE_PATHS : (
          REMOVE_PATHS.filter((path) => !path.name.includes("transaction"))
        );

      for (const path of movePaths) {
        it(`${kind} ${path.name}: the row holds exactly the date it moved to`, async () => {
          const { graphId, store, backend } = await createGraphStore(
            context,
            port,
          );
          const nodes = dateNodes(store, kind);
          const row = await nodes.create({ name: "row", at: A }, { id: "row" });

          await path.move(nodes, store, row.id);

          expect(await liveClaims(backend, graphId, constraintName)).toEqual([
            claim(constraintName, keyOf("at", B), "row"),
          ]);
          const taker = await nodes.create({ name: "taker", at: A });
          await expect(
            nodes.create({ name: "intruder", at: B }),
          ).rejects.toBeInstanceOf(UniquenessError);
          const found = await nodes.findByConstraint(constraintName, {
            name: "probe",
            at: A,
          });
          expect(found?.id).toBe(taker.id);
          await expectNoViolations(store);
        });
      }

      for (const path of removePaths) {
        it(`${kind} ${path.name}: a removed row holds no claim`, async () => {
          const { graphId, store, backend } = await createGraphStore(
            context,
            port,
          );
          const nodes = dateNodes(store, kind);
          const row = await nodes.create({ name: "row", at: A }, { id: "row" });

          await path.remove(nodes, store, row.id);

          expect(await liveClaims(backend, graphId, constraintName)).toEqual(
            [],
          );
          await nodes.create({ name: "taker", at: A });
          await expectNoViolations(store);
        });
      }
    }

    it("an update that keeps the date keeps exactly its claim", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });

      await store.nodes.OcrEvent.update("row" as EventId, { name: "renamed" });

      expect(await liveClaims(backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", A), "row"),
      ]);
      await expect(
        store.nodes.OcrEvent.create({ name: "intruder", at: A }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });

    it("a soft-deleted row resurrected by upsert reclaims its date, and its next delete releases it", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });
      await store.nodes.OcrEvent.delete("row" as EventId);

      await store.nodes.OcrEvent.upsertById("row", { name: "row", at: A });
      expect(await liveClaims(backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", A), "row"),
      ]);

      await store.nodes.OcrEvent.delete("row" as EventId);
      expect(await liveClaims(backend, graphId, "OcrEvent_at")).toEqual([]);
    });

    it("a claim left in the raw text form is released by the owner's next move of the key and its delete", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });
      await store.nodes.OcrEvent.create(
        { name: "other", at: B },
        { id: "other" },
      );
      await plantClaim(backend, graphId, "OcrEvent", "row", "OcrEvent_at", {
        taken: keyOf("at", A),
        planted: A.toISOString(),
      });
      await plantClaim(backend, graphId, "OcrEvent", "other", "OcrEvent_at", {
        taken: keyOf("at", B),
        planted: B.toISOString(),
      });

      // An update that moves the key gives back every claim its owner held
      // under the constraint, the raw-form one included; a delete releases
      // whatever form its claim is in.
      await store.nodes.OcrEvent.delete("other" as EventId);
      await store.nodes.OcrEvent.update("row" as EventId, { at: B });

      expect(await liveClaims(backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", B), "row"),
      ]);
      await expectNoViolations(store);
    });

    // PostgreSQL's JSONB returns `{ zeta, a }` as `{ a, zeta }`. A create keys
    // the object in its shape's order, so every path keying the stored row
    // must reproduce that order, or it names a claim the create never took.
    it("an object-valued claim is released by the owner's update on every backend", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      await store.nodes.OcrBadge.create(
        { code: { zeta: "z", a: "a" } },
        { id: "badge" },
      );

      await store.nodes.OcrBadge.update("badge" as NodeId<typeof OcrBadge>, {
        code: { zeta: "y", a: "b" },
      });

      expect(await liveClaims(backend, graphId, "OcrBadge_code")).toEqual([
        claim("OcrBadge_code", keyOf("code", { zeta: "y", a: "b" }), "badge"),
      ]);
      await store.nodes.OcrBadge.create({ code: { zeta: "z", a: "a" } });
      await expectNoViolations(store);
    });

    it("a soft-deleted object-valued row is resurrected by get-or-create under its own id", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      await store.nodes.OcrBadge.create(
        { code: { zeta: "z", a: "a" } },
        { id: "badge" },
      );
      await store.nodes.OcrBadge.delete("badge" as NodeId<typeof OcrBadge>);

      const result = await store.nodes.OcrBadge.getOrCreateByConstraint(
        "OcrBadge_code",
        { code: { zeta: "z", a: "a" } },
      );

      expect({
        action: result.action,
        id: result.node.id,
        claims: await liveClaims(backend, graphId, "OcrBadge_code"),
        duplicate: await outcome(() =>
          store.nodes.OcrBadge.create({ code: { zeta: "z", a: "a" } }),
        ),
      }).toEqual({
        action: "resurrected",
        id: "badge",
        claims: [
          claim("OcrBadge_code", keyOf("code", { zeta: "z", a: "a" }), "badge"),
        ],
        duplicate: "UniquenessError",
      });
      await expectNoViolations(store);
    });

    it("an object-valued fact reopened by provenance reclaims the key a create claims", async () => {
      const store = await context.createHistoryStore(buildGraph(nextGraphId()));
      const source = await store.nodes.OcrSource.create(
        { label: "source", retracted: false },
        { id: "source" },
      );
      const fact = await store.nodes.OcrBadge.create(
        { code: { zeta: "z", a: "a" } },
        { id: "fact" },
      );
      const justification = await store.nodes.OcrJustification.create(
        { label: "justification" },
        { id: "justification" },
      );
      await store.edges.ocrPremiseOf.create(source, justification, {});
      await store.edges.ocrDerives.create(justification, fact, {});
      const provenance = createRetractionCapability(store, {
        source: { kind: "OcrSource" },
        justification: { kind: "OcrJustification" },
        fact: { kinds: ["OcrBadge"] },
        premiseOf: { kind: "ocrPremiseOf" },
        derives: { kind: "ocrDerives" },
      });

      await provenance.retract(source);
      await provenance.unRetract(source);

      expect({
        claims: await liveClaims(store.backend, store.graphId, "OcrBadge_code"),
        duplicate: await outcome(() =>
          store.nodes.OcrBadge.create({ code: { zeta: "z", a: "a" } }),
        ),
      }).toEqual({
        claims: [
          claim("OcrBadge_code", keyOf("code", { zeta: "z", a: "a" }), "fact"),
        ],
        duplicate: "UniquenessError",
      });
    });

    // A piped date's input is text and its output a `Date`. The key owner
    // follows the pipe to its output, so a tombstone's stored text keys as
    // the `Date` a create claimed and the lookup finds it. The get-or-create
    // update and resurrection legs then hand the matched row the props the
    // lookup validated, which the update re-validates as input and refuses, as
    // on main. Pinned, not repaired here.
    it("getOrCreateByConstraint finds a soft-deleted row holding a piped date and refuses to resurrect it", async () => {
      const { store } = await createGraphStore(context, port);
      await store.nodes.OcrPipedEvent.create(
        { name: "row", at: A.toISOString() },
        { id: "row" },
      );
      await store.nodes.OcrPipedEvent.delete(
        "row" as NodeId<typeof OcrPipedEvent>,
      );

      const result = await outcomeOf(() =>
        store.nodes.OcrPipedEvent.getOrCreateByConstraint("OcrPipedEvent_at", {
          name: "again",
          at: A.toISOString(),
        }),
      );

      expectObservation({
        lane: { driver: context.driver },
        observed:
          typeof result === "string" ? result : (
            { action: result.action, revivedRow: result.node.id === "row" }
          ),
        correct: { action: "resurrected", revivedRow: true },
        defects: [
          {
            label: "get-or-create update re-validates validated props",
            on: {},
            today: "ValidationError",
          },
        ],
      });
      await expectNoViolations(store);
    });

    it("bulkGetOrCreateByConstraint refuses to update a row holding a piped date", async () => {
      const { store } = await createGraphStore(context, port);
      await store.nodes.OcrPipedEvent.create(
        { name: "live", at: B.toISOString() },
        { id: "live" },
      );

      expectObservation({
        lane: { driver: context.driver },
        observed: await outcome(() =>
          store.nodes.OcrPipedEvent.bulkGetOrCreateByConstraint(
            "OcrPipedEvent_at",
            [{ props: { name: "renamed", at: B.toISOString() } }],
            { ifExists: "update" },
          ),
        ),
        correct: "written",
        defects: [
          {
            label: "get-or-create update re-validates validated props",
            on: {},
            today: "ValidationError",
          },
        ],
      });
    });

    it("getOrCreateByConstraint refuses to update a live row holding a piped date", async () => {
      const { store } = await createGraphStore(context, port);
      await store.nodes.OcrPipedEvent.create(
        { name: "row", at: A.toISOString() },
        { id: "row" },
      );

      expectObservation({
        lane: { driver: context.driver },
        observed: await outcome(() =>
          store.nodes.OcrPipedEvent.getOrCreateByConstraint(
            "OcrPipedEvent_at",
            { name: "renamed", at: A.toISOString() },
            { ifExists: "update" },
          ),
        ),
        correct: "written",
        defects: [
          {
            label: "get-or-create update re-validates validated props",
            on: {},
            today: "ValidationError",
          },
        ],
      });
    });

    // An import under "allow" writes the document's value verbatim, and the
    // key owner reads the text under a pipe whose output is a date as that
    // date: the claim is the one a create of the `Date` claims. Main keyed
    // the text and admitted the duplicate.
    it("an import under onUnknownProperty allow keys a piped date as a create of the date does", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      const imported = await importGraph(
        store,
        interchangeDocument([
          {
            kind: "OcrPipedEvent",
            id: "row",
            properties: {
              name: "row",
              at: A.toISOString(),
              legacyNote: "kept",
            },
          },
        ]),
        { onConflict: "error", onUnknownProperty: "allow" },
      );
      expect(imported.errors).toEqual([]);

      expect({
        claims: await liveClaims(backend, graphId, "OcrPipedEvent_at"),
        duplicate: await outcome(() =>
          store.nodes.OcrPipedEvent.create({
            name: "dup",
            at: A.toISOString(),
          }),
        ),
      }).toEqual({
        claims: [
          claim("OcrPipedEvent_at", keyOf("at", A).toLowerCase(), "row"),
        ],
        duplicate: "UniquenessError",
      });
    });

    it("an import update under onUnknownProperty allow releases the date the row moves off", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      await store.nodes.OcrPipedEvent.create(
        { name: "row", at: A.toISOString() },
        { id: "row" },
      );

      const imported = await importGraph(
        store,
        interchangeDocument([
          {
            kind: "OcrPipedEvent",
            id: "row",
            properties: {
              name: "row",
              at: B.toISOString(),
              legacyNote: "kept",
            },
          },
        ]),
        { onConflict: "update", onUnknownProperty: "allow" },
      );
      expect(imported.errors).toEqual([]);

      // The new claim is keyed as a create of the date (see above); the old
      // one is released by owner.
      expect(await liveClaims(backend, graphId, "OcrPipedEvent_at")).toEqual([
        claim("OcrPipedEvent_at", keyOf("at", B).toLowerCase(), "row"),
      ]);
      await store.nodes.OcrPipedEvent.create({
        name: "taker",
        at: A.toISOString(),
      });
      await expectNoViolations(store);
    });

    // An import under "allow" keys the object value it writes verbatim, which
    // a PostgreSQL export hands back in JSONB's key order. The key owner
    // puts it back in the shape's order, so it collides with a create
    // of the same value (PR #1005's "import claim key: JSONB key order", which
    // main still has).
    it("an object-valued unique property imported under allow collides with a create of the same value", async () => {
      const source = await context.createStore(buildGraph(nextGraphId()));
      await source.nodes.OcrBadge.create(
        { code: { zeta: "z", a: "a" } },
        { id: "badge" },
      );
      const exported = await exportGraph(source);
      const { store } = await createGraphStore(context, port);
      const imported = await importGraph(
        store,
        {
          ...exported,
          nodes: exported.nodes.map((node) => ({
            ...node,
            properties: { ...node.properties, legacyNote: "kept" },
          })),
        },
        { onConflict: "error", onUnknownProperty: "allow" },
      );
      expect(imported.errors).toEqual([]);
      expect(
        await outcome(() =>
          store.nodes.OcrBadge.create({ code: { zeta: "z", a: "a" } }),
        ),
      ).toBe("UniquenessError");
    });

    // PR #1005 pinned this as "date claim release" (and, on better-sqlite3,
    // "date claim release (delete too)"). Release by owner closes it.
    it("a write that replaces or deletes a unique date releases the old date", async () => {
      const source = await context.createStore(buildGraph(nextGraphId()));
      await source.nodes.OcrEvent.create(
        { name: "imported", at: B },
        { id: "imported" },
      );
      const exported = await exportGraph(source);
      const { store } = await createGraphStore(context, port);
      await store.nodes.OcrEvent.create(
        { name: "imported", at: A },
        { id: "imported" },
      );
      await store.nodes.OcrEvent.create(
        { name: "deleted", at: new Date("2023-01-01T00:00:00.000Z") },
        { id: "deleted" },
      );
      // The exported text, revived to the `Date` the schema reads.
      const imported = await importGraph(
        store,
        {
          ...exported,
          nodes: exported.nodes.map((node) => ({
            ...node,
            properties: {
              ...node.properties,
              at: new Date(String(node.properties["at"])),
            },
          })),
        },
        { onConflict: "update", onUnknownProperty: "error" },
      );
      await store.nodes.OcrEvent.delete("deleted" as EventId);

      expect({
        importErrors: imported.errors.length,
        afterImport: await outcome(() =>
          store.nodes.OcrEvent.create({ name: "a", at: A }),
        ),
        afterDelete: await outcome(() =>
          store.nodes.OcrEvent.create({
            name: "c",
            at: new Date("2023-01-01T00:00:00.000Z"),
          }),
        ),
      }).toEqual({
        importErrors: 0,
        afterImport: "written",
        afterDelete: "written",
      });
    });

    it("a fact reopened by provenance reclaims its date in the form a create claims", async () => {
      const store = await context.createHistoryStore(buildGraph(nextGraphId()));
      const source = await store.nodes.OcrSource.create(
        { label: "source", retracted: false },
        { id: "source" },
      );
      const fact = await store.nodes.OcrEvent.create(
        { name: "fact", at: A },
        { id: "fact" },
      );
      const justification = await store.nodes.OcrJustification.create(
        { label: "justification" },
        { id: "justification" },
      );
      await store.edges.ocrPremiseOf.create(source, justification, {});
      await store.edges.ocrDerives.create(justification, fact, {});
      const provenance = createRetractionCapability(store, {
        source: { kind: "OcrSource" },
        justification: { kind: "OcrJustification" },
        fact: { kinds: ["OcrEvent"] },
        premiseOf: { kind: "ocrPremiseOf" },
        derives: { kind: "ocrDerives" },
      });

      await provenance.retract(source);
      await provenance.unRetract(source);

      expect(
        await liveClaims(store.backend, store.graphId, "OcrEvent_at"),
      ).toEqual([claim("OcrEvent_at", keyOf("at", A), "fact")]);
      expect(
        await outcome(() =>
          store.nodes.OcrEvent.create({ name: "dup", at: A }),
        ),
      ).toBe("UniquenessError");
    });

    it("a constrained field typed as a recursive union keys an ordinary string", async () => {
      const { store } = await createGraphStore(context, port);
      await store.nodes.OcrRecursive.create({ code: "root" });
      await expect(
        store.nodes.OcrRecursive.create({ code: "root" }),
      ).rejects.toBeInstanceOf(UniquenessError);
      await store.nodes.OcrRecursive.create({
        code: { next: { next: "root" } },
      });
    });
  });

  describe("claims keyed in another form before release by owner (documented, not repaired)", () => {
    it("a legacy raw-form claim does not fence a create of the same date until its owner is rewritten", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });
      await plantClaim(backend, graphId, "OcrEvent", "row", "OcrEvent_at", {
        taken: keyOf("at", A),
        planted: A.toISOString(),
      });

      const duplicate = await outcome(() =>
        store.nodes.OcrEvent.create({ name: "dup", at: A }, { id: "dup" }),
      );
      expectObservation({
        lane: { driver: context.driver },
        observed: duplicate,
        correct: "UniquenessError",
        defects: [
          {
            label: "legacy raw-form date claim",
            on: {},
            today: "written",
          },
        ],
      });

      // An update that leaves the key where it was leaves the claim alone,
      // whether or not it restates the field.
      await store.nodes.OcrEvent.update("row" as EventId, { name: "renamed" });
      await store.nodes.OcrEvent.update("row" as EventId, { at: A });
      const heldAfterRename = await liveClaims(backend, graphId, "OcrEvent_at");
      expect(heldAfterRename.filter((held) => held.node_id === "row")).toEqual([
        claim("OcrEvent_at", A.toISOString(), "row"),
      ]);

      // The repair: moving the owner's key off the value gives back every
      // claim it held under the constraint, and moving it back claims the
      // value in the form a create claims — surfacing the duplicate the legacy
      // key let in.
      await store.nodes.OcrEvent.update("row" as EventId, { at: B });
      const rewriteWithDuplicate = await outcome(() =>
        store.nodes.OcrEvent.update("row" as EventId, { at: A }),
      );
      expect(rewriteWithDuplicate).toBe(
        duplicate === "written" ? "UniquenessError" : "written",
      );
      if (duplicate === "written") {
        await store.nodes.OcrEvent.hardDelete("dup" as EventId);
      }
      await store.nodes.OcrEvent.update("row" as EventId, { at: A });
      expect(await liveClaims(backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", A), "row"),
      ]);
      expect(
        await outcome(() =>
          store.nodes.OcrEvent.create({ name: "dup", at: A }),
        ),
      ).toBe("UniquenessError");
    });

    // The documented legacy state: one node holds a date claim under its raw
    // text, and a second node, admitted beside it, the canonical claim. A
    // rename of the first leaves its key where it was, so the scalar update
    // issues no claim statement. The same rename through `bulkUpsertById()`
    // takes the set-based path, whose final validation re-checks every claim
    // of the row and meets the second node's. Pinned, not repaired here.
    it("a key-preserving rename of a node holding a legacy raw-form claim succeeds as an update and through bulkUpsertById", async () => {
      const { graphId, store, backend } = await createGraphStore(context, port);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });
      await plantClaim(backend, graphId, "OcrEvent", "row", "OcrEvent_at", {
        taken: keyOf("at", A),
        planted: A.toISOString(),
      });
      await store.nodes.OcrEvent.create({ name: "dup", at: A }, { id: "dup" });

      const scalar = await outcome(() =>
        store.nodes.OcrEvent.update("row" as EventId, { name: "renamed" }),
      );
      const bulk = await outcome(() =>
        store.nodes.OcrEvent.bulkUpsertById([
          { id: "row", props: { name: "renamed again", at: A } },
        ]),
      );

      expectObservation({
        lane: { driver: context.driver },
        observed: { scalar, bulk },
        correct: { scalar: "written", bulk: "written" },
        defects: [
          {
            label: "bulk update re-checks a key-preserving legacy claim",
            on: {},
            today: { scalar: "written", bulk: "UniquenessError" },
          },
        ],
      });
    });

    it("a record-valued unique property round-tripped through PostgreSQL does not fence a create in its original key order", async () => {
      const source = await context.createStore(buildGraph(nextGraphId()));
      await source.nodes.OcrTagged.create(
        { tags: { zeta: "z", a: "a" } },
        { id: "tagged" },
      );
      const exported = await exportGraph(source);
      const { store, backend } = await createGraphStore(context, port);
      const imported = await importGraph(store, exported, {
        onConflict: "error",
        onUnknownProperty: "error",
      });
      expect(imported.errors).toEqual([]);

      expectObservation({
        lane: { dialect: backend.dialect },
        observed: await outcome(() =>
          store.nodes.OcrTagged.create({ tags: { zeta: "z", a: "a" } }),
        ),
        correct: "UniquenessError",
        defects: [
          {
            label: "record key order through JSONB",
            on: { dialect: ["postgres"] },
            today: "written",
          },
        ],
      });
    });
  });

  const releases = port.releases;
  if (releases !== undefined) {
    it("an update and a delete release through the port's own member", async () => {
      const { store } = await createGraphStore(context, port);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });
      const before = releases();
      await store.nodes.OcrEvent.update("row" as EventId, { at: B });
      await store.nodes.OcrEvent.delete("row" as EventId);
      expect(releases() - before).toBe(2);
    });
  }
}

/** A store over a backend that counts its claim-member calls. */
async function createCountingStore(context: IntegrationTestContext) {
  const graphId = nextGraphId();
  const counter = createClaimCallCounter(context.getBackend());
  const [store] = await createStoreWithSchema(
    buildGraph(graphId),
    counter.backend,
  );
  return { graphId, store, counter, backend: counter.backend };
}

function registerPatchStatementCases(context: IntegrationTestContext): void {
  describe("an update that moves no key issues no claim statement", () => {
    it("an update of an unconstrained field probes and releases nothing, root and in a transaction", async () => {
      const { graphId, store, counter, backend } =
        await createCountingStore(context);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });

      counter.reset();
      await store.nodes.OcrEvent.update("row" as EventId, { name: "renamed" });
      await store.transaction(async (tx) => {
        await tx.nodes.OcrEvent.update("row" as EventId, { name: "again" });
      });
      await store.nodes.OcrEvent.update("row" as EventId, {});
      expect(counter.calls()).toEqual({});

      expect(await liveClaims(backend, graphId, "OcrEvent_at")).toEqual([
        claim("OcrEvent_at", keyOf("at", A), "row"),
      ]);
      await expect(
        store.nodes.OcrEvent.create({ name: "intruder", at: A }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });

    it("an update that restates a constrained field with its current value issues no claim statement", async () => {
      const { store, counter } = await createCountingStore(context);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });

      counter.reset();
      await store.nodes.OcrEvent.update("row" as EventId, { at: A });
      expect(counter.calls()).toEqual({});
    });

    it("a wholesale replacement that keeps every key issues no claim statement", async () => {
      const { store, counter } = await createCountingStore(context);
      await store.nodes.OcrEvent.create({ name: "row", at: A }, { id: "row" });

      counter.reset();
      await store.nodes.OcrEvent.upsertById("row", { name: "replaced", at: A });
      expect(counter.calls()).toEqual({});
    });

    it("only the constraints whose key moves are probed and released", async () => {
      const { graphId, store, counter, backend } =
        await createCountingStore(context);
      const pairs = store.nodes.OcrPair;
      await pairs.create(
        { name: "row", left: "l1", right: "r1" },
        { id: "row" },
      );

      counter.reset();
      await pairs.update("row" as NodeId<typeof OcrPair>, { left: "l2" });
      expect(counter.calls()).toEqual({
        checkUnique: 1,
        insertUnique: 1,
        releaseUniquesByOwner: 1,
      });
      expect([
        ...(await liveClaims(backend, graphId, "OcrPair_left")),
        ...(await liveClaims(backend, graphId, "OcrPair_right")),
      ]).toEqual([
        claim("OcrPair_left", keyOf("left", "l2"), "row"),
        claim("OcrPair_right", keyOf("right", "r1"), "row"),
      ]);
      await pairs.create({ name: "taker", left: "l1", right: "r2" });
    });

    it("a patch of the field a partial constraint's where reads moves its claim", async () => {
      const { graphId, store, backend } = await createCountingStore(context);
      const members = store.nodes.OcrMember;
      type MemberId = NodeId<typeof OcrMember>;
      await members.create(
        { name: "row", email: "a@example.test" },
        { id: "row" },
      );

      await members.update("row" as MemberId, { archived: "yes" });
      expect(await liveClaims(backend, graphId, "OcrMember_email")).toEqual([]);
      await members.create(
        { name: "successor", email: "a@example.test" },
        { id: "successor" },
      );

      await members.hardDelete("successor" as MemberId);
      await members.update("row" as MemberId, { archived: undefined });
      expect(await liveClaims(backend, graphId, "OcrMember_email")).toEqual([
        claim("OcrMember_email", keyOf("email", "a@example.test"), "row"),
      ]);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });
  });
}

/**
 * A backend whose next `getNode` read, once armed, runs `intervene` on the
 * same target right after the read returns: a write committed by another
 * session between an update's read of the row and its own row write, as
 * READ COMMITTED allows on a server PostgreSQL. The two-connection form of the
 * same schedule, and every other update entry point, live in
 * `update-row-version.ts`.
 */
function createReadInterleaver(
  backend: GraphBackend,
  intervene: (target: GraphBackend | TransactionBackend) => Promise<void>,
) {
  let armed = false;
  function interleaved<B extends GraphBackend | TransactionBackend>(target: B) {
    return deriveBackend(target, {
      getNode: async (graphId: string, kind: string, id: string) => {
        const row = await target.getNode(graphId, kind, id);
        if (armed) {
          armed = false;
          await intervene(target);
        }
        return row;
      },
    } as never);
  }
  return {
    backend: deriveBackend(interleaved(backend), {
      transaction: (fn, options) =>
        backend.transaction((tx) => fn(interleaved(tx)), options),
    }),
    arm: () => {
      armed = true;
    },
  };
}

type InterleavedField = Readonly<{
  name: string;
  kind: "OcrEvent" | "OcrPair";
  constraintName: string;
  field: string;
  /** The props the row is created with, and the props the racing move writes. */
  created: Record<string, unknown>;
  moved: Record<string, unknown>;
  /** The constrained value before and after the racing move, as validated. */
  before: unknown;
  after: unknown;
  /** The stored constrained value, as text. */
  storedText: (props: Record<string, unknown>) => string;
}>;

const INTERLEAVED_FIELDS: readonly InterleavedField[] = [
  {
    name: "a z.date() field",
    kind: "OcrEvent",
    constraintName: "OcrEvent_at",
    field: "at",
    created: { name: "row", at: A },
    moved: { name: "row", at: B.toISOString() },
    before: A,
    after: B,
    storedText: (props) => new Date(String(props["at"])).toISOString(),
  },
  {
    name: "a z.string() field",
    kind: "OcrPair",
    constraintName: "OcrPair_left",
    field: "left",
    created: { name: "row", left: "l1", right: "r1" },
    moved: { name: "row", left: "l2", right: "r1" },
    before: "l1",
    after: "l2",
    storedText: (props) => String(props["left"]),
  },
];

function registerInterleavedUpdateCases(context: IntegrationTestContext): void {
  describe("an update racing another update of the same row (READ COMMITTED)", () => {
    // The row holds `before`. Update 1 patches an unrelated field and reads
    // `before`; update 2 then moves the row to `after`, claims it, releases
    // `before` and commits. Update 1's row write is predicated on the version
    // it read, so it matches nothing; update 1 re-reads the row, re-applies its
    // patch over `after` and plans its claims from it. The row holds `after`
    // and the patched name, its one claim is `after`, and a create of `after`
    // is refused. Before the version predicate, update 1 wrote its whole props
    // back — `before` included — while its claim decision compared `before`
    // with `before`: the row held `before`, its claim was `after`, and a
    // duplicate of `before` was admitted.
    for (const shape of INTERLEAVED_FIELDS) {
      it(`a patch of an unrelated field that read the row before a concurrent move re-applies to the moved row (${shape.name})`, async () => {
        const graphId = nextGraphId();
        const claimOf = (value: unknown) => ({
          graphId,
          nodeKind: shape.kind,
          constraintName: shape.constraintName,
          key: keyOf(shape.field, value),
          concreteKind: shape.kind,
          nodeId: "row",
        });
        const interleaver = createReadInterleaver(
          context.getBackend(),
          async (target) => {
            // A store write, version increment included: the predicate the
            // update's own row write carries is what this move falsifies.
            await target.updateNode({
              graphId,
              kind: shape.kind,
              id: "row",
              props: shape.moved,
              incrementVersion: true,
            });
            await target.insertUnique(claimOf(shape.after));
            await target.deleteUnique(claimOf(shape.before));
          },
        );
        const [store] = await createStoreWithSchema(
          buildGraph(graphId),
          interleaver.backend,
        );
        const nodes = store.nodes[shape.kind] as unknown as EventCollection;
        await nodes.create(shape.created as never, { id: "row" });

        interleaver.arm();
        const updated = await nodes.update("row" as EventId, {
          name: "renamed",
        });

        expect({
          name: (updated as Record<string, unknown>)["name"],
          stored: shape.storedText(updated as Record<string, unknown>),
          claims: await liveClaims(
            interleaver.backend,
            graphId,
            shape.constraintName,
          ),
          duplicate: await outcome(() =>
            nodes.create({
              name: "dup",
              [shape.field]: shape.after,
              ...(shape.kind === "OcrPair" && { right: "r9" }),
            } as never),
          ),
          vacated: await outcome(() =>
            nodes.create({
              name: "vacated",
              [shape.field]: shape.before,
              ...(shape.kind === "OcrPair" && { right: "r8" }),
            } as never),
          ),
        }).toEqual({
          name: "renamed",
          stored: shape.storedText(shape.moved),
          claims: [
            claim(shape.constraintName, keyOf(shape.field, shape.after), "row"),
          ],
          duplicate: "UniquenessError",
          vacated: "written",
        });
      });
    }
  });
}
