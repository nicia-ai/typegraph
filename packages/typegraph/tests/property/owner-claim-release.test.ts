/**
 * After every step of a random write sequence, the live uniqueness claim rows
 * are EXACTLY the keys of the live constrained nodes, and
 * `verifyConstraintFences()` reports nothing — on SQLite and PGlite.
 *
 * The sequences mix create, update, soft delete, hard delete, resurrection by
 * upsert, upsert and import update over unique values of every supported
 * type: dates (`z.date()`), strings under the `binary` and `caseInsensitive`
 * collations, numbers, booleans, `null`, a nested object holding a date, and
 * an array. Values come from small pools, so writes collide and are refused;
 * a refused write must leave the claims as they were.
 *
 * The expected keys are computed from a model of the validated props each
 * live node holds, through the one key function — independently of anything
 * the store reads back. A claim the store keyed from another representation
 * of a value, or failed to release, shows up as a difference in the claim
 * set: a duplicate value admitted twice appears as two expected claims where
 * the relation (whose primary key is the claim) can hold one.
 *
 * REVERT CHECK: restoring main's `src` fails this property on the first
 * sequence that moves or deletes a node holding a date, on both lanes.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  type GraphBackend,
  type NodeId,
  UniquenessError,
} from "../../src";
import { createLocalPgliteBackend } from "../../src/backend/postgres/pglite";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { computeUniqueKey } from "../../src/constraints";
import { type Collation } from "../../src/core/types";
import { FORMAT_VERSION, importGraph } from "../../src/interchange";
import { createSqlSchema } from "../../src/query/compiler/schema";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../src/query/sql-intent";
import { compareStrings } from "../../src/utils/compare";
import { propertyRuns, propertyTestTimeout } from "./run-budget";

const Item = defineNode("OcrPropItem", {
  schema: z.object({
    at: z.date(),
    label: z.string(),
    code: z.string(),
    count: z.number(),
    flag: z.boolean(),
    maybe: z.string().nullable(),
    slot: z.object({ zeta: z.string(), at: z.date() }),
    list: z.array(z.number()),
  }),
});

type ItemProps = z.infer<typeof Item.schema>;

const CONSTRAINTS: readonly Readonly<{
  name: string;
  fields: readonly (keyof ItemProps)[];
  collation: Collation;
}>[] = [
  { name: "item_at", fields: ["at"], collation: "binary" },
  { name: "item_label", fields: ["label"], collation: "caseInsensitive" },
  { name: "item_code", fields: ["code"], collation: "binary" },
  {
    name: "item_mixed",
    fields: ["count", "flag", "maybe"],
    collation: "binary",
  },
  { name: "item_slot", fields: ["slot"], collation: "binary" },
  { name: "item_list", fields: ["list"], collation: "binary" },
];

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      OcrPropItem: {
        type: Item,
        unique: CONSTRAINTS.map((constraint) => ({
          name: constraint.name,
          fields: [...constraint.fields],
          scope: "kind" as const,
          collation: constraint.collation,
        })),
      },
    },
    edges: {},
  });
}

const DATES = [
  new Date("2024-01-01T00:00:00.000Z"),
  new Date("2024-01-01T00:00:00.001Z"),
  new Date("1999-12-31T23:59:59.999Z"),
];

const propsArb: fc.Arbitrary<ItemProps> = fc.record({
  at: fc.constantFrom(...DATES),
  label: fc.constantFrom("Alpha", "alpha", "Beta", "BETA", "gamma"),
  code: fc.constantFrom("x", "X", "y"),
  count: fc.constantFrom(0, 1, 1.5),
  flag: fc.boolean(),
  // eslint-disable-next-line unicorn/no-null -- a unique `null` value is one of the value types under test.
  maybe: fc.constantFrom(null, "m"),
  slot: fc.record({
    zeta: fc.constantFrom("n", "s"),
    at: fc.constantFrom(...DATES),
  }),
  list: fc.constantFrom([], [1], [1, 2], [2, 1]),
});

const IDS = ["n1", "n2", "n3", "n4"] as const;
const idArb = fc.constantFrom(...IDS);

type Op =
  | Readonly<{ op: "create"; id: string; props: ItemProps }>
  | Readonly<{ op: "update"; id: string; patch: Partial<ItemProps> }>
  | Readonly<{ op: "softDelete"; id: string }>
  | Readonly<{ op: "hardDelete"; id: string }>
  | Readonly<{ op: "upsert"; id: string; props: ItemProps }>
  | Readonly<{ op: "importUpdate"; id: string; props: ItemProps }>;

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({ op: fc.constant("create" as const), id: idArb, props: propsArb }),
  fc.record({
    op: fc.constant("update" as const),
    id: idArb,
    patch: propsArb.chain((props) =>
      fc
        .subarray(Object.keys(props) as (keyof ItemProps)[], { minLength: 1 })
        .map(
          (keys) =>
            Object.fromEntries(
              keys.map((key) => [key, props[key]]),
            ) as Partial<ItemProps>,
        ),
    ),
  }),
  fc.record({ op: fc.constant("softDelete" as const), id: idArb }),
  fc.record({ op: fc.constant("hardDelete" as const), id: idArb }),
  fc.record({ op: fc.constant("upsert" as const), id: idArb, props: propsArb }),
  fc.record({
    op: fc.constant("importUpdate" as const),
    id: idArb,
    props: propsArb,
  }),
);

/** A node as the model holds it: its validated props and whether it is live. */
type ModelNode = Readonly<{ live: boolean; props: ItemProps }>;

type Claim = Readonly<{
  constraint_name: string;
  key: string;
  node_id: string;
}>;

function sortedClaims(claims: readonly Claim[]): readonly Claim[] {
  return claims
    .map((claim) => ({
      constraint_name: claim.constraint_name,
      key: claim.key,
      node_id: claim.node_id,
    }))
    .toSorted(
      (left, right) =>
        compareStrings(left.constraint_name, right.constraint_name) ||
        compareStrings(left.node_id, right.node_id) ||
        compareStrings(left.key, right.key),
    );
}

function expectedClaims(
  model: ReadonlyMap<string, ModelNode>,
): readonly Claim[] {
  const claims: Claim[] = [];
  for (const [id, node] of model) {
    if (!node.live) continue;
    const validated = Item.schema.parse(node.props) as Record<string, unknown>;
    for (const constraint of CONSTRAINTS) {
      claims.push({
        constraint_name: constraint.name,
        key: computeUniqueKey(
          validated,
          constraint.fields,
          constraint.collation,
        ),
        node_id: id,
      });
    }
  }
  return sortedClaims(claims);
}

async function liveClaims(
  backend: GraphBackend,
  graphId: string,
): Promise<readonly Claim[]> {
  const schema = createSqlSchema(backend.tableNames);
  return sortedClaims(
    await backend.execute<Claim>(
      asCompiledRowsSql(sql`
        SELECT constraint_name, key, node_id
        FROM ${sql.identifier(schema.tables.uniques)}
        WHERE graph_id = ${graphId} AND deleted_at IS NULL
      `),
    ),
  );
}

/** Runs a write, reporting whether it landed; a uniqueness refusal did not. */
async function landed(write: () => Promise<unknown>): Promise<boolean> {
  try {
    await write();
    return true;
  } catch (error) {
    if (error instanceof UniquenessError) return false;
    throw error;
  }
}

type ItemStore = Awaited<
  ReturnType<typeof createStoreWithSchema<ReturnType<typeof buildGraph>>>
>[0];

async function applyOp(
  store: ItemStore,
  model: Map<string, ModelNode>,
  step: Op,
): Promise<void> {
  const nodes = store.nodes.OcrPropItem;
  const id = step.id as NodeId<typeof Item>;
  const current = model.get(step.id);
  switch (step.op) {
    case "create": {
      if (current !== undefined) return;
      if (await landed(() => nodes.create(step.props, { id: step.id }))) {
        model.set(step.id, { live: true, props: step.props });
      }
      return;
    }
    case "update": {
      if (current?.live !== true) return;
      if (await landed(() => nodes.update(id, step.patch))) {
        model.set(step.id, {
          live: true,
          props: { ...current.props, ...step.patch },
        });
      }
      return;
    }
    case "softDelete": {
      if (current?.live !== true) return;
      await nodes.delete(id);
      model.set(step.id, { live: false, props: current.props });
      return;
    }
    case "hardDelete": {
      if (current === undefined) return;
      await nodes.hardDelete(id);
      model.delete(step.id);
      return;
    }
    case "upsert": {
      // Creates an absent row, updates a live one, resurrects a tombstone.
      if (await landed(() => nodes.upsertById(step.id, step.props))) {
        model.set(step.id, { live: true, props: step.props });
      }
      return;
    }
    case "importUpdate": {
      const result = await importGraph(
        store,
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          source: { type: "external", description: "owner claim property" },
          nodes: [{ kind: "OcrPropItem", id: step.id, properties: step.props }],
          edges: [],
        },
        { onConflict: "update", onUnknownProperty: "error" },
      );
      // Import never resurrects a tombstone; a refused row is a row error.
      if (result.errors.length > 0) {
        expect(result.errors.map((error) => error.error).join("\n")).toMatch(
          /Uniqueness/u,
        );
        return;
      }
      if (current?.live === false) return;
      model.set(step.id, { live: true, props: step.props });
      return;
    }
  }
}

type Lane = Readonly<{
  name: string;
  runs: number;
  shared: boolean;
  open: () => Promise<
    Readonly<{ backend: GraphBackend; close: () => Promise<void> }>
  >;
}>;

const LANES: readonly Lane[] = [
  {
    name: "SQLite",
    runs: propertyRuns({ ci: 40, local: 60 }),
    shared: false,
    open: () => {
      const { backend } = createLocalSqliteBackend();
      return Promise.resolve({ backend, close: () => backend.close() });
    },
  },
  {
    name: "PGlite",
    runs: propertyRuns({ ci: 15, local: 25 }),
    shared: true,
    open: async () => {
      const local = await createLocalPgliteBackend({ vector: false });
      return { backend: local.backend, close: () => local.backend.close() };
    },
  },
];

let graphSerial = 0;

describe.each(LANES)("owner claim release ($name)", (lane) => {
  let shared: Awaited<ReturnType<Lane["open"]>> | undefined;

  beforeAll(async () => {
    if (lane.shared) shared = await lane.open();
  });

  afterAll(async () => {
    await shared?.close();
  });

  it(
    "the live claim rows are exactly the keys of the live constrained nodes after every step",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(opArb, { minLength: 1, maxLength: 14 }),
          async (ops) => {
            graphSerial += 1;
            const graphId = `owner_claim_property_${graphSerial}`;
            const opened = shared ?? (await lane.open());
            try {
              const [store] = await createStoreWithSchema(
                buildGraph(graphId),
                opened.backend,
              );
              const model = new Map<string, ModelNode>();
              for (const step of ops) {
                await applyOp(store, model, step);
                expect(await liveClaims(opened.backend, graphId)).toEqual(
                  expectedClaims(model),
                );
                expect(await store.verifyConstraintFences()).toEqual([]);
              }
            } finally {
              if (shared === undefined) await opened.close();
            }
          },
        ),
        { numRuns: lane.runs },
      );
    },
    propertyTestTimeout(120_000),
  );
});
