/**
 * One key owner for every path: a unique value claims the same key whichever
 * path writes or looks it up.
 *
 * The key owner (`uniqueConstraintKey`) puts each value in one canonical
 * rendering before keying it, so a write's parse output and a row read back
 * from storage key identically: a `Date` and its stored ISO text, an object
 * in whatever key order a `.default()` literal, the caller or PostgreSQL's
 * `jsonb` gave it. Each case below drives one path with one value shape and
 * requires the claim relation to hold exactly the key a create of the value
 * holds — stated as the literal bytes — and a second create of the value to be
 * refused.
 *
 * The shapes are the ones a key could split on: a top-level date, a date
 * behind `z.lazy()`, a nested object given in another key order, and an
 * object produced by a `.default()` whose literal order differs from the
 * shape's.
 *
 * REVERT CHECK: see the report. With the previous head's `src`, the lazy-date
 * cases fail on the import (allow), resurrection, provenance and merge paths,
 * and the default-object cases fail on the import paths (the parse keyed the
 * literal order, the import the shape order); on PostgreSQL the nested and
 * default object cases fail on every path that reads a stored row back.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type NodeId,
} from "../../../src";
import { computeUniqueKey } from "../../../src/constraints";
import { isErr, unwrap } from "../../../src/graph-merge";
import { branch } from "../../../src/graph-merge/branch";
import { merge } from "../../../src/graph-merge/merge";
import { asBranchId } from "../../../src/graph-merge/types";
import { FORMAT_VERSION, importGraph } from "../../../src/interchange";
import { createRetractionCapability } from "../../../src/provenance";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { compareStrings } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

const PAIR = z.object({ zeta: z.string(), a: z.string() });

const CkoDate = defineNode("CkoDate", {
  schema: z.object({ name: z.string(), v: z.date() }),
});
const CkoLazyDate = defineNode("CkoLazyDate", {
  schema: z.object({ name: z.string(), v: z.lazy(() => z.date()) }),
});
const CkoNested = defineNode("CkoNested", {
  schema: z.object({ name: z.string(), v: PAIR }),
});
/** A default whose literal states `a` before `zeta`, the shape the reverse. */
const CkoDefault = defineNode("CkoDefault", {
  schema: z.object({
    name: z.string(),
    v: PAIR.default({ a: "a", zeta: "z" }),
  }),
});

/**
 * A default object of fixed literals, its literal stating `a` before `zeta`:
 * the default is the only value the field can hold, so no update moves it.
 */
const CkoFixed = defineNode("CkoFixed", {
  schema: z.object({
    name: z.string(),
    v: z
      .object({ zeta: z.literal("z"), a: z.literal("a") })
      .default({ a: "a", zeta: "z" }),
  }),
});

const CkoSource = defineNode("CkoSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const CkoJustification = defineNode("CkoJustification", {
  schema: z.object({ label: z.string() }),
});
const ckoPremiseOf = defineEdge("ckoPremiseOf");
const ckoDerives = defineEdge("ckoDerives");

type ShapeKind = "CkoDate" | "CkoLazyDate" | "CkoNested" | "CkoDefault";

function uniqueOn(kind: ShapeKind | "CkoFixed") {
  return [
    {
      name: `${kind}_v`,
      fields: ["v"],
      scope: "kind",
      collation: "binary",
    } as const,
  ];
}

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      CkoDate: { type: CkoDate, unique: uniqueOn("CkoDate") },
      CkoLazyDate: { type: CkoLazyDate, unique: uniqueOn("CkoLazyDate") },
      CkoNested: { type: CkoNested, unique: uniqueOn("CkoNested") },
      CkoDefault: { type: CkoDefault, unique: uniqueOn("CkoDefault") },
      CkoFixed: { type: CkoFixed, unique: uniqueOn("CkoFixed") },
      CkoSource: { type: CkoSource },
      CkoJustification: { type: CkoJustification },
    },
    edges: {
      ckoPremiseOf: {
        type: ckoPremiseOf,
        from: [CkoSource],
        to: [CkoJustification],
      },
      ckoDerives: {
        type: ckoDerives,
        from: [CkoJustification],
        to: [CkoDate, CkoLazyDate, CkoNested, CkoDefault],
      },
    },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `claim_key_owner_${graphIdCounter}`;
}

const AT = "2024-03-04T05:06:07.000Z";
const OTHER_AT = "2025-06-07T08:09:10.000Z";

type Shape = Readonly<{
  kind: ShapeKind;
  /** The `v` a create states; absent lets the default supply it. */
  input: (() => unknown) | undefined;
  /** Another value, for a write that moves the key away. */
  other: () => unknown;
  /** The value as an interchange document states it. */
  document: () => unknown;
  /** The exact key bytes a create of `input` claims. */
  key: string;
}>;

const SHAPES: readonly Shape[] = [
  {
    kind: "CkoDate",
    input: () => new Date(AT),
    other: () => new Date(OTHER_AT),
    document: () => new Date(AT),
    key: `"${AT}"`,
  },
  {
    kind: "CkoLazyDate",
    input: () => new Date(AT),
    other: () => new Date(OTHER_AT),
    document: () => new Date(AT),
    key: `"${AT}"`,
  },
  {
    kind: "CkoNested",
    input: () => ({ a: "a", zeta: "z" }),
    other: () => ({ a: "b", zeta: "y" }),
    document: () => ({ a: "a", zeta: "z" }),
    key: `{"zeta":"z","a":"a"}`,
  },
  {
    kind: "CkoDefault",
    input: undefined,
    other: () => ({ a: "b", zeta: "y" }),
    document: () => ({ a: "a", zeta: "z" }),
    key: `{"zeta":"z","a":"a"}`,
  },
];

/** What the cases read off a store: its claims, and its shape kinds. */
type CkoStore = Readonly<{
  backend: Pick<GraphBackend, "execute" | "tableNames">;
  graphId: string;
  nodes: object;
}>;

function createCkoStore(context: IntegrationTestContext, graphId: string) {
  return context.createStore(buildGraph(graphId), { revisionTracking: true });
}

/** The collection of a shape's kind, typed loosely enough to drive all four. */
type ShapeCollection = Readonly<{
  create: (
    props: Record<string, unknown>,
    options?: Readonly<{ id?: string }>,
  ) => Promise<Readonly<{ id: string }>>;
  update: (id: never, props: Record<string, unknown>) => Promise<unknown>;
  delete: (id: never) => Promise<unknown>;
  getOrCreateByConstraint: (
    constraintName: string,
    props: Record<string, unknown>,
  ) => Promise<Readonly<{ action: string; node: Readonly<{ id: string }> }>>;
  bulkCreate: (
    items: readonly Readonly<{
      props: Record<string, unknown>;
      id?: string;
    }>[],
  ) => Promise<unknown>;
  bulkUpsertById: (
    items: readonly Readonly<{
      id: string;
      props: Record<string, unknown>;
    }>[],
  ) => Promise<unknown>;
}>;

function collectionOf(store: CkoStore, kind: ShapeKind): ShapeCollection {
  return (store.nodes as Record<ShapeKind, unknown>)[kind] as ShapeCollection;
}

/** The `v` a create of the shape states, or `undefined` for its default. */
function inputOf(shape: Shape): unknown {
  return shape.input?.();
}

/** The props a create of the shape's value states. */
function propsOf(name: string, value: unknown): Record<string, unknown> {
  return value === undefined ? { name } : { name, v: value };
}

type LiveClaim = Readonly<{ key: string; node_id: string }>;

/** Every live claim of one constraint, read straight from the claim relation. */
async function liveClaims(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
  constraintName: string,
): Promise<readonly LiveClaim[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<LiveClaim>(
    asCompiledRowsSql(sql`
      SELECT key, node_id
      FROM ${sql.identifier(schema.tables.uniques)}
      WHERE graph_id = ${graphId}
        AND constraint_name = ${constraintName}
        AND deleted_at IS NULL
    `),
  );
  return rows
    .map((row) => ({ key: row.key, node_id: row.node_id }))
    .toSorted((left, right) => compareStrings(left.node_id, right.node_id));
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

/** The claims of a shape's constraint and the fate of a second create. */
async function claimState(
  store: CkoStore,
  shape: Shape,
): Promise<Readonly<{ claims: readonly LiveClaim[]; duplicate: string }>> {
  return {
    claims: await liveClaims(store.backend, store.graphId, `${shape.kind}_v`),
    duplicate: await outcome(() =>
      collectionOf(store, shape.kind).create(
        propsOf("duplicate", inputOf(shape)),
        { id: "duplicate" },
      ),
    ),
  };
}

function heldBy(shape: Shape, nodeId: string) {
  return {
    claims: [{ key: shape.key, node_id: nodeId }],
    duplicate: "UniquenessError",
  };
}

/** A one-node interchange document for a shape's kind. */
function interchangeDocument(
  shape: Shape,
  id: string,
  properties: Record<string, unknown>,
) {
  return {
    formatVersion: FORMAT_VERSION,
    exportedAt: new Date().toISOString(),
    source: { type: "external" as const, description: "claim key owner" },
    nodes: [{ kind: shape.kind, id, properties }],
    edges: [],
  };
}

/** The document properties stating the shape's value, plus any extras. */
function documentProperties(
  shape: Shape,
  name: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { name, v: shape.document(), ...extra };
}

export function registerClaimKeyOwnerIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("one key owner: every path claims the key a create claims", () => {
    for (const shape of SHAPES) {
      describe(`the ${shape.kind} shape`, () => {
        it("create claims the stated key", async () => {
          const store = await createCkoStore(context, nextGraphId());
          await collectionOf(store, shape.kind).create(
            propsOf("row", inputOf(shape)),
            { id: "row" },
          );
          expect(await claimState(store, shape)).toEqual(heldBy(shape, "row"));
        });

        it("an update onto the value claims the key, and an update of another field keeps it", async () => {
          const store = await createCkoStore(context, nextGraphId());
          const collection = collectionOf(store, shape.kind);
          await collection.create(propsOf("row", shape.other()), { id: "row" });
          await collection.update("row" as never, {
            v: inputOf(shape) ?? shape.document(),
          });
          const moved = await claimState(store, shape);
          // A patch of another field re-parses the stored row, and stored-date
          // revival (an input-side decision, separate from the key) does not
          // follow `z.lazy()`, so the lazy date's stored text is refused. The
          // same on main.
          const renamed = await outcome(() =>
            collection.update("row" as never, { name: "renamed" }),
          );
          expect(moved).toEqual(heldBy(shape, "row"));
          expectObservation({
            lane: { driver: context.driver, kind: shape.kind },
            observed: { renamed, ...(await claimState(store, shape)) },
            correct: { renamed: "written", ...heldBy(shape, "row") },
            defects: [
              {
                label: "stored-date revival does not follow z.lazy",
                on: { kind: ["CkoLazyDate"] },
                today: { renamed: "ValidationError", ...heldBy(shape, "row") },
              },
            ],
          });
        });

        for (const onUnknownProperty of ["error", "allow"] as const) {
          it(`an import under onUnknownProperty ${onUnknownProperty} claims the key, as a create and as an update`, async () => {
            const store = await createCkoStore(context, nextGraphId());
            const extra =
              onUnknownProperty === "allow" ? { legacyNote: "kept" } : {};
            const created = await importGraph(
              store,
              interchangeDocument(
                shape,
                "row",
                documentProperties(shape, "row", extra),
              ),
              { onConflict: "error", onUnknownProperty },
            );
            expect(created.errors).toEqual([]);
            expect(await claimState(store, shape)).toEqual(
              heldBy(shape, "row"),
            );

            await collectionOf(store, shape.kind).update("row" as never, {
              v: shape.other(),
            });
            const updated = await importGraph(
              store,
              interchangeDocument(
                shape,
                "row",
                documentProperties(shape, "row", extra),
              ),
              { onConflict: "update", onUnknownProperty },
            );
            expect(updated.errors).toEqual([]);
            expect(await claimState(store, shape)).toEqual(
              heldBy(shape, "row"),
            );
          });
        }

        it("an import after a create of the value is refused for that row", async () => {
          const store = await createCkoStore(context, nextGraphId());
          await collectionOf(store, shape.kind).create(
            propsOf("row", inputOf(shape)),
            { id: "row" },
          );
          // The default shape's document omits `v` under "error", so the
          // parse supplies the literal, exactly as the create did.
          const document = interchangeDocument(
            shape,
            "second",
            inputOf(shape) === undefined ?
              { name: "second" }
            : documentProperties(shape, "second"),
          );
          const imported = await importGraph(store, document, {
            onConflict: "error",
            onUnknownProperty: "error",
          });
          expect(imported.errors.map((error) => error.id)).toEqual(["second"]);
        });

        it("getOrCreateByConstraint finds the live holder, and resurrects it once soft-deleted", async () => {
          const store = await createCkoStore(context, nextGraphId());
          const collection = collectionOf(store, shape.kind);
          await collection.create(propsOf("row", inputOf(shape)), {
            id: "row",
          });
          const found = await collection.getOrCreateByConstraint(
            `${shape.kind}_v`,
            propsOf("again", inputOf(shape)),
          );
          await collection.delete("row" as never);
          const revived = await collection.getOrCreateByConstraint(
            `${shape.kind}_v`,
            propsOf("again", inputOf(shape)),
          );
          expect({
            found: [found.action, found.node.id],
            revived: [revived.action, revived.node.id],
            ...(await claimState(store, shape)),
          }).toEqual({
            found: ["found", "row"],
            revived: ["resurrected", "row"],
            ...heldBy(shape, "row"),
          });
        });

        it("a fact retracted and reopened by provenance gives the key back and reclaims it", async () => {
          const store = await context.createHistoryStore(
            buildGraph(nextGraphId()),
          );
          const source = await store.nodes.CkoSource.create(
            { label: "source", retracted: false },
            { id: "source" },
          );
          const fact = await collectionOf(store, shape.kind).create(
            propsOf("fact", inputOf(shape)),
            { id: "fact" },
          );
          const justification = await store.nodes.CkoJustification.create(
            { label: "justification" },
            { id: "justification" },
          );
          await store.edges.ckoPremiseOf.create(source, justification, {});
          await store.edges.ckoDerives.create(
            justification,
            { kind: shape.kind, id: fact.id },
            {},
          );
          const provenance = createRetractionCapability(store, {
            source: { kind: "CkoSource" },
            justification: { kind: "CkoJustification" },
            fact: { kinds: [shape.kind] },
            premiseOf: { kind: "ckoPremiseOf" },
            derives: { kind: "ckoDerives" },
          });

          await provenance.retract(source);
          const retracted = await liveClaims(
            store.backend,
            store.graphId,
            `${shape.kind}_v`,
          );
          await provenance.unRetract(source);

          expect({
            retracted,
            ...(await claimState(store, shape)),
          }).toEqual({ retracted: [], ...heldBy(shape, "fact") });
        });

        it("a bulk create and a bulk upsert of another field claim and keep the key", async () => {
          const store = await createCkoStore(context, nextGraphId());
          const collection = collectionOf(store, shape.kind);
          await collection.bulkCreate([
            { id: "row", props: propsOf("row", inputOf(shape)) },
          ]);
          const created = await claimState(store, shape);
          await collection.bulkUpsertById([
            { id: "row", props: propsOf("renamed", inputOf(shape)) },
          ]);
          expect({
            created,
            upserted: await claimState(store, shape),
          }).toEqual({
            created: heldBy(shape, "row"),
            upserted: heldBy(shape, "row"),
          });
        });

        it("a merge of a branch's node claims the key in the target", async () => {
          const store = await createCkoStore(context, nextGraphId());
          const source = unwrap(
            await branch(store, () => context.createIsolatedBackend(), {
              id: asBranchId("claim-key-owner"),
            }),
          );
          await collectionOf(source.store as never, shape.kind).create(
            propsOf("row", inputOf(shape)),
            { id: "row" },
          );
          const merged = await merge(store, [source]);
          // The apply re-validates a branch node's stored props through the
          // create schema, which refuses a date's stored text. The same on
          // main; the key is not reached.
          expectObservation({
            lane: { driver: context.driver, kind: shape.kind },
            observed:
              isErr(merged) ?
                merged.error.name
              : await claimState(store, shape),
            correct: heldBy(shape, "row"),
            defects: [
              {
                label: "merge apply re-validates a stored date",
                on: { kind: ["CkoDate", "CkoLazyDate"] },
                today: "MergeError",
              },
            ],
          });
        });
      });
    }

    // Main keyed a `.default()` object in its literal's order and now keys it
    // in the shape's, so a claim a create on main took for such a value is a
    // claim in another form. It does not fence a create of the same value
    // until its holder's next write that moves or releases the constraint
    // gives it back by owner; an update that leaves the key where it was
    // leaves it alone.
    it("a default object's claim keyed in its literal order is released by its holder's next move of the key", async () => {
      const store = await createCkoStore(context, nextGraphId());
      const shape = requireDefined(
        SHAPES.find((candidate) => candidate.kind === "CkoDefault"),
      );
      const collection = collectionOf(store, "CkoDefault");
      await collection.create({ name: "row" }, { id: "row" });
      const literalKey = computeUniqueKey(
        { v: { a: "a", zeta: "z" } },
        ["v"],
        "binary",
      );
      // As a create on main left it: the claim keyed in the literal's order.
      const claimRow = {
        graphId: store.graphId,
        nodeKind: "CkoDefault",
        constraintName: "CkoDefault_v",
        concreteKind: "CkoDefault",
        nodeId: "row",
      };
      await store.backend.deleteUnique({ ...claimRow, key: shape.key });
      await store.backend.insertUnique({ ...claimRow, key: literalKey });

      // A rename leaves the key where it was, so the legacy claim stays.
      await collection.update("row" as never, { name: "renamed" });
      const beforeHeal = await claimState(store, shape);
      expectObservation({
        lane: { driver: context.driver },
        observed: beforeHeal,
        correct: heldBy(shape, "row"),
        defects: [
          {
            label: "default object claimed in its literal order before upgrade",
            on: {},
            today: {
              claims: [{ key: literalKey, node_id: "row" }],
              duplicate: "written",
            },
          },
        ],
      });

      // The heal: the holder's move off the value gives back every claim it
      // held under the constraint, the legacy one included, and the move back
      // claims the shape-ordered key. The duplicate the legacy claim let in
      // refuses the move back until it is removed.
      await collection.update("row" as never, { v: { a: "b", zeta: "y" } });
      expect(
        await liveClaims(store.backend, store.graphId, "CkoDefault_v"),
      ).toEqual([
        { key: shape.key, node_id: "duplicate" },
        { key: `{"zeta":"y","a":"b"}`, node_id: "row" },
      ]);
      const backAgain = () =>
        collection.update("row" as never, { v: { a: "a", zeta: "z" } });
      expect(await outcome(backAgain)).toBe("UniquenessError");
      if (beforeHeal.duplicate === "written") {
        await store.nodes.CkoDefault.hardDelete(
          "duplicate" as NodeId<typeof CkoDefault>,
        );
      }
      await backAgain();
      expect(await claimState(store, shape)).toEqual(heldBy(shape, "row"));
    });

    // When the object holds only fixed literals, the holder cannot move its
    // value off and back: the default is the only value the field holds, so
    // an update restating it moves no key and leaves the legacy claim alone.
    // The documented repair re-keys it without SQL: soft-delete the holder
    // and revive it with `upsertById` in one transaction. The delete gives
    // back every claim the holder held, by owner; the revival claims the
    // shape-ordered key as a create does, and refuses, rolling the delete
    // back with it, while a duplicate the legacy claim let in still holds it.
    it("a fixed-literal default object's legacy claim is re-keyed by a soft delete and revival of its holder in one transaction", async () => {
      const store = await createCkoStore(context, nextGraphId());
      const collection = store.nodes.CkoFixed;
      await collection.create({ name: "row" }, { id: "row" });
      const shapeKey = `{"zeta":"z","a":"a"}`;
      const literalKey = computeUniqueKey(
        { v: { a: "a", zeta: "z" } },
        ["v"],
        "binary",
      );
      const claimRow = {
        graphId: store.graphId,
        nodeKind: "CkoFixed",
        constraintName: "CkoFixed_v",
        concreteKind: "CkoFixed",
        nodeId: "row",
      };
      await store.backend.deleteUnique({ ...claimRow, key: shapeKey });
      await store.backend.insertUnique({ ...claimRow, key: literalKey });
      const rowId = "row" as NodeId<typeof CkoFixed>;
      const claims = () =>
        liveClaims(store.backend, store.graphId, "CkoFixed_v");

      await collection.update(rowId, { v: { a: "a", zeta: "z" } });
      expect(await claims()).toEqual([{ key: literalKey, node_id: "row" }]);

      const repair = () =>
        store.transaction(async (tx) => {
          await tx.nodes.CkoFixed.delete(rowId);
          await tx.nodes.CkoFixed.upsertById(rowId, { name: "row" });
        });
      const rowState = async () => {
        const row = await collection.getById(rowId);
        return { name: row?.name, claims: await claims() };
      };
      // The legacy claim lets a create of the value in beside it. The marker
      // fails this case unless the create is admitted, so what follows is the
      // repair with that duplicate present.
      expectObservation({
        lane: { driver: context.driver },
        observed: await outcome(() =>
          collection.create({ name: "duplicate" }, { id: "duplicate" }),
        ),
        correct: "UniquenessError",
        defects: [
          {
            label: "default object claimed in its literal order before upgrade",
            on: {},
            today: "written",
          },
        ],
      });
      expect(await outcome(repair)).toBe("UniquenessError");
      expect(await rowState()).toEqual({
        name: "row",
        claims: [
          { key: shapeKey, node_id: "duplicate" },
          { key: literalKey, node_id: "row" },
        ],
      });
      await collection.hardDelete("duplicate" as NodeId<typeof CkoFixed>);

      await repair();

      expect({
        ...(await rowState()),
        duplicate: await outcome(() =>
          collection.create({ name: "duplicate" }, { id: "duplicate" }),
        ),
      }).toEqual({
        name: "row",
        claims: [{ key: shapeKey, node_id: "row" }],
        duplicate: "UniquenessError",
      });
    });
  });
}
