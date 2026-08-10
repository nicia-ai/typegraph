/**
 * A constraint refuses with the SAME error however it was caught (I3).
 *
 * Every declared constraint has two refusers: the application probe that reads
 * before the write, and the fence the write itself runs into when a peer took
 * the key between the two. A caller cannot tell which one fired and must not
 * have to — so the class, the code and the payload have to match exactly.
 *
 * The fixture is deliberately a hierarchy whose claim AXIS is not the
 * conflicting node's kind (`Contractor` is the code-point minimum of
 * `{Contractor, Employee, Worker}`, so an `Employee`'s claim is written at
 * `Contractor`). That makes the payload's `kind` load-bearing: reporting the
 * axis instead of the holder's own kind would name a kind the caller never
 * wrote, and the two refusers would disagree.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CardinalityError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  subClassOf,
  UniquenessError,
} from "../../../src";
import { type GraphBackend } from "../../../src/backend/types";
import { type IntegrationTestContext } from "./test-context";

const STAFF_EMAIL_CONSTRAINT = "fence_error_staff_email";

const STAFF_EMAIL_UNIQUE = {
  name: STAFF_EMAIL_CONSTRAINT,
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const Worker = defineNode("Worker", {
  schema: z.object({ email: z.string() }),
});
const Employee = defineNode("Employee", {
  schema: z.object({ email: z.string() }),
});
const Contractor = defineNode("Contractor", {
  schema: z.object({ email: z.string() }),
});

/**
 * A disjoint pair, declaring no unique constraint: the second refuser for these
 * two can only be the disjointness claim, whose axis is the PAIR and whose
 * refusal the claim seam has to translate back into the family's own error.
 */
const FenceGhost = defineNode("FenceGhost", {
  schema: z.object({ email: z.string() }),
});
const FenceSpirit = defineNode("FenceSpirit", {
  schema: z.object({ email: z.string() }),
});

/**
 * The cardinality family's fixture: `cardinality: "one"` declares no unique
 * constraint and no disjoint pair, so the second refuser for this edge kind
 * can only be the edge-claim relation (`edge-claims.ts`).
 */
const fenceHaunts = defineEdge("fenceHaunts", {
  schema: z.object({}),
});

const errorGraph = defineGraph({
  id: "constraint_fence_errors",
  nodes: {
    Worker: { type: Worker, unique: [STAFF_EMAIL_UNIQUE] },
    Employee: { type: Employee, unique: [STAFF_EMAIL_UNIQUE] },
    Contractor: { type: Contractor, unique: [STAFF_EMAIL_UNIQUE] },
    FenceGhost: { type: FenceGhost },
    FenceSpirit: { type: FenceSpirit },
  },
  edges: {
    fenceHaunts: {
      type: fenceHaunts,
      from: [FenceGhost],
      to: [FenceSpirit],
      cardinality: "one",
    },
  },
  ontology: [
    subClassOf(Employee, Worker),
    subClassOf(Contractor, Worker),
    disjointWith(FenceGhost, FenceSpirit),
  ],
});

/**
 * The same backend with the uniqueness PROBE blinded: `checkUnique` reports
 * every key as free, so the write reaches the claim and the claim is what
 * refuses. Nothing else is touched, so the write is otherwise the one the
 * store issues.
 */
function backendWithoutUniquenessProbe(backend: GraphBackend): GraphBackend {
  const blind: GraphBackend = {
    ...backend,
    checkUnique: () => Promise.resolve(undefined),
    checkUniqueBatch: () => Promise.resolve([]),
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run({
            ...target,
            checkUnique: () => Promise.resolve(undefined),
            checkUniqueBatch: () => Promise.resolve([]),
          }),
        options,
      ),
  };
  return blind;
}

/** What a caller can observe about a refusal, whichever layer produced it. */
function refusalShape(error: unknown): unknown {
  const uniqueness = error as UniquenessError;
  return {
    name: uniqueness.name,
    code: uniqueness.code,
    isUniquenessError: uniqueness instanceof UniquenessError,
    details: {
      constraintName: uniqueness.details.constraintName,
      kind: uniqueness.details.kind,
      existingId: uniqueness.details.existingId,
    },
  };
}

/**
 * The same backend with the DISJOINTNESS probe blinded: `getNode` reports the
 * partner kind's rows as absent, so the create reaches its claim and the claim
 * is what refuses. Only the partner kind is hidden — the create's own existence
 * gate still reads its own kind, so the write is otherwise the one the store
 * issues.
 */
function backendWithoutDisjointnessProbe(
  backend: GraphBackend,
  hiddenKind: string,
): GraphBackend {
  const getNode: GraphBackend["getNode"] = (graphId, kind, id) =>
    kind === hiddenKind ?
      Promise.resolve(undefined)
    : backend.getNode(graphId, kind, id);
  return {
    ...backend,
    getNode,
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run({
            ...target,
            getNode: (graphId, kind, id) =>
              kind === hiddenKind ?
                Promise.resolve(undefined)
              : target.getNode(graphId, kind, id),
          }),
        options,
      ),
  };
}

/**
 * The same backend with the CARDINALITY probe blinded: `countEdgesFrom`
 * reports zero regardless of what already exists, so the create reaches its
 * claim and the claim is what refuses. Only `countEdgesFrom` is hidden — the
 * `unique` cardinality's probe (`edgeExistsBetween`) is untouched, so this
 * fixture's `one` edge kind is the only one this blinds anything for.
 */
const countEdgesFromZero: GraphBackend["countEdgesFrom"] = () =>
  Promise.resolve(0);

function backendWithoutCardinalityProbe(backend: GraphBackend): GraphBackend {
  return {
    ...backend,
    countEdgesFrom: countEdgesFromZero,
    transaction: (run, options) =>
      backend.transaction(
        (target) =>
          run({
            ...target,
            countEdgesFrom: countEdgesFromZero,
          }),
        options,
      ),
  };
}

/** The cardinality twin of {@link refusalShape}. */
function cardinalityRefusalShape(error: unknown): unknown {
  const cardinality = error as CardinalityError;
  return {
    name: cardinality.name,
    code: cardinality.code,
    isCardinalityError: cardinality instanceof CardinalityError,
    details: {
      edgeKind: cardinality.details.edgeKind,
      fromKind: cardinality.details.fromKind,
      fromId: cardinality.details.fromId,
      cardinality: cardinality.details.cardinality,
      existingCount: cardinality.details.existingCount,
    },
  };
}

/** The disjointness twin of {@link refusalShape}. */
function disjointRefusalShape(error: unknown): unknown {
  const disjoint = error as DisjointError;
  return {
    name: disjoint.name,
    code: disjoint.code,
    isDisjointError: disjoint instanceof DisjointError,
    details: {
      nodeId: disjoint.details.nodeId,
      attemptedKind: disjoint.details.attemptedKind,
      conflictingKind: disjoint.details.conflictingKind,
    },
  };
}

async function captureRefusal(
  run: () => Promise<unknown>,
  shape: (error: unknown) => unknown = refusalShape,
): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return shape(error);
  }
  throw new Error("expected the write to be refused");
}

export function registerConstraintFenceErrorIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("constraint refusal identity", () => {
    it("reports the same uniqueness refusal from the probe and from the claim", async () => {
      const store = await context.createStore(errorGraph);
      const incumbent = await store.nodes.Employee.create(
        { email: "ada@identity.example" },
        { id: "identity-incumbent" },
      );

      // Leg 1: the probe refuses, because it reads the incumbent's claim
      // before the write. A refused create leaves the incumbent's claim row
      // exactly as it was, so leg 2 runs against the same state.
      const fromProbe = await captureRefusal(() =>
        store.nodes.Contractor.create(
          { email: "ada@identity.example" },
          { id: "identity-challenger" },
        ),
      );

      // Leg 2: the probe is blinded, so the write reaches the claim and the
      // claim's own verdict is what the caller sees.
      const blindStore = createStore(
        errorGraph,
        backendWithoutUniquenessProbe(store.backend),
      );
      const fromFence = await captureRefusal(() =>
        blindStore.nodes.Contractor.create(
          { email: "ada@identity.example" },
          { id: "identity-challenger" },
        ),
      );

      expect(fromFence).toEqual(fromProbe);
      // Load-bearing: the holder's own kind, not the claim axis it sits at.
      expect(fromProbe).toMatchObject({
        details: { kind: "Employee", existingId: incumbent.id },
      });
    });

    it("reports the same uniqueness refusal from a set update's re-check", async () => {
      // The set update has its own cross-kind re-check — a third refuser,
      // reading the same claim rows through `checkUniqueBatch`. It reads them
      // BY AXIS, so naming the kind it queried would report `Contractor` for a
      // key an `Employee` holds, and the three refusers would disagree.
      const store = await context.createStore(errorGraph);
      const incumbent = await store.nodes.Employee.create(
        { email: "grace@identity.example" },
        { id: "set-update-incumbent" },
      );
      await store.nodes.Contractor.create(
        { email: "grace-other@identity.example" },
        { id: "set-update-challenger" },
      );

      const fromSetUpdate = await captureRefusal(() =>
        store.nodes.Contractor.updateWhere({
          patch: { email: "grace@identity.example" },
          where: (contractor) => contractor.id.eq("set-update-challenger"),
        }),
      );

      expect(fromSetUpdate).toMatchObject({
        details: { kind: "Employee", existingId: incumbent.id },
      });
    });

    it("reports the same disjointness refusal from the probe and from the claim", async () => {
      // Two families share one claim relation, and the backend reports every
      // foreign owner of a claim row as a `UniquenessError` — so without the
      // translation at the claim seam this leg would hand the caller a
      // uniqueness violation naming a constraint the graph never declared.
      const store = await context.createStore(errorGraph);
      await store.nodes.FenceGhost.create(
        { email: "boo@identity.example" },
        { id: "disjoint-identity" },
      );

      // Leg 1: the disjointness probe reads the incumbent's node row.
      const fromProbe = await captureRefusal(
        () =>
          store.nodes.FenceSpirit.create(
            { email: "casper@identity.example" },
            { id: "disjoint-identity" },
          ),
        disjointRefusalShape,
      );

      // Leg 2: the probe cannot see the partner kind, so the write reaches its
      // claim and the claim's own verdict is what the caller sees.
      const blindStore = createStore(
        errorGraph,
        backendWithoutDisjointnessProbe(store.backend, "FenceGhost"),
      );
      const fromFence = await captureRefusal(
        () =>
          blindStore.nodes.FenceSpirit.create(
            { email: "casper@identity.example" },
            { id: "disjoint-identity" },
          ),
        disjointRefusalShape,
      );

      expect(fromFence).toEqual(fromProbe);
      expect(fromProbe).toMatchObject({
        isDisjointError: true,
        details: {
          nodeId: "disjoint-identity",
          attemptedKind: "FenceSpirit",
          conflictingKind: "FenceGhost",
        },
      });
    });

    it("reports the same cardinality refusal from the probe and from the claim", async () => {
      // The edge-cardinality family's own refuser is `edgeClaimRefusal`
      // (`edge-claims.ts`), and it shares its owners (`checkCardinality`,
      // `checkUniqueEdge`) with the probe (`checkCardinalityConstraint`) — the
      // same "one predicate, one owner" shape the uniqueness and disjointness
      // cases above pin. This case pins it for cardinality too.
      const store = await context.createStore(errorGraph);
      const source = await store.nodes.FenceGhost.create({
        email: "reaper@identity.example",
      });
      const incumbentTarget = await store.nodes.FenceSpirit.create({
        email: "wisp@identity.example",
      });
      const challengerTarget = await store.nodes.FenceSpirit.create({
        email: "specter@identity.example",
      });
      await store.edges.fenceHaunts.create(source, incumbentTarget, {});

      // Leg 1: the probe refuses, because it reads the incumbent edge's count
      // before the write. A refused create leaves the incumbent's claim row
      // exactly as it was, so leg 2 runs against the same state.
      const fromProbe = await captureRefusal(
        () => store.edges.fenceHaunts.create(source, challengerTarget, {}),
        cardinalityRefusalShape,
      );

      // Leg 2: the probe is blinded, so the write reaches the claim and the
      // claim's own verdict is what the caller sees.
      const blindStore = createStore(
        errorGraph,
        backendWithoutCardinalityProbe(store.backend),
      );
      const fromFence = await captureRefusal(
        () => blindStore.edges.fenceHaunts.create(source, challengerTarget, {}),
        cardinalityRefusalShape,
      );

      expect(fromFence).toEqual(fromProbe);
      expect(fromProbe).toMatchObject({
        isCardinalityError: true,
        details: {
          edgeKind: "fenceHaunts",
          fromKind: "FenceGhost",
          fromId: source.id,
          cardinality: "one",
          existingCount: 1,
        },
      });
    });
  });
}
