import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  DisjointError,
  ENTITY_ALREADY_EXISTS_CODE,
  defineGraph,
  defineNode,
  disjointWith,
  searchable,
  subClassOf,
  UniquenessError,
  ValidationError,
} from "../src";
import { supportsNodeInsertPlan } from "../src/backend/capabilities/node-insert-projections";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import type { GraphBackend, TransactionBackend } from "../src/backend/types";
import { createStore, createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";
import {
  createRecordedPostgresStore,
  type LoggedStatement,
} from "./statement-recorder";

const SAME_KIND_UNIQUE = {
  name: "same_kind_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

const SHARED_UNIQUE = {
  name: "shared_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const UniqueNode = defineNode("UniqueNode", {
  schema: z.object({ email: z.string() }),
});
const SharedRoot = defineNode("SharedRoot", {
  schema: z.object({ email: z.string() }),
});
const SharedLeaf = defineNode("SharedLeaf", {
  schema: z.object({ email: z.string() }),
});
const Person = defineNode("ClaimPerson", {
  schema: z.object({ name: z.string() }),
});
const Company = defineNode("ClaimCompany", {
  schema: z.object({ name: z.string() }),
});
const MixedLeaf = defineNode("MixedLeaf", {
  schema: z.object({ email: z.string(), handle: z.string() }),
});
const SearchableUnique = defineNode("SearchableUnique", {
  schema: z.object({
    email: z.string(),
    title: searchable({ language: "english" }),
  }),
});
const graph = defineGraph({
  id: "node_claim_write_fusion",
  nodes: {
    UniqueNode: { type: UniqueNode, unique: [SAME_KIND_UNIQUE] },
    SharedRoot: { type: SharedRoot, unique: [SHARED_UNIQUE] },
    SharedLeaf: { type: SharedLeaf, unique: [SHARED_UNIQUE] },
    ClaimPerson: { type: Person },
    ClaimCompany: { type: Company },
    MixedLeaf: {
      type: MixedLeaf,
      unique: [SHARED_UNIQUE, SAME_KIND_UNIQUE],
    },
    SearchableUnique: {
      type: SearchableUnique,
      unique: [SAME_KIND_UNIQUE],
    },
  },
  edges: {},
  ontology: [subClassOf(SharedLeaf, SharedRoot), disjointWith(Person, Company)],
});

function hasNodeInsert(statement: LoggedStatement): boolean {
  return /insert\s+into\s+"typegraph_nodes"/iu.test(statement.query);
}

function hasUniqueClaim(statement: LoggedStatement): boolean {
  return /insert\s+into\s+"typegraph_node_uniques"/iu.test(statement.query);
}

function hasUniqueProbe(statement: LoggedStatement): boolean {
  return /select\s+\*\s+from\s+"typegraph_node_uniques"/iu.test(
    statement.query,
  );
}

function hasNodeProbe(statement: LoggedStatement): boolean {
  return /select\s+\*\s+from\s+"typegraph_nodes"/iu.test(statement.query);
}

function uniqueProbes(
  statements: readonly LoggedStatement[],
): LoggedStatement[] {
  return statements.filter((statement) => hasUniqueProbe(statement));
}

function nodeProbes(statements: readonly LoggedStatement[]): LoggedStatement[] {
  return statements.filter((statement) => hasNodeProbe(statement));
}

function nodeWrite(statements: readonly LoggedStatement[]): LoggedStatement {
  return requireDefined(
    statements.find((statement) => hasNodeInsert(statement)),
    "node write statement",
  );
}

function claimNames(
  statement: LoggedStatement,
  names: readonly string[],
): string[] {
  return statement.params.filter(
    (parameter): parameter is string =>
      typeof parameter === "string" && names.includes(parameter),
  );
}

function expectFusedClaimAndNode(statement: LoggedStatement): void {
  expect(hasNodeInsert(statement)).toBe(true);
  expect(hasUniqueClaim(statement)).toBe(true);
  expect(statement.query).toMatch(/node_inserted/iu);
}

describe("node claim write fusion", () => {
  it("refuses a claim plan on the root backend without a rollback boundary", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const claimPlan = {
      claims: [
        {
          axis: "UniqueNode",
          constraintName: SAME_KIND_UNIQUE.name,
          key: "root@example.com",
          placement: "post-insert" as const,
          verdict: {
            kind: "uniqueness" as const,
            probeAxes: ["UniqueNode"],
            fields: ["email"],
          },
        },
      ],
      projections: [],
    };

    expect(supportsNodeInsertPlan(fixture.backend, claimPlan)).toBe(false);

    await expect(
      requireDefined(
        fixture.backend.insertNodeWithProjections,
        "planned node insert",
      )(
        {
          graphId: graph.id,
          kind: "UniqueNode",
          id: "root-claim-plan",
          props: { email: "root@example.com" },
        },
        {
          mode: { kind: "ordinary" },
          ...claimPlan,
        },
      ),
    ).rejects.toThrow("requires a transaction-scoped backend");
  });

  it("refuses claims on schema-fenced plans before executing them", async () => {
    const fixture = await createRecordedPostgresStore(graph);

    await expect(
      fixture.backend.transaction(async (tx) =>
        requireDefined(tx.insertNodeWithProjections)(
          {
            graphId: graph.id,
            kind: "UniqueNode",
            id: "schema-claim-plan",
            props: { email: "schema@example.com" },
          },
          {
            mode: {
              kind: "schema-fenced",
              schemaFence: { graphId: graph.id, expectedVersion: 1 },
            },
            claims: [
              {
                axis: "UniqueNode",
                constraintName: SAME_KIND_UNIQUE.name,
                key: "schema@example.com",
                placement: "post-insert",
                verdict: {
                  kind: "uniqueness",
                  probeAxes: ["UniqueNode"],
                  fields: ["email"],
                },
              },
            ],
            projections: [],
          },
        ),
      ),
    ).rejects.toThrow("cannot carry uniqueness claims");
    expect(
      await fixture.backend.checkUnique({
        graphId: graph.id,
        nodeKind: "UniqueNode",
        constraintName: SAME_KIND_UNIQUE.name,
        key: "schema@example.com",
      }),
    ).toBeUndefined();
  });

  it("fuses a generated same-kind unique claim with the node insert", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const store = fixture.store;

    fixture.reset();
    await store.nodes.UniqueNode.create({ email: "same@example.com" });

    const statement = nodeWrite(fixture.statements);
    expectFusedClaimAndNode(statement);
    expect(claimNames(statement, [SAME_KIND_UNIQUE.name])).toEqual([
      SAME_KIND_UNIQUE.name,
    ]);
    expect(statement.query.indexOf('"node_inserted"')).toBeLessThan(
      statement.query.indexOf('"node_post_claimed"'),
    );
    // The atomic claim verdict is authoritative for a fresh generated row:
    // the old checkUnique read is folded into the same statement as the claim,
    // so this write is exactly one database round trip.
    expect(uniqueProbes(fixture.statements)).toHaveLength(0);
    expect(fixture.statements).toHaveLength(1);
  });

  it("fuses a shared-scope unique claim before the generated node insert", async () => {
    const fixture = await createRecordedPostgresStore(graph);

    fixture.reset();
    await fixture.store.nodes.SharedLeaf.create({
      email: "shared@example.com",
    });

    const statement = nodeWrite(fixture.statements);
    expectFusedClaimAndNode(statement);
    expect(statement.query).toMatch(/node_pre_claimed/iu);
    expect(statement.query.indexOf('"node_pre_claimed"')).toBeLessThan(
      statement.query.indexOf('"node_inserted"'),
    );
    expect(claimNames(statement, [SHARED_UNIQUE.name])).toEqual([
      SHARED_UNIQUE.name,
    ]);
    // The shared-scope probe used to read both the axis and the legacy kind.
    // The lock remains a separate statement; both reads must disappear while
    // the claim/node CTE remains the sole write statement.
    expect(uniqueProbes(fixture.statements)).toHaveLength(0);
    expect(fixture.statements).toHaveLength(2);
  });

  it("fuses a disjointness claim before a generated node insert", async () => {
    const fixture = await createRecordedPostgresStore(graph);

    fixture.reset();
    await fixture.store.nodes.ClaimPerson.create({ name: "person" });

    const statement = nodeWrite(fixture.statements);
    expectFusedClaimAndNode(statement);
    expect(statement.query).toMatch(/node_pre_claimed/iu);
    expect(statement.query).not.toMatch(/node_post_claimed/iu);
    // Generated ids cannot collide with an existing disjoint-kind row, so the
    // successful path has no node probe to defer. This assertion protects the
    // exact one-lock/one-write shape instead of merely checking the CTE text.
    expect(nodeProbes(fixture.statements)).toHaveLength(0);
    expect(fixture.statements).toHaveLength(2);
  });

  it("defers a caller-id disjoint probe but retains same-kind existence classification", async () => {
    const fixture = await createRecordedPostgresStore(graph);

    fixture.reset();
    await fixture.store.nodes.ClaimPerson.create(
      { name: "person" },
      { id: "caller-disjoint-id" },
    );

    const probes = nodeProbes(fixture.statements);
    expect(probes).toHaveLength(1);
    expect(probes[0]?.params).toContain("ClaimPerson");
    expect(probes[0]?.params).not.toContain("ClaimCompany");
    expect(uniqueProbes(fixture.statements)).toHaveLength(0);
    // lock + same-kind existence read + the authoritative claim/node CTE.
    expect(fixture.statements).toHaveLength(3);
  });

  it("keeps multiple mixed claims in their canonical pre/post phases", async () => {
    const fixture = await createRecordedPostgresStore(graph);

    fixture.reset();
    await fixture.store.nodes.MixedLeaf.create({
      email: "mixed@example.com",
      handle: "mixed-handle",
    });

    const statement = nodeWrite(fixture.statements);
    expectFusedClaimAndNode(statement);
    expect(statement.query.indexOf('"node_pre_claimed"')).toBeLessThan(
      statement.query.indexOf('"node_inserted"'),
    );
    expect(statement.query.indexOf('"node_inserted"')).toBeLessThan(
      statement.query.indexOf('"node_post_claimed"'),
    );
    expect(
      claimNames(statement, [SHARED_UNIQUE.name, SAME_KIND_UNIQUE.name]),
    ).toEqual([SAME_KIND_UNIQUE.name, SHARED_UNIQUE.name]);
  });

  it("falls back to separate claim and node statements when the member is projected away", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const projected: GraphBackend = deriveBackend(fixture.backend, {
      async transaction<T>(
        fn: (tx: TransactionBackend) => Promise<T>,
        options?: Parameters<NonNullable<GraphBackend["transaction"]>>[1],
      ): Promise<T> {
        return fixture.backend.transaction(
          (tx) => fn(projectBackendWithout(tx, ["insertNodeWithProjections"])),
          options,
        );
      },
    });
    const store = createStore(graph, projected);

    fixture.reset();
    await store.nodes.UniqueNode.create({ email: "fallback@example.com" });

    const entityStatements = fixture.statements.filter(
      (statement) => hasNodeInsert(statement) || hasUniqueClaim(statement),
    );
    expect(entityStatements.some((statement) => hasNodeInsert(statement))).toBe(
      true,
    );
    expect(
      entityStatements.some(
        (statement) => hasNodeInsert(statement) && hasUniqueClaim(statement),
      ),
    ).toBe(false);
    // A projected-away executor is not authoritative. The fallback must retain
    // its preflight and emit the claim and node as separate statements.
    expect(uniqueProbes(fixture.statements)).toHaveLength(1);
    expect(fixture.statements).toHaveLength(3);
  });

  it("falls back when atomic claim capability is explicitly refused", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const capabilityDisabled: GraphBackend = deriveBackend(fixture.backend, {
      async transaction<T>(
        fn: (tx: TransactionBackend) => Promise<T>,
        options?: Parameters<NonNullable<GraphBackend["transaction"]>>[1],
      ): Promise<T> {
        return fixture.backend.transaction(
          (tx) =>
            fn(
              deriveBackend(tx, {
                capabilities: {
                  ...tx.capabilities,
                  atomicNodeInsertClaims: false,
                },
              }),
            ),
          options,
        );
      },
    });
    const store = createStore(graph, capabilityDisabled);

    fixture.reset();
    await store.nodes.UniqueNode.create({ email: "capability-fallback" });

    expect(uniqueProbes(fixture.statements)).toHaveLength(1);
    expect(
      fixture.statements.filter(
        (statement) => hasNodeInsert(statement) && hasUniqueClaim(statement),
      ),
    ).toHaveLength(0);
    expect(fixture.statements).toHaveLength(3);
  });

  it("fuses claims and fulltext projection side effects in one statement", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const [store] = await createStoreWithSchema(graph, fixture.backend);

    fixture.reset();
    await store.nodes.SearchableUnique.create({
      email: "search@example.com",
      title: "one planned write",
    });

    const statement = nodeWrite(fixture.statements);
    expectFusedClaimAndNode(statement);
    expect(statement.query).toMatch(/typegraph_node_fulltext/iu);
    expect(statement.query).toMatch(/node_post_claimed/iu);
  }, 5000);

  it("rolls back a post-insert claim conflict without leaking the node", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const holder = await fixture.store.nodes.UniqueNode.create(
      { email: "post-conflict@example.com" },
      { id: "post-holder" },
    );

    await expect(
      fixture.backend.transaction(async (tx) =>
        requireDefined(tx.insertNodeWithProjections)(
          {
            graphId: graph.id,
            kind: "UniqueNode",
            id: "post-loser",
            props: { email: "post-conflict@example.com" },
          },
          {
            mode: { kind: "ordinary" },
            claims: [
              {
                axis: "UniqueNode",
                constraintName: SAME_KIND_UNIQUE.name,
                key: "post-conflict@example.com",
                placement: "post-insert",
                verdict: {
                  kind: "uniqueness",
                  probeAxes: ["UniqueNode"],
                  fields: ["email"],
                },
              },
            ],
            projections: [],
          },
        ),
      ),
    ).rejects.toBeInstanceOf(UniquenessError);

    expect(
      await fixture.store.nodes.UniqueNode.getById("post-loser" as never),
    ).toBeUndefined();
    expect(
      await fixture.backend.checkUnique({
        graphId: graph.id,
        nodeKind: "UniqueNode",
        constraintName: SAME_KIND_UNIQUE.name,
        key: "post-conflict@example.com",
      }),
    ).toMatchObject({ node_id: holder.id, concrete_kind: "UniqueNode" });
  });

  it("rolls back a pre-insert claim conflict without leaking a claim", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const holder = await fixture.store.nodes.SharedRoot.create(
      { email: "pre-conflict@example.com" },
      { id: "pre-holder" },
    );

    await expect(
      fixture.backend.transaction(async (tx) =>
        requireDefined(tx.insertNodeWithProjections)(
          {
            graphId: graph.id,
            kind: "SharedLeaf",
            id: "pre-loser",
            props: { email: "pre-conflict@example.com" },
          },
          {
            mode: { kind: "ordinary" },
            claims: [
              {
                axis: "SharedLeaf",
                constraintName: SHARED_UNIQUE.name,
                key: "pre-conflict@example.com",
                placement: "pre-insert",
                verdict: {
                  kind: "uniqueness",
                  probeAxes: ["SharedLeaf", "SharedRoot"],
                  fields: ["email"],
                },
              },
            ],
            projections: [],
          },
        ),
      ),
    ).rejects.toBeInstanceOf(UniquenessError);

    expect(
      await fixture.store.nodes.SharedLeaf.getById("pre-loser" as never),
    ).toBeUndefined();
    expect(
      await fixture.backend.checkUnique({
        graphId: graph.id,
        nodeKind: "SharedLeaf",
        constraintName: SHARED_UNIQUE.name,
        key: "pre-conflict@example.com",
      }),
    ).toMatchObject({ node_id: holder.id, concrete_kind: "SharedRoot" });
  });

  it("maps an atomic disjoint claim conflict to DisjointError and rolls back the node", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    await fixture.store.nodes.ClaimCompany.create(
      { name: "holder" },
      { id: "disjoint-conflict" },
    );

    await expect(
      fixture.store.nodes.ClaimPerson.create(
        { name: "loser" },
        { id: "disjoint-conflict" },
      ),
    ).rejects.toBeInstanceOf(DisjointError);

    expect(
      await fixture.store.nodes.ClaimPerson.getById(
        "disjoint-conflict" as never,
      ),
    ).toBeUndefined();
  });

  it("keeps caller-id duplicate errors stable when uniqueness probes are deferred", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const holder = await fixture.store.nodes.UniqueNode.create(
      { email: "caller-id-duplicate" },
      { id: "caller-id-duplicate" },
    );

    fixture.reset();
    const error = await fixture.store.nodes.UniqueNode.create(
      { email: "different-email" },
      { id: holder.id },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ENTITY_ALREADY_EXISTS_CODE }),
      ]),
    );
    expect((error as ValidationError).details.id).toBe(holder.id);
    // The same-kind existence read is still the caller-ID diagnostic; no
    // claim/node write should have been attempted after it refused.
    expect(
      fixture.statements.some((statement) => hasNodeInsert(statement)),
    ).toBe(false);
  });

  it("keeps tombstone resurrection on the probe-bearing path", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const original = await fixture.store.nodes.UniqueNode.create(
      { email: "before-tombstone" },
      { id: "tombstone-id" },
    );
    await fixture.store.nodes.UniqueNode.delete(original.id);

    fixture.reset();
    const revived = await fixture.store.nodes.UniqueNode.create(
      { email: "after-tombstone" },
      { id: original.id },
    );

    expect(revived.email).toBe("after-tombstone");
    // A tombstone is an UPDATE/resurrection, not a fresh atomic insert. Its
    // claim transition must still read the live ownership verdict before it
    // rewrites the node and reservation.
    expect(uniqueProbes(fixture.statements).length).toBeGreaterThan(0);
  });

  it("rejects a legacy-axis claim even when the modern fused plan is available", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    await fixture.backend.insertNode({
      graphId: graph.id,
      kind: "SharedRoot",
      id: "legacy-holder",
      props: { email: "legacy-axis@example.com" },
    });
    await fixture.backend.insertUnique({
      graphId: graph.id,
      nodeKind: "SharedRoot",
      constraintName: SHARED_UNIQUE.name,
      key: "legacy-axis@example.com",
      nodeId: "legacy-holder",
      concreteKind: "SharedRoot",
    });

    fixture.reset();
    const error = await fixture.store.nodes.SharedLeaf.create({
      email: "legacy-axis@example.com",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(UniquenessError);
    expect((error as UniquenessError).details.existingId).toBe("legacy-holder");
    expect(
      (await fixture.store.nodes.SharedLeaf.find()).filter(
        (node) => node.email === "legacy-axis@example.com",
      ),
    ).toHaveLength(0);
  });
});
