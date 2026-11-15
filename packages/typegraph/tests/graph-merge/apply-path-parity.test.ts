/**
 * Every apply entry point lands what `merge()` lands for the same staged
 * work: `applyMergePlan` (TypeGraph owns the transaction) and
 * `applyMergePlanInTransaction` (the caller does) replay a plan artifact
 * through the same write ordering the direct merge uses.
 *
 * Fixture: the target holds people `a` and `b` asserted to be one person. The
 * branch retracts that assertion and then ends `b`'s validity window — the
 * only order the store accepts, because a current assertion's endpoint cannot
 * have its window ended. An apply that wrote the node row before the
 * retraction would be refused with the endpoint-validity conflict.
 */
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../../src";
import { createLocalSqliteBackend } from "../../src/backend/sqlite/local";
import { branch } from "../../src/graph-merge/branch";
import {
  applyMergePlan,
  applyMergePlanInTransaction,
  merge,
  planMerge,
} from "../../src/graph-merge/merge";
import { unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });

const graph = defineGraph({
  id: "apply_path_parity",
  nodes: { Person: { type: Person } },
  edges: {},
  identity: { sameIdAcrossKinds: "ignore" },
});

const WINDOW_END = "2030-01-01T00:00:00.000Z";
const PERSON_A = { kind: "Person", id: "a" } as const;
const PERSON_B = { kind: "Person", id: "b" } as const;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

function openBackend() {
  const { backend } = createLocalSqliteBackend();
  cleanups.push(() => backend.close());
  return backend;
}

async function branchRetractingThenEndingAnEndpoint() {
  const [target] = await createStoreWithSchema(graph, openBackend(), {
    history: true,
  });
  await target.nodes.Person.create({ name: "a" }, { id: PERSON_A.id });
  await target.nodes.Person.create({ name: "b" }, { id: PERSON_B.id });
  const { assertion } = await target.identity.assertSame(PERSON_A, PERSON_B);
  const source = unwrap(
    await branch(target, () => Promise.resolve(openBackend()), {
      id: asBranchId("branch-a"),
    }),
  );
  await source.store.identity.retractAssertion(assertion.id);
  await source.store.nodes.Person.update(
    asNodeId(PERSON_B.id),
    {},
    { validTo: WINDOW_END },
  );
  return { target, source };
}

async function landedState(target: Store<typeof graph>) {
  const ended = await target.nodes.Person.getById(asNodeId(PERSON_B.id));
  const state = {
    areSame: await target.identity.areSame(PERSON_A, PERSON_B),
    validTo: ended?.meta.validTo,
    violations: await target.verifyConstraintFences(),
  };
  console.info("landed state", JSON.stringify(state));
  return state;
}

const LANDED = { areSame: false, validTo: WINDOW_END, violations: [] };
const MERGED = { nodes: 1, edges: 0, identity: { asserted: 0, retracted: 1 } };

describe("a retraction paired with an endpoint window end", () => {
  it("lands through merge()", async () => {
    const { target, source } = await branchRetractingThenEndingAnEndpoint();
    const report = unwrap(await merge(target, [source]));

    expect(report.merged).toEqual(MERGED);
    expect(await landedState(target)).toEqual(LANDED);
  });

  it("lands through applyMergePlan with the same counts", async () => {
    const { target, source } = await branchRetractingThenEndingAnEndpoint();
    const plan = unwrap(await planMerge(target, [source]));
    const report = unwrap(await applyMergePlan(target, plan));

    expect(report.merged).toEqual(MERGED);
    expect(await landedState(target)).toEqual(LANDED);
  });

  it("lands through applyMergePlanInTransaction with the same counts", async () => {
    const { target, source } = await branchRetractingThenEndingAnEndpoint();
    const plan = unwrap(await planMerge(target, [source]));
    const report = await target.transaction((tx) =>
      applyMergePlanInTransaction(target, tx, plan),
    );

    expect(report.merged).toEqual(MERGED);
    expect(await landedState(target)).toEqual(LANDED);
  });
});

/**
 * A reopening — `update(id, {}, { clearValidTo: true })` — is a window mutation
 * a plan artifact must carry as faithfully as an ending: a wire write that
 * lost the clear would leave the row ended while the report claimed otherwise.
 */
const Follows = defineEdge("follows", { schema: z.object({}) });

const reopenGraph = defineGraph({
  id: "apply_path_parity_reopen",
  nodes: { Person: { type: Person } },
  edges: {
    follows: { type: Follows, from: [Person], to: [Person] },
  },
});

const FOLLOWS_ID = asEdgeId<typeof Follows>("follows-ab");

async function branchReopeningEndedRows() {
  const [target] = await createStoreWithSchema(reopenGraph, openBackend(), {
    history: true,
  });
  await target.nodes.Person.create(
    { name: "a" },
    { id: PERSON_A.id, validTo: WINDOW_END },
  );
  await target.nodes.Person.create({ name: "b" }, { id: PERSON_B.id });
  await target.edges.follows.create(
    { kind: "Person", id: PERSON_B.id },
    { kind: "Person", id: PERSON_A.id },
    {},
    { id: FOLLOWS_ID, validTo: WINDOW_END },
  );
  const source = unwrap(
    await branch(target, () => Promise.resolve(openBackend()), {
      id: asBranchId("branch-a"),
    }),
  );
  await source.store.nodes.Person.update(
    asNodeId(PERSON_A.id),
    {},
    { clearValidTo: true },
  );
  await source.store.edges.follows.update(
    FOLLOWS_ID,
    {},
    { clearValidTo: true },
  );
  return { target, source };
}

async function reopenedState(target: Store<typeof reopenGraph>) {
  const person = await target.nodes.Person.getById(asNodeId(PERSON_A.id));
  const edge = await target.edges.follows.getById(FOLLOWS_ID);
  const state = {
    personValidTo: person?.meta.validTo,
    edgeValidTo: edge?.meta.validTo,
    violations: await target.verifyConstraintFences(),
  };
  console.info("reopened state", JSON.stringify(state));
  return state;
}

const REOPENED = {
  personValidTo: undefined,
  edgeValidTo: undefined,
  violations: [],
};

describe("a branch that reopens an ended node and edge window", () => {
  it("lands through merge()", async () => {
    const { target, source } = await branchReopeningEndedRows();
    unwrap(await merge(target, [source]));

    expect(await reopenedState(target)).toEqual(REOPENED);
  });

  it("lands through applyMergePlan", async () => {
    const { target, source } = await branchReopeningEndedRows();
    const plan = unwrap(await planMerge(target, [source]));
    unwrap(await applyMergePlan(target, plan));

    expect(await reopenedState(target)).toEqual(REOPENED);
  });

  it("lands through applyMergePlan after a JSON round trip of the plan", async () => {
    const { target, source } = await branchReopeningEndedRows();
    const plan = unwrap(await planMerge(target, [source]));
    const replayed = JSON.parse(JSON.stringify(plan)) as typeof plan;
    unwrap(await applyMergePlan(target, replayed));

    expect(await reopenedState(target)).toEqual(REOPENED);
  });

  it("lands through applyMergePlanInTransaction", async () => {
    const { target, source } = await branchReopeningEndedRows();
    const plan = unwrap(await planMerge(target, [source]));
    await target.transaction((tx) =>
      applyMergePlanInTransaction(target, tx, plan),
    );

    expect(await reopenedState(target)).toEqual(REOPENED);
  });

  it("reports the reopenings the artifact carries", async () => {
    const { target, source } = await branchReopeningEndedRows();
    const plan = unwrap(await planMerge(target, [source]));

    expect(plan.writes.nodeUpserts).toContainEqual(
      expect.objectContaining({ id: PERSON_A.id, clearValidTo: true }),
    );
    expect(plan.writes.edgeUpserts).toContainEqual(
      expect.objectContaining({ id: FOLLOWS_ID, clearValidTo: true }),
    );
    expect(plan.review.validityEnds).toHaveLength(2);
  });
});
