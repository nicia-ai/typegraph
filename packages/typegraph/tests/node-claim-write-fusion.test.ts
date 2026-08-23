import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CompilerInvariantError,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  ENTITY_ALREADY_EXISTS_CODE,
  searchable,
  subClassOf,
  UniquenessError,
  ValidationError,
} from "../src";
import { supportsNodeCreatePlan } from "../src/backend/capabilities/node-insert-projections";
import {
  deriveBackend,
  projectBackendWithout,
} from "../src/backend/derive-backend";
import type {
  GraphBackend,
  ManagedCreatePlan,
  TransactionBackend,
} from "../src/backend/types";
import { createStore, createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";
import {
  createRecordedPostgresStore,
  type LoggedStatement,
} from "./statement-recorder";
import { createTestBackend, disableTransactions } from "./test-utils";

const SAME_KIND_UNIQUE = {
  name: "same_kind_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

const SECOND_SAME_KIND_UNIQUE = {
  name: "same_kind_handle",
  fields: ["handle"],
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
const DoubleUnique = defineNode("DoubleUnique", {
  schema: z.object({ email: z.string(), handle: z.string() }),
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
    DoubleUnique: {
      type: DoubleUnique,
      unique: [SAME_KIND_UNIQUE, SECOND_SAME_KIND_UNIQUE],
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

    expect(supportsNodeCreatePlan(fixture.backend, claimPlan)).toBe(false);

    await expect(
      requireDefined(
        fixture.backend.executeManagedCreate,
        "planned node insert",
      )({
        entity: "node",
        params: {
          graphId: graph.id,
          kind: "UniqueNode",
          id: "root-claim-plan",
          props: { email: "root@example.com" },
        },
        idGenerated: false,
        mode: { kind: "ordinary" },
        ...claimPlan,
      }),
    ).resolves.toEqual({
      outcome: "unsupported",
      entity: "node",
      dimensions: ["claims"],
    });
  });

  it("refuses claims on schema-fenced plans before executing them", async () => {
    const fixture = await createRecordedPostgresStore(graph);

    await expect(
      fixture.backend.transaction(async (tx) =>
        requireDefined(tx.executeManagedCreate)({
          entity: "node",
          params: {
            graphId: graph.id,
            kind: "UniqueNode",
            id: "schema-claim-plan",
            props: { email: "schema@example.com" },
          },
          idGenerated: false,
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
        }),
      ),
    ).resolves.toEqual({
      outcome: "unsupported",
      entity: "node",
      dimensions: ["schemaFence", "claims"],
    });
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

  it("uses one managed statement for same-kind claims without transactions", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const nonTransactional = disableTransactions(fixture.backend);
    const plans: ManagedCreatePlan[] = [];
    const observed = deriveBackend(nonTransactional, {
      executeManagedCreate(plan) {
        plans.push(plan);
        return requireDefined(nonTransactional.executeManagedCreate)(plan);
      },
    });
    const store = createStore(graph, observed);

    fixture.reset();
    await store.nodes.UniqueNode.create({
      email: "nontransactional-same-kind",
    });

    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({
      entity: "node",
      claims: [
        expect.objectContaining({
          axis: "UniqueNode",
          constraintName: SAME_KIND_UNIQUE.name,
        }),
      ],
    });
    plans.splice(0);
    fixture.reset();
    await expect(
      store.nodes.SharedLeaf.create({ email: "nontransactional-shared-scope" }),
    ).rejects.toMatchObject({
      details: { code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED" },
    });
    expect(plans).toHaveLength(0);

    plans.splice(0);
    fixture.reset();
    await expect(
      store.nodes.ClaimPerson.create({ name: "nontransactional-disjoint" }),
    ).rejects.toMatchObject({
      details: { code: "CONSTRAINT_WRITE_FENCE_UNSUPPORTED" },
    });
    expect(plans).toHaveLength(0);

    plans.splice(0);
    fixture.reset();
    await store.nodes.DoubleUnique.create({
      email: "nontransactional-double",
      handle: "nontransactional-double",
    });
    // Multiple claims keep the complete write on the compensating portable
    // path; no root managed plan may observe or retain a partial claim set.
    expect(plans).toHaveLength(0);
  });

  it("releases an earlier claim when a later non-transactional claim conflicts", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const store = createStore(graph, disableTransactions(fixture.backend));

    await store.nodes.DoubleUnique.create({
      email: "holder@example.com",
      handle: "occupied-handle",
    });
    await expect(
      store.nodes.DoubleUnique.create({
        email: "must-be-released@example.com",
        handle: "occupied-handle",
      }),
    ).rejects.toBeInstanceOf(UniquenessError);

    await expect(
      store.nodes.DoubleUnique.create({
        email: "must-be-released@example.com",
        handle: "available-handle",
      }),
    ).resolves.toMatchObject({
      email: "must-be-released@example.com",
      handle: "available-handle",
    });
  });

  it("falls back when the root backend cannot lower claim SQL", async () => {
    const backend = disableTransactions(createTestBackend());
    const store = createStore(graph, backend);

    await store.nodes.UniqueNode.create({ email: "unsupported-sqlite-claim" });
    await expect(
      store.nodes.UniqueNode.create({ email: "unsupported-sqlite-claim" }),
    ).rejects.toBeInstanceOf(UniquenessError);
    expect(await store.nodes.UniqueNode.find()).toHaveLength(1);
  });

  it("reports only the unsupported node-plan dimensions the plan carries", async () => {
    const backend = disableTransactions(createTestBackend());

    await expect(
      requireDefined(backend.executeManagedCreate)({
        entity: "node",
        params: {
          graphId: graph.id,
          kind: "UniqueNode",
          id: "claims-only-unsupported",
          props: { email: "claims-only@example.com" },
        },
        idGenerated: true,
        mode: { kind: "ordinary" },
        claims: [
          {
            axis: "UniqueNode",
            constraintName: SAME_KIND_UNIQUE.name,
            key: "claims-only@example.com",
            placement: "post-insert",
            verdict: {
              kind: "uniqueness",
              probeAxes: ["UniqueNode"],
              fields: ["email"],
            },
          },
        ],
        projections: [],
      }),
    ).resolves.toEqual({
      outcome: "unsupported",
      entity: "node",
      dimensions: ["claims"],
    });
  });

  it("retains unsupported dimensions in the node consumer invariant", async () => {
    const fixture = await createRecordedPostgresStore(graph);
    const nonTransactional = disableTransactions(fixture.backend);
    const backend = deriveBackend(nonTransactional, {
      executeManagedCreate: () =>
        Promise.resolve({
          outcome: "unsupported" as const,
          entity: "node" as const,
          dimensions: ["claims"] as const,
        }),
    });
    const store = createStore(graph, backend);

    await expect(
      store.nodes.UniqueNode.create({ email: "unsupported-consumer" }),
    ).rejects.toMatchObject({
      name: CompilerInvariantError.name,
      details: { dimensions: ["claims"] },
    });
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
    // Once for the authoritative legacy-axis read and once for the canonical
    // claim upsert; both remain inside this one statement.
    expect(claimNames(statement, [SHARED_UNIQUE.name])).toEqual([
      SHARED_UNIQUE.name,
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
          (tx) => fn(projectBackendWithout(tx, ["executeManagedCreate"])),
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
        requireDefined(tx.executeManagedCreate)({
          entity: "node",
          params: {
            graphId: graph.id,
            kind: "UniqueNode",
            id: "post-loser",
            props: { email: "post-conflict@example.com" },
          },
          idGenerated: false,
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
        }),
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
        requireDefined(tx.executeManagedCreate)({
          entity: "node",
          params: {
            graphId: graph.id,
            kind: "SharedLeaf",
            id: "pre-loser",
            props: { email: "pre-conflict@example.com" },
          },
          idGenerated: false,
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
        }),
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
    ).catch((error_: unknown) => error_);

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
    }).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(UniquenessError);
    expect((error as UniquenessError).details.existingId).toBe("legacy-holder");
    expect((error as UniquenessError).details.fields).toEqual(["email"]);
    const remaining = await fixture.store.nodes.SharedLeaf.find();
    expect(
      remaining.filter((node) => node.email === "legacy-axis@example.com"),
    ).toHaveLength(0);
  });
});
