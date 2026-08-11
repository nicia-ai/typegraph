/**
 * `store.verifyConstraintFences()` reports the violations that predate the
 * fence — on every backend.
 *
 * A claim relation refuses the SECOND live claimant of an axis, so by the time
 * it is in place a database that already carried two of them keeps carrying
 * them: the claim relation's own primary key admits one row per axis, and a
 * pre-upgrade edge holds no claim at all. Scanning the claim tables would
 * therefore report zero violations on precisely the data this diagnostic
 * exists to surface, which is why each family is read from the relation its
 * constraint is DECLARED over.
 *
 * Every case here seeds its violation through the backend directly — the only
 * way to produce one, because the store's own writes are fenced — and then
 * asserts the report names the claim row a writer would contend for.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  disjointWith,
  subClassOf,
} from "../../../src";
import { computeUniqueKey } from "../../../src/constraints";
import { buildKindRegistry } from "../../../src/registry";
import {
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
  uniquenessClaimAxis,
} from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import { encodeTupleKey } from "../../../src/utils/tuple-key";
import { type IntegrationTestContext } from "./test-context";

const STAFF_EMAIL_CONSTRAINT = "verify_staff_email";

const STAFF_EMAIL_UNIQUE = {
  name: STAFF_EMAIL_CONSTRAINT,
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const VerifyWorker = defineNode("VerifyWorker", {
  schema: z.object({ email: z.string() }),
});
const VerifyEmployee = defineNode("VerifyEmployee", {
  schema: z.object({ email: z.string() }),
});
const VerifyContractor = defineNode("VerifyContractor", {
  schema: z.object({ email: z.string() }),
});
const VerifyCompany = defineNode("VerifyCompany", {
  schema: z.object({ name: z.string() }),
});
const VerifyProject = defineNode("VerifyProject", {
  schema: z.object({ title: z.string() }),
});

const verifyManages = defineEdge("verifyManages", {
  schema: z.object({}),
});

/**
 * One graph carrying all three families: a scope spanning a hierarchy, a
 * declared disjoint pair, and a `cardinality: "one"` edge.
 */
const verifyGraph = defineGraph({
  id: "constraint_fence_verification",
  nodes: {
    VerifyWorker: { type: VerifyWorker, unique: [STAFF_EMAIL_UNIQUE] },
    VerifyEmployee: { type: VerifyEmployee, unique: [STAFF_EMAIL_UNIQUE] },
    VerifyContractor: { type: VerifyContractor, unique: [STAFF_EMAIL_UNIQUE] },
    VerifyCompany: { type: VerifyCompany },
    VerifyProject: { type: VerifyProject },
  },
  edges: {
    verifyManages: {
      type: verifyManages,
      from: [VerifyEmployee],
      to: [VerifyProject],
      cardinality: "one",
    },
  },
  ontology: [
    subClassOf(VerifyEmployee, VerifyWorker),
    subClassOf(VerifyContractor, VerifyWorker),
    disjointWith(VerifyEmployee, VerifyCompany),
  ],
});

const registry = buildKindRegistry(verifyGraph);

/** Where every kind of the hierarchy folds — the row they all contend for. */
const STAFF_AXIS = uniquenessClaimAxis(
  "VerifyEmployee",
  "kindWithSubClasses",
  registry,
);

function emailKey(email: string): string {
  return computeUniqueKey({ email }, ["email"], "binary");
}

/** Cross-backend fence diagnostics. */
export function registerConstraintFenceVerificationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("verifyConstraintFences", () => {
    it("reports nothing while every declared constraint holds", async () => {
      const store = await context.createStore(verifyGraph);
      const employee = await store.nodes.VerifyEmployee.create({
        email: "ada@example.com",
      });
      await store.nodes.VerifyContractor.create({ email: "grace@example.com" });
      await store.nodes.VerifyCompany.create({ name: "Nicia" });
      const project = await store.nodes.VerifyProject.create({
        title: "Fences",
      });
      await store.edges.verifyManages.create(employee, project, {});

      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("reports a scoped key held at two axes by two different nodes", async () => {
      const store = await context.createStore(verifyGraph);
      const employee = await store.nodes.VerifyEmployee.create({
        email: "ada@example.com",
      });
      const contractor = await store.nodes.VerifyContractor.create({
        email: "grace@example.com",
      });

      // The pre-upgrade shape: a second node's claim for Ada's key sits at its
      // own concrete kind rather than at the component's axis, so it lands on a
      // row that can never collide with the incumbent's. Both rows are live and
      // both fold onto STAFF_AXIS, which is what makes them one contention.
      await store.backend.insertUnique({
        graphId: verifyGraph.id,
        nodeKind: "VerifyEmployee",
        constraintName: STAFF_EMAIL_CONSTRAINT,
        key: emailKey("ada@example.com"),
        nodeId: contractor.id,
        concreteKind: "VerifyContractor",
      });

      expect(await store.verifyConstraintFences()).toEqual([
        {
          family: "nodeUniqueness",
          target: {
            relation: "uniques",
            graphId: verifyGraph.id,
            axis: STAFF_AXIS,
            constraintName: STAFF_EMAIL_CONSTRAINT,
            key: emailKey("ada@example.com"),
          },
          owners: [
            { concreteKind: "VerifyContractor", nodeId: contractor.id },
            { concreteKind: "VerifyEmployee", nodeId: employee.id },
          ].toSorted((left, right) =>
            left.concreteKind === right.concreteKind ?
              left.nodeId.localeCompare(right.nodeId)
            : left.concreteKind.localeCompare(right.concreteKind),
          ),
        },
      ]);
    });

    it("does not report one node holding the same key at two axes", async () => {
      const store = await context.createStore(verifyGraph);
      const employee = await store.nodes.VerifyEmployee.create({
        email: "ada@example.com",
      });

      // The other thing an axis move leaves behind: the SAME node holding its
      // key at the legacy axis and at the new one. Two rows, one owner pair,
      // no constraint violated — which is why the report counts distinct
      // owners rather than rows.
      await store.backend.insertUnique({
        graphId: verifyGraph.id,
        nodeKind: "VerifyEmployee",
        constraintName: STAFF_EMAIL_CONSTRAINT,
        key: emailKey("ada@example.com"),
        nodeId: employee.id,
        concreteKind: "VerifyEmployee",
      });

      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("reports an id live under both kinds of a disjoint pair", async () => {
      const store = await context.createStore(verifyGraph);
      const employee = await store.nodes.VerifyEmployee.create({
        email: "ada@example.com",
      });

      // The nodes primary key is (graph, kind, id), so the namesake row is a
      // legal insert the disjointness claim is the only fence for — and a
      // database written before that claim existed can hold both.
      await store.backend.insertNode({
        graphId: verifyGraph.id,
        kind: "VerifyCompany",
        id: employee.id,
        props: { name: "Ada Ltd" },
      });

      expect(await store.verifyConstraintFences()).toEqual([
        {
          family: "nodeDisjointness",
          target: {
            relation: "uniques",
            graphId: verifyGraph.id,
            axis: disjointnessClaimAxis(
              "VerifyEmployee",
              "VerifyCompany",
              registry,
            ),
            constraintName: DISJOINT_CONSTRAINT_NAME,
            key: employee.id,
          },
          owners: [
            { concreteKind: "VerifyCompany", nodeId: employee.id },
            { concreteKind: "VerifyEmployee", nodeId: employee.id },
          ],
        },
      ]);
    });

    it("reports two live edges on one cardinality:one axis", async () => {
      const store = await context.createStore(verifyGraph);
      const employee = await store.nodes.VerifyEmployee.create({
        email: "ada@example.com",
      });
      const first = await store.nodes.VerifyProject.create({ title: "First" });
      const second = await store.nodes.VerifyProject.create({
        title: "Second",
      });
      const edge = await store.edges.verifyManages.create(employee, first, {});

      // The edges primary key is (graph, id), so a second edge from the same
      // source is a legal insert: the cardinality is fenced by the claim
      // relation alone, and pre-upgrade rows hold none.
      await store.backend.insertEdge({
        graphId: verifyGraph.id,
        id: "verify-unfenced-edge",
        kind: "verifyManages",
        fromKind: "VerifyEmployee",
        fromId: employee.id,
        toKind: "VerifyProject",
        toId: second.id,
        props: {},
      });

      const violations = await store.verifyConstraintFences();
      expect(violations).toHaveLength(1);
      const violation = requireDefined(violations[0], "cardinality violation");
      expect(violation.target).toEqual({
        relation: "edgeClaims",
        graphId: verifyGraph.id,
        axis: "one:verifyManages",
        key: encodeTupleKey(["VerifyEmployee", employee.id]),
      });
      // Narrowed by assertion rather than by a ternary, so a report that named
      // the wrong family fails here instead of comparing an empty list.
      if (violation.family !== "edgeCardinality")
        throw new Error(`expected an edge violation, got ${violation.family}`);
      expect(violation.edgeIds).toEqual(
        [edge.id, "verify-unfenced-edge"].toSorted(),
      );
    });

    it("does not report a soft-deleted second edge on the same axis", async () => {
      const store = await context.createStore(verifyGraph);
      const employee = await store.nodes.VerifyEmployee.create({
        email: "ada@example.com",
      });
      const first = await store.nodes.VerifyProject.create({ title: "First" });
      const second = await store.nodes.VerifyProject.create({
        title: "Second",
      });
      await store.edges.verifyManages.create(employee, first, {});

      await store.backend.insertEdge({
        graphId: verifyGraph.id,
        id: "verify-deleted-edge",
        kind: "verifyManages",
        fromKind: "VerifyEmployee",
        fromId: employee.id,
        toKind: "VerifyProject",
        toId: second.id,
        props: {},
      });
      await store.backend.deleteEdge({
        graphId: verifyGraph.id,
        id: "verify-deleted-edge",
      });

      // A tombstoned holder is not a claimant: the takeover statement's own
      // liveness predicate would take its axis. The report reads the same
      // population, so it must not name it either.
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("audits declarations added after this Store became stale", async () => {
      const staleStore = await context.createStore(verifyGraph);
      const evolved = await staleStore.evolve(
        defineGraphExtension({
          nodes: {
            AuditLeft: { properties: {} },
            AuditRight: { properties: {} },
          },
          ontology: [
            {
              metaEdge: "disjointWith",
              from: "AuditLeft",
              to: "AuditRight",
            },
          ],
        }),
      );
      await staleStore.backend.insertNode({
        graphId: verifyGraph.id,
        kind: "AuditLeft",
        id: "stale-audit-overlap",
        props: {},
      });
      await staleStore.backend.insertNode({
        graphId: verifyGraph.id,
        kind: "AuditRight",
        id: "stale-audit-overlap",
        props: {},
      });

      expect(await staleStore.verifyConstraintFences()).toEqual([
        {
          family: "nodeDisjointness",
          target: {
            relation: "uniques",
            graphId: verifyGraph.id,
            axis: disjointnessClaimAxis(
              "AuditLeft",
              "AuditRight",
              evolved.registry,
            ),
            constraintName: DISJOINT_CONSTRAINT_NAME,
            key: "stale-audit-overlap",
          },
          owners: [
            { concreteKind: "AuditLeft", nodeId: "stale-audit-overlap" },
            { concreteKind: "AuditRight", nodeId: "stale-audit-overlap" },
          ],
        },
      ]);
    });
  });
}
