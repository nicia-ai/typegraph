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

const verifyAssignedTo = defineEdge("verifyAssignedTo", {
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
    // Both axes, so one graph exercises target-side reporting AND
    // independent per-axis reporting on the same edge kind.
    verifyAssignedTo: {
      type: verifyAssignedTo,
      from: [VerifyEmployee],
      to: [VerifyProject],
      cardinality: "one",
      targetCardinality: "one",
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
      // Narrowed by assertion rather than by a ternary, so a report that named
      // the wrong family fails here instead of comparing an empty list.
      if (violation.family !== "edgeCardinality")
        throw new Error(`expected an edge violation, got ${violation.family}`);
      expect(violation.target).toEqual({
        relation: "edgeClaims",
        graphId: verifyGraph.id,
        axis: "one:verifyManages",
        key: encodeTupleKey(["VerifyEmployee", employee.id]),
      });
      expect(violation.edgeIds).toEqual(
        [edge.id, "verify-unfenced-edge"].toSorted(),
      );
    });

    it("reports a target-side violation with the target-axis ClaimTarget (issue #610)", async () => {
      const store = await context.createStore(verifyGraph);
      const first = await store.nodes.VerifyEmployee.create({
        email: "target-fence-1@example.com",
      });
      const second = await store.nodes.VerifyEmployee.create({
        email: "target-fence-2@example.com",
      });
      const project = await store.nodes.VerifyProject.create({
        title: "Shared",
      });
      const edge = await store.edges.verifyAssignedTo.create(
        first,
        project,
        {},
      );

      // Second employee assigned to the SAME project, written unfenced
      // (pre-upgrade shape): the target axis is now contended.
      await store.backend.insertEdge({
        graphId: verifyGraph.id,
        id: "verify-target-unfenced-edge",
        kind: "verifyAssignedTo",
        fromKind: "VerifyEmployee",
        fromId: second.id,
        toKind: "VerifyProject",
        toId: project.id,
        props: {},
      });

      const violations = await store.verifyConstraintFences();
      const targetViolations = violations.filter(
        (candidate) =>
          candidate.family === "edgeCardinality" &&
          candidate.target.axis !== "one:verifyAssignedTo",
      );
      expect(targetViolations).toHaveLength(1);
      const violation = requireDefined(targetViolations[0]);
      if (violation.family !== "edgeCardinality") {
        throw new Error(`expected an edge violation, got ${violation.family}`);
      }
      expect(violation.target).toEqual({
        relation: "edgeClaims",
        graphId: verifyGraph.id,
        axis: "\u001Eto\u001Eone:verifyAssignedTo",
        key: encodeTupleKey(["VerifyProject", project.id]),
      });
      expect(violation.edgeIds).toEqual(
        [edge.id, "verify-target-unfenced-edge"].toSorted(),
      );
    });
    // MUTATION CHECK (verified): have `fenceDeclarations`
    // (`src/store/claims/verify.ts`) emit source refs only (drop the
    // `edgeCardinalityAxisReferences` fold in favor of the pre-D.1
    // single-cardinality read). The target-side violation this test asserts
    // goes unreported and `targetViolations` reads `[]`.

    it("reports both axes independently when an edge kind declares both", async () => {
      const store = await context.createStore(verifyGraph);
      const employee = await store.nodes.VerifyEmployee.create({
        email: "both-axes@example.com",
      });
      const otherEmployee = await store.nodes.VerifyEmployee.create({
        email: "both-axes-2@example.com",
      });
      const project = await store.nodes.VerifyProject.create({
        title: "BothAxes",
      });
      const otherProject = await store.nodes.VerifyProject.create({
        title: "BothAxesOther",
      });
      await store.edges.verifyAssignedTo.create(employee, project, {});

      // Contend the SOURCE axis (employee already has one) and the TARGET
      // axis (project already has one), written unfenced.
      await store.backend.insertEdge({
        graphId: verifyGraph.id,
        id: "verify-both-source-unfenced",
        kind: "verifyAssignedTo",
        fromKind: "VerifyEmployee",
        fromId: employee.id,
        toKind: "VerifyProject",
        toId: otherProject.id,
        props: {},
      });
      await store.backend.insertEdge({
        graphId: verifyGraph.id,
        id: "verify-both-target-unfenced",
        kind: "verifyAssignedTo",
        fromKind: "VerifyEmployee",
        fromId: otherEmployee.id,
        toKind: "VerifyProject",
        toId: project.id,
        props: {},
      });

      const violations = await store.verifyConstraintFences();
      const assignedToViolations = violations.filter(
        (candidate) =>
          candidate.family === "edgeCardinality" &&
          (candidate.target.axis === "one:verifyAssignedTo" ||
            candidate.target.axis === "\u001Eto\u001Eone:verifyAssignedTo"),
      );
      expect(assignedToViolations).toHaveLength(2);
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

    it("reports a live edge sitting outside every declared endpoint pair", async () => {
      const store = await context.createStore(verifyGraph);
      const contractor = await store.nodes.VerifyContractor.create({
        email: "grace@example.com",
      });
      const project = await store.nodes.VerifyProject.create({
        title: "Fences",
      });

      // `verifyManages` only ever declares `from: [VerifyEmployee]`, so a
      // `VerifyContractor` source is a pre-upgrade shape no live claim
      // fences: the edges primary key is `(graph, id)`, so this insert is
      // legal and holds no cardinality claim against it.
      await store.backend.insertEdge({
        graphId: verifyGraph.id,
        id: "verify-misassigned-edge",
        kind: "verifyManages",
        fromKind: "VerifyContractor",
        fromId: contractor.id,
        toKind: "VerifyProject",
        toId: project.id,
        props: {},
      });

      expect(await store.verifyConstraintFences()).toEqual([
        {
          family: "edgeEndpointAssignability",
          edgeKind: "verifyManages",
          allowedPairs: [["VerifyEmployee", "VerifyProject"]],
          edges: [
            {
              edgeKind: "verifyManages",
              edgeId: "verify-misassigned-edge",
              fromKind: "VerifyContractor",
              fromId: contractor.id,
              toKind: "VerifyProject",
              toId: project.id,
            },
          ],
        },
      ]);
    });

    it("does not report a misassigned edge whose valid-time window already closed", async () => {
      const store = await context.createStore(verifyGraph);
      const contractor = await store.nodes.VerifyContractor.create({
        email: "closed-window@example.com",
      });
      const project = await store.nodes.VerifyProject.create({
        title: "Closed window",
      });

      // Same misassignment as the case above, but its valid-time window
      // ended in the past — a current-coordinate read never returns this
      // row, so it cannot be violating a declaration only current reads
      // apply to. "Live" for this family is the same current-window
      // predicate `compileTemporalFilter({ mode: "current" })` compiles for
      // an ordinary read: `deleted_at IS NULL AND (valid_from IS NULL OR
      // valid_from <= now) AND (valid_to IS NULL OR valid_to > now)`.
      await store.backend.insertEdge({
        graphId: verifyGraph.id,
        id: "verify-misassigned-edge-closed-window",
        kind: "verifyManages",
        fromKind: "VerifyContractor",
        fromId: contractor.id,
        toKind: "VerifyProject",
        toId: project.id,
        props: {},
        validFrom: "2019-01-01T00:00:00.000Z",
        validTo: "2020-01-01T00:00:00.000Z",
      });

      expect(await store.verifyConstraintFences()).toEqual([]);
    });
    // MUTATION CHECK (verified): dropping the `valid_to > now` half of the
    // current-window predicate in `buildMisassignedEdgeEndpointAudit`
    // (`src/backend/drizzle/operations/constraint-fence-audit.ts`) reports
    // this closed-window row as a live violation and this test fails.

    it("reports a misassigned edge with a bounded FUTURE valid-time window", async () => {
      const store = await context.createStore(verifyGraph);
      const contractor = await store.nodes.VerifyContractor.create({
        email: "future-window@example.com",
      });
      const project = await store.nodes.VerifyProject.create({
        title: "Future window",
      });

      // The window is CURRENTLY open (started in the past, ends far in the
      // future) — exactly what an ordinary current-coordinate read returns
      // today. A predicate that excludes anything but `valid_to IS NULL`
      // would miss this row entirely, which is the bug this case guards.
      await store.backend.insertEdge({
        graphId: verifyGraph.id,
        id: "verify-misassigned-edge-future-window",
        kind: "verifyManages",
        fromKind: "VerifyContractor",
        fromId: contractor.id,
        toKind: "VerifyProject",
        toId: project.id,
        props: {},
        validFrom: "2019-01-01T00:00:00.000Z",
        validTo: "2999-01-01T00:00:00.000Z",
      });

      expect(await store.verifyConstraintFences()).toEqual([
        {
          family: "edgeEndpointAssignability",
          edgeKind: "verifyManages",
          allowedPairs: [["VerifyEmployee", "VerifyProject"]],
          edges: [
            {
              edgeKind: "verifyManages",
              edgeId: "verify-misassigned-edge-future-window",
              fromKind: "VerifyContractor",
              fromId: contractor.id,
              toKind: "VerifyProject",
              toId: project.id,
            },
          ],
        },
      ]);
    });
    // MUTATION CHECK (verified): restoring the original `valid_to IS NULL`
    // liveness predicate (instead of the current-window one) makes this
    // bounded-future-window row invisible to the audit and this test fails.

    it(
      "audits a wide subclass hierarchy without exceeding SQLite's " +
        "expression-tree depth or a connection's bind-parameter budget",
      async () => {
        // (141)^2 = 19,881 admitted pairs after subsumption expansion: past
        // SQLite's `SQLITE_MAX_EXPR_DEPTH` break (an `OR`-chain rendering of
        // the allowance breaks at ~1,000-1,700 pairs — a root with ~31-40
        // direct subclasses) AND past a single statement's bind-parameter
        // budget (32,766 modern SQLite / 32,767 Postgres), so this width
        // forces the real multi-statement, intersected-chunk path this audit
        // now takes — not merely a bigger single query.
        const SUBCLASS_COUNT = 140;
        const WideRoot = defineNode("WideRoot", { schema: z.object({}) });
        const WideAlien = defineNode("WideAlien", { schema: z.object({}) });
        const subclasses = Array.from({ length: SUBCLASS_COUNT }, (_, index) =>
          defineNode(`WideSub${index}`, { schema: z.object({}) }),
        );
        const wideRelationship = defineEdge("wideRelationship", {
          schema: z.object({}),
        });
        const wideGraph = defineGraph({
          id: "constraint_fence_wide_hierarchy",
          nodes: {
            WideRoot: { type: WideRoot },
            WideAlien: { type: WideAlien },
            ...Object.fromEntries(
              subclasses.map((sub, index) => [
                `WideSub${index}`,
                { type: sub },
              ]),
            ),
          },
          edges: {
            wideRelationship: {
              type: wideRelationship,
              from: [WideRoot],
              to: [WideRoot],
            },
          },
          ontology: subclasses.map((sub) => subClassOf(sub, WideRoot)),
        });

        const store = await context.createStore(wideGraph);

        // Every node, including the two leaves and the misassigned edge's
        // endpoints, is written through the backend directly: the dynamically
        // built `nodes` map has no per-kind literal keys for the typed
        // `store.nodes.<Kind>` collections to resolve at compile time, and
        // (for the leaves) the live `subClassOf` relation that admits them as
        // `wideRelationship` endpoints is itself something only the backend's untyped
        // insert can express — exactly like the endpoint-shrink cases
        // elsewhere in this suite.
        await store.backend.insertNode({
          graphId: wideGraph.id,
          kind: "WideSub0",
          id: "wide-leaf-a",
          props: {},
        });
        await store.backend.insertNode({
          graphId: wideGraph.id,
          kind: "WideSub1",
          id: "wide-leaf-b",
          props: {},
        });
        // A legitimately admitted edge between two leaves. It must NOT
        // appear in the report.
        await store.backend.insertEdge({
          graphId: wideGraph.id,
          id: "wide-admitted-edge",
          kind: "wideRelationship",
          fromKind: "WideSub0",
          fromId: "wide-leaf-a",
          toKind: "WideSub1",
          toId: "wide-leaf-b",
          props: {},
        });

        // A genuinely misassigned edge: `WideAlien` is outside the
        // hierarchy entirely, so this row sits outside every one of the
        // (141)^2 admitted pairs and must be the only violation reported.
        await store.backend.insertNode({
          graphId: wideGraph.id,
          kind: "WideAlien",
          id: "wide-alien",
          props: {},
        });
        await store.backend.insertNode({
          graphId: wideGraph.id,
          kind: "WideRoot",
          id: "wide-root",
          props: {},
        });
        await store.backend.insertEdge({
          graphId: wideGraph.id,
          id: "wide-misassigned-edge",
          kind: "wideRelationship",
          fromKind: "WideAlien",
          fromId: "wide-alien",
          toKind: "WideRoot",
          toId: "wide-root",
          props: {},
        });

        const violations = await store.verifyConstraintFences();
        expect(violations).toHaveLength(1);
        const violation = requireDefined(
          violations[0],
          "wide-hierarchy violation",
        );
        if (violation.family !== "edgeEndpointAssignability") {
          throw new Error(
            `expected edgeEndpointAssignability, got ${violation.family}`,
          );
        }
        expect(violation.edgeKind).toBe("wideRelationship");
        expect(violation.edges).toEqual([
          {
            edgeKind: "wideRelationship",
            edgeId: "wide-misassigned-edge",
            fromKind: "WideAlien",
            fromId: "wide-alien",
            toKind: "WideRoot",
            toId: "wide-root",
          },
        ]);
        // Root paired with every kind (itself plus its 140 subclasses),
        // squared — proving the full allowance was expanded and read, not
        // silently truncated by the chunking this width forces.
        expect(violation.allowedPairs).toHaveLength((SUBCLASS_COUNT + 1) ** 2);
        expect(violation.allowedPairs).toContainEqual(["WideRoot", "WideRoot"]);
        expect(violation.allowedPairs).toContainEqual(["WideSub0", "WideSub1"]);
      },
      30_000,
    );
    // MUTATION CHECK (lane-A-load-bearing.md): reverting
    // `buildMisassignedEdgeEndpointAudit` to render the admitted pairs as an
    // `OR`-chain of bound equalities (rather than a `VALUES`-joined
    // `NOT EXISTS`) throws `SqliteError: Expression tree is too large` on
    // this case's SQLite lane.

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
