/**
 * No declared constraint is ever left violated, whatever order writes arrive in.
 *
 * The claim relations fence four families — a `scope: "kind"` unique, a
 * `scope: "kindWithSubClasses"` unique spanning a hierarchy, a `disjointWith`
 * pair, and an edge cardinality — and each one is decided by a fold (the claim
 * AXIS) plus a table of facts (the cardinality SPEC). A fold that answers
 * differently for two kinds of one scope, or a spec that names the wrong
 * population, does not fail loudly: it writes two claim rows that can never
 * collide, and the second violating write is silently ACCEPTED. That is a
 * property of the write sequence, not of any one case, so it is checked over
 * random ones.
 *
 * The oracle is deliberately NOT the claim vocabulary. Each step's invariant is
 * re-derived from the live rows themselves — two live nodes must not share a
 * scoped key, an id must not live under both kinds of a disjoint pair, a
 * `cardinality: "one"` source must not have two live edges — so a mutation to
 * the axis or the spec that moves BOTH the writer and a claim-derived oracle
 * cannot hide behind their agreement. `verifyConstraintFences()` is asserted
 * alongside as a cross-check: on data the fences kept clean it must report
 * nothing.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  asEdgeId,
  asNodeId,
  CardinalityError,
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  DisjointError,
  disjointWith,
  EdgeNotFoundError,
  EndpointError,
  NodeNotFoundError,
  RestrictedDeleteError,
  subClassOf,
  UniquenessError,
  ValidationError,
} from "../../src";
import { type GraphBackend } from "../../src/backend/types";
import { createTestBackend } from "../test-utils";

const FencedWorker = defineNode("FencedWorker", {
  schema: z.object({ email: z.string() }),
});
const FencedEmployee = defineNode("FencedEmployee", {
  schema: z.object({ email: z.string() }),
});
const FencedContractor = defineNode("FencedContractor", {
  schema: z.object({ email: z.string() }),
});
const FencedCompany = defineNode("FencedCompany", {
  schema: z.object({ name: z.string() }),
});
const FencedVendor = defineNode("FencedVendor", {
  schema: z.object({ code: z.string() }),
});

const propertyManages = defineEdge("fencedManages", { schema: z.object({}) });

const STAFF_EMAIL_UNIQUE = {
  name: "fenced_staff_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const VENDOR_CODE_UNIQUE = {
  name: "fenced_vendor_code",
  fields: ["code"],
  scope: "kind",
  collation: "binary",
} as const;

/** One graph carrying all four families the claim relations fence. */
const claimGraph = defineGraph({
  id: "fenced_constraint_claims",
  nodes: {
    FencedWorker: { type: FencedWorker, unique: [STAFF_EMAIL_UNIQUE] },
    FencedEmployee: { type: FencedEmployee, unique: [STAFF_EMAIL_UNIQUE] },
    FencedContractor: { type: FencedContractor, unique: [STAFF_EMAIL_UNIQUE] },
    FencedCompany: { type: FencedCompany },
    FencedVendor: { type: FencedVendor, unique: [VENDOR_CODE_UNIQUE] },
  },
  edges: {
    fencedManages: {
      type: propertyManages,
      from: [FencedEmployee],
      to: [FencedVendor],
      cardinality: "one",
    },
  },
  ontology: [
    subClassOf(FencedEmployee, FencedWorker),
    subClassOf(FencedContractor, FencedWorker),
    disjointWith(FencedEmployee, FencedCompany),
  ],
});

/** Short pools, so collisions are the common case rather than the rare one. */
const ID_POOL = ["i1", "i2", "i3"] as const;
const EMAIL_POOL = ["a@x", "b@x"] as const;
const CODE_POOL = ["c1", "c2"] as const;
const STAFF_KINDS = ["FencedEmployee", "FencedContractor"] as const;
const ALL_KINDS = [
  "FencedEmployee",
  "FencedContractor",
  "FencedCompany",
  "FencedVendor",
] as const;

type StaffKind = (typeof STAFF_KINDS)[number];
type AnyKind = (typeof ALL_KINDS)[number];

type Step =
  | Readonly<{
      type: "upsertStaff";
      kind: StaffKind;
      id: string;
      email: string;
    }>
  | Readonly<{ type: "upsertCompany"; id: string }>
  | Readonly<{ type: "upsertVendor"; id: string; code: string }>
  | Readonly<{ type: "deleteNode"; kind: AnyKind; id: string }>
  | Readonly<{ type: "link"; employeeId: string; vendorId: string }>
  | Readonly<{ type: "unlink"; employeeId: string; vendorId: string }>;

const stepArb: fc.Arbitrary<Step> = fc.oneof(
  fc.record({
    type: fc.constant("upsertStaff" as const),
    kind: fc.constantFrom(...STAFF_KINDS),
    id: fc.constantFrom(...ID_POOL),
    email: fc.constantFrom(...EMAIL_POOL),
  }),
  fc.record({
    type: fc.constant("upsertCompany" as const),
    id: fc.constantFrom(...ID_POOL),
  }),
  fc.record({
    type: fc.constant("upsertVendor" as const),
    id: fc.constantFrom(...ID_POOL),
    code: fc.constantFrom(...CODE_POOL),
  }),
  fc.record({
    type: fc.constant("deleteNode" as const),
    kind: fc.constantFrom(...ALL_KINDS),
    id: fc.constantFrom(...ID_POOL),
  }),
  fc.record({
    type: fc.constant("link" as const),
    employeeId: fc.constantFrom(...ID_POOL),
    vendorId: fc.constantFrom(...ID_POOL),
  }),
  fc.record({
    type: fc.constant("unlink" as const),
    employeeId: fc.constantFrom(...ID_POOL),
    vendorId: fc.constantFrom(...ID_POOL),
  }),
);

/**
 * The refusals a random sequence is EXPECTED to produce: a declared constraint
 * saying no, or a write naming a row that is not there. Anything else is a
 * defect and is re-thrown — swallowing every error would turn a store that
 * rejects all writes into a passing run.
 */
function isExpectedRefusal(error: unknown): boolean {
  return (
    error instanceof UniquenessError ||
    error instanceof DisjointError ||
    error instanceof CardinalityError ||
    error instanceof EndpointError ||
    error instanceof NodeNotFoundError ||
    error instanceof EdgeNotFoundError ||
    error instanceof RestrictedDeleteError ||
    error instanceof ValidationError
  );
}

type Store = ReturnType<typeof createStore<typeof claimGraph>>;

/** Runs one step, letting the declared refusals through as no-ops. */
async function applyStep(
  store: Store,
  edgeIds: Map<string, string>,
  step: Step,
): Promise<void> {
  try {
    switch (step.type) {
      case "upsertStaff": {
        await store.nodes[step.kind].upsertById(step.id, {
          email: step.email,
        });
        return;
      }
      case "upsertCompany": {
        await store.nodes.FencedCompany.upsertById(step.id, { name: step.id });
        return;
      }
      case "upsertVendor": {
        await store.nodes.FencedVendor.upsertById(step.id, { code: step.code });
        return;
      }
      case "deleteNode": {
        await store.nodes[step.kind].delete(asNodeId(step.id));
        return;
      }
      case "link": {
        const employee = await store.nodes.FencedEmployee.getById(
          asNodeId<typeof FencedEmployee>(step.employeeId),
        );
        const vendor = await store.nodes.FencedVendor.getById(
          asNodeId<typeof FencedVendor>(step.vendorId),
        );
        if (employee === undefined || vendor === undefined) return;
        const edge = await store.edges.fencedManages.create(
          employee,
          vendor,
          {},
        );
        edgeIds.set(`${step.employeeId}->${step.vendorId}`, edge.id);
        return;
      }
      case "unlink": {
        const edgeId = edgeIds.get(`${step.employeeId}->${step.vendorId}`);
        if (edgeId === undefined) return;
        await store.edges.fencedManages.delete(asEdgeId(edgeId));
        edgeIds.delete(`${step.employeeId}->${step.vendorId}`);
        return;
      }
    }
  } catch (error) {
    if (!isExpectedRefusal(error)) throw error;
  }
}

/** Every live node of a kind, as `(kind, id, key)` triples. */
async function liveKeys(
  store: Store,
  kind: StaffKind | "FencedVendor",
): Promise<readonly Readonly<{ kind: string; id: string; key: string }>[]> {
  if (kind === "FencedVendor") {
    const rows = await store.nodes.FencedVendor.find();
    return rows.map((row) => ({ kind, id: row.id, key: row.code }));
  }
  const rows =
    kind === "FencedEmployee" ?
      await store.nodes.FencedEmployee.find()
    : await store.nodes.FencedContractor.find();
  return rows.map((row) => ({ kind, id: row.id, key: row.email }));
}

/** Every declared constraint, re-derived from the live rows alone. */
async function assertConstraintsHold(
  store: Store,
  backend: GraphBackend,
): Promise<void> {
  // 1. The shared scope: one live claimant per email across the hierarchy.
  const staff = [
    ...(await liveKeys(store, "FencedEmployee")),
    ...(await liveKeys(store, "FencedContractor")),
  ];
  const staffOwnersByKey = new Map<string, string[]>();
  for (const entry of staff) {
    const owners = staffOwnersByKey.get(entry.key) ?? [];
    owners.push(`${entry.kind}/${entry.id}`);
    staffOwnersByKey.set(entry.key, owners);
  }
  for (const [key, owners] of staffOwnersByKey)
    expect(owners, `live staff sharing email ${key}`).toHaveLength(1);

  // 2. The single-kind scope: one live claimant per vendor code.
  const vendors = await liveKeys(store, "FencedVendor");
  const codes = vendors.map((vendor) => vendor.key);
  expect(new Set(codes).size, "live vendors sharing a code").toBe(codes.length);

  // 3. Disjointness: no id live under both kinds of the declared pair.
  const companies = await store.nodes.FencedCompany.find();
  const companyIds = new Set<string>(companies.map((company) => company.id));
  const overlap = staff
    .filter((entry) => entry.kind === "FencedEmployee")
    .filter((entry) => companyIds.has(entry.id));
  expect(overlap, "ids live as both FencedEmployee and FencedCompany").toEqual(
    [],
  );

  // 4. Cardinality `one`: at most one live edge from each source.
  for (const entry of staff.filter(
    (candidate) => candidate.kind === "FencedEmployee",
  )) {
    const count = await backend.countEdgesFrom({
      graphId: claimGraph.id,
      edgeKind: "fencedManages",
      fromKind: "FencedEmployee",
      fromId: entry.id,
      activeOnly: false,
    });
    expect(count, `live fencedManages edges from ${entry.id}`).toBeLessThan(2);
  }

  // The diagnostic must agree with the four checks above on clean data.
  expect(await store.verifyConstraintFences()).toEqual([]);
}

/**
 * A populated starting state, identical for every run.
 *
 * Without it the interesting region is barely reachable: a second edge on one
 * cardinality axis needs a live source and two live targets, which a purely
 * random 16-step sequence over four kinds produces too rarely to be relied on.
 * The prelude itself violates nothing — two staff with distinct emails, two
 * vendors with distinct codes — so every violation a run could produce is
 * produced by the random steps.
 */
async function seedStartingState(store: Store): Promise<void> {
  await store.nodes.FencedEmployee.upsertById("i1", { email: "a@x" });
  await store.nodes.FencedEmployee.upsertById("i2", { email: "b@x" });
  await store.nodes.FencedVendor.upsertById("i1", { code: "c1" });
  await store.nodes.FencedVendor.upsertById("i2", { code: "c2" });
}

describe("constraint claims hold over random write sequences", () => {
  it("never leaves two live claimants on one axis", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(stepArb, { minLength: 1, maxLength: 16 }),
        async (steps) => {
          const backend = createTestBackend();
          const store = createStore(claimGraph, backend);
          await seedStartingState(store);
          const edgeIds = new Map<string, string>();
          await assertConstraintsHold(store, backend);
          for (const step of steps) {
            await applyStep(store, edgeIds, step);
            await assertConstraintsHold(store, backend);
          }
        },
      ),
      { numRuns: 60 },
    );
  });
});
