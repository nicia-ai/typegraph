/**
 * The plan-time identity simulation's node universe, from three review
 * findings on its seeding:
 *
 *  - a RETYPED canonical entity must enter the universe under the kind the
 *    commit will write, not its pre-retype kind;
 *  - the live same-id peer probe must read the merge TARGET, not the diff
 *    source, when the two differ (`mergeAgainstBase` / `mergeIncremental`);
 *  - the peer set must be revalidated inside the incremental commit
 *    transaction, so a peer landing in the plan→commit window is refused as
 *    a typed replan error rather than a generic commit failure.
 */
import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  disjointWith,
  subClassOf,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import {
  BaseVersionMismatchError,
  IdentityMergeConflictError,
} from "../../src/graph-merge/errors";
import {
  encodeClassFingerprint,
  merge,
  mergeAgainstBase,
  mergeIncremental,
} from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { storeRuntime } from "../../src/store/runtime-port";
import { backendMatrix } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const Robot = defineNode("Robot", {
  schema: z.object({ name: z.string() }),
});

/** Person and Robot are disjoint; same-id folding is on. */
const disjointFoldGraph = defineGraph({
  id: "identity_universe_guards",
  nodes: { Person: { type: Person }, Robot: { type: Robot } },
  edges: {},
  ontology: [disjointWith(Person, Robot)],
  identity: { sameIdAcrossKinds: "fold" },
});

const Staff = defineNode("Staff", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});
const Employee = defineNode("Employee", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});
const Peer = defineNode("Peer", {
  schema: z.object({ name: z.string() }),
});

/**
 * The ontology-retype shape beside a disjoint peer: a cluster whose survivor
 * keeps a Staff id but commits as Employee, while a live Peer shares that id
 * and `disjointWith(Employee, Peer)` holds. Only the RETYPED kind makes the
 * fold-into-disjoint-class contradiction visible.
 */
const retypeGraph = defineGraph({
  id: "identity_universe_retype",
  nodes: {
    Staff: { type: Staff },
    Employee: { type: Employee },
    Peer: { type: Peer },
  },
  edges: {},
  ontology: [subClassOf(Employee, Staff), disjointWith(Employee, Peer)],
  identity: { sameIdAcrossKinds: "fold" },
});

const ClusterPerson = defineNode("Person", {
  schema: z.object({ name: z.string(), birthDate: z.string() }),
});
const ClusterRobot = defineNode("Robot", {
  schema: z.object({ name: z.string() }),
});

/** Clusterable variant: similarity fuses same-birthDate Persons. */
const clusterFoldGraph = defineGraph({
  id: "identity_universe_cluster",
  nodes: { Person: { type: ClusterPerson }, Robot: { type: ClusterRobot } },
  edges: {},
  ontology: [disjointWith(ClusterPerson, ClusterRobot)],
  identity: { sameIdAcrossKinds: "fold" },
});

const Anchor = defineNode("Anchor", {
  schema: z.object({ name: z.string() }),
});

/** Person and Robot disjoint; Anchor freely folds/asserts with either. */
const anchoredFoldGraph = defineGraph({
  id: "identity_universe_anchored",
  nodes: {
    Person: { type: Person },
    Robot: { type: Robot },
    Anchor: { type: Anchor },
  },
  edges: {},
  ontology: [disjointWith(Person, Robot)],
  identity: { sameIdAcrossKinds: "fold" },
});

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

describe.each(backendMatrix())("identity universe guards [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups) await cleanup();
  });

  async function makeBackend(): Promise<GraphBackend> {
    const fixture = await entry.make();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  it("seeds a retyped canonical node under its committed kind", async () => {
    const [baseStore] = await createStoreWithSchema(
      retypeGraph,
      await makeBackend(),
    );
    await baseStore.nodes.Peer.create({ name: "Peer" }, { id: "s-a" });

    const staffBranch = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_A }),
    );
    const employeeBranch = unwrap(
      await branch(baseStore, () => makeBackend(), { id: BRANCH_B }),
    );
    // The cluster {Staff:s-a, Staff:s-b, Employee:s-b} survives as (Staff,
    // "s-a") retyped to Employee. Folding then joins it with the live
    // Peer:"s-a" — disjoint with Employee but NOT with Staff, so seeding the
    // pre-retype kind would let planning pass and commit fail generically.
    await staffBranch.store.nodes.Staff.create(
      { name: "Anna Rivera", birthDate: "1974-03-09" },
      { id: "s-a" },
    );
    await employeeBranch.store.nodes.Staff.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "s-b" },
    );
    await employeeBranch.store.nodes.Employee.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "s-b" },
    );

    const result = await merge(baseStore, [staffBranch, employeeBranch], {
      reconcileTypes: "ontology",
      resolve: {
        Staff: {
          block: (node) =>
            (node as unknown as { birthDate?: string }).birthDate,
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 0.85,
        },
      },
      branchOrder: [BRANCH_A, BRANCH_B],
    });

    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    // Plan-time refusal: nothing committed.
    expect(
      await baseStore.nodes.Employee.getById("s-a" as never),
    ).toBeUndefined();
  });

  it("probes the merge TARGET for live peers, not the diff source", async () => {
    const [source] = await createStoreWithSchema(
      disjointFoldGraph,
      await makeBackend(),
    );
    const [target] = await createStoreWithSchema(
      disjointFoldGraph,
      await makeBackend(),
    );
    await target.nodes.Robot.create({ name: "Clash" }, { id: "shared" });

    const personBranch = unwrap(
      await branch(source, () => makeBackend(), { id: BRANCH_A }),
    );
    await personBranch.store.nodes.Person.create(
      { name: "Clash" },
      { id: "shared" },
    );

    const result = await mergeAgainstBase(source, [personBranch], { target });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    expect(
      await target.nodes.Person.getById("shared" as never),
    ).toBeUndefined();
  });

  it("refuses class-transitive drift from a window NODE at another member id", async () => {
    // The anchors and their assertion live in the FORK POINT (and thus in
    // the cloned target and the branch unchanged): nothing stages them, so
    // no probe id covers "y" — only the class snapshot can see the drift
    // when a window Robot:y joins the class through its other member.
    const [forkPoint] = await createStoreWithSchema(
      anchoredFoldGraph,
      await makeBackend(),
    );
    const anchorX = await forkPoint.nodes.Anchor.create(
      { name: "X" },
      { id: "x" },
    );
    const anchorY = await forkPoint.nodes.Anchor.create(
      { name: "Y" },
      { id: "y" },
    );
    await forkPoint.identity.assertSame(anchorX, anchorY);
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;

    const personBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await personBranch.store.nodes.Person.create({ name: "P" }, { id: "x" });

    const original = target.transaction.bind(target);
    let injected = false;
    (target as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        await target.nodes.Robot.create({ name: "Window" }, { id: "y" });
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [personBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
    expect(await target.nodes.Person.getById("x" as never)).toBeUndefined();

    // A rerun sees the new state at PLAN time and refuses typed.
    const rerun = await mergeIncremental({
      forkPoint,
      target,
      branches: [personBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    expect(isErr(rerun)).toBe(true);
    if (isOk(rerun)) throw new Error("Expected identity merge conflict");
    expect(rerun.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("refuses class-transitive drift from a window ASSERTION", async () => {
    // Robot:y already exists; the window does not insert any node — it
    // ASSERTS same(Anchor:x, Anchor:y), joining the plan's fold class with
    // Robot:y purely through the ledger.
    const [forkPoint] = await createStoreWithSchema(
      anchoredFoldGraph,
      await makeBackend(),
    );
    const [target] = await createStoreWithSchema(
      anchoredFoldGraph,
      await makeBackend(),
    );
    const anchorX = await target.nodes.Anchor.create(
      { name: "X" },
      { id: "x" },
    );
    const anchorY = await target.nodes.Anchor.create(
      { name: "Y" },
      { id: "y" },
    );
    await target.nodes.Robot.create({ name: "R" }, { id: "y" });

    const personBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await personBranch.store.nodes.Person.create({ name: "P" }, { id: "x" });

    const original = target.transaction.bind(target);
    let injected = false;
    (target as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        await target.identity.assertSame(anchorX, anchorY);
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [personBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
    expect(await target.nodes.Person.getById("x" as never)).toBeUndefined();
  });

  it("refuses drift landing between planning and the class snapshot", async () => {
    // The guard's baseline is only sound if it is a VALIDATED state: a class
    // change between planMerge() and the snapshot must fail the post-plan
    // recheck as a typed conflict, never become the baseline. The injection
    // fires before the SECOND live-peer probe — the post-plan one.
    const [forkPoint] = await createStoreWithSchema(
      anchoredFoldGraph,
      await makeBackend(),
    );
    const anchorX = await forkPoint.nodes.Anchor.create(
      { name: "X" },
      { id: "x" },
    );
    const anchorY = await forkPoint.nodes.Anchor.create(
      { name: "Y" },
      { id: "y" },
    );
    await forkPoint.identity.assertSame(anchorX, anchorY);
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;

    const personBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await personBranch.store.nodes.Person.create({ name: "P" }, { id: "x" });

    const runtime = storeRuntime(target);
    const originalProbe = runtime.liveNodesSharingIds;
    let calls = 0;
    (runtime as { liveNodesSharingIds: unknown }).liveNodesSharingIds = async (
      ids: readonly string[],
      probeTarget?: unknown,
    ) => {
      calls += 1;
      if (calls === 2) {
        await target.nodes.Robot.create({ name: "Window" }, { id: "y" });
      }
      return (
        originalProbe as (
          i: readonly string[],
          t?: unknown,
        ) => Promise<readonly Readonly<{ kind: string; id: string }>[]>
      )(ids, probeTarget);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [personBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected identity merge conflict");
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    } finally {
      (runtime as { liveNodesSharingIds: unknown }).liveNodesSharingIds =
        originalProbe;
    }
    expect(await target.nodes.Person.getById("x" as never)).toBeUndefined();
  });

  it("refuses a planned assertion endpoint deleted in the commit window", async () => {
    // A live singleton and a missing one have identical self-coalesced
    // classes — only the liveness bit in the fingerprint distinguishes them.
    const [forkPoint] = await createStoreWithSchema(
      anchoredFoldGraph,
      await makeBackend(),
    );
    await forkPoint.nodes.Anchor.create({ name: "A" }, { id: "a" });
    await forkPoint.nodes.Anchor.create({ name: "B" }, { id: "b" });
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;

    const assertBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await assertBranch.store.identity.assertSame(
      { kind: "Anchor", id: "a" },
      { kind: "Anchor", id: "b" },
    );

    const original = target.transaction.bind(target);
    let injected = false;
    (target as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        await target.nodes.Anchor.delete("b" as never);
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [assertBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
  });

  it("encodes class fingerprints injectively", () => {
    // Comma-joining raw keys collides: [Anchor:a, B:"x,C\0y"] vs
    // [Anchor:a, B:x, C:y]. The structural encoding must not.
    const left = encodeClassFingerprint(true, [
      { kind: "Anchor", id: "a" },
      { kind: "B", id: "x,C\u0000y" },
    ]);
    const right = encodeClassFingerprint(true, [
      { kind: "Anchor", id: "a" },
      { kind: "B", id: "x" },
      { kind: "C", id: "y" },
    ]);
    expect(left).not.toBe(right);
    // Liveness participates: a vanished singleton is visible drift.
    expect(
      encodeClassFingerprint(true, [{ kind: "Anchor", id: "solo" }]),
    ).not.toBe(encodeClassFingerprint(false, [{ kind: "Anchor", id: "solo" }]));
  });

  it("tolerates a window peer at an id canonicalization dropped", async () => {
    // Person:a-keep and Person:z-drop reconcile into a-keep, so z-drop never
    // reaches the committed plan. A window Robot:z-drop is therefore an
    // unrelated target advance — refusing it would be a spurious replan.
    const [forkPoint] = await createStoreWithSchema(
      clusterFoldGraph,
      await makeBackend(),
    );
    const [target] = await createStoreWithSchema(
      clusterFoldGraph,
      await makeBackend(),
    );
    const keepBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const dropBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
    );
    await keepBranch.store.nodes.Person.create(
      { name: "Ana Rivera", birthDate: "1974-03-09" },
      { id: "a-keep" },
    );
    await dropBranch.store.nodes.Person.create(
      { name: "Ana  Rivera", birthDate: "1974-03-09" },
      { id: "z-drop" },
    );

    const original = target.transaction.bind(target);
    let injected = false;
    (target as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        await target.nodes.Robot.create({ name: "Window" }, { id: "z-drop" });
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [keepBranch, dropBranch],
        options: {
          resolve: {
            Person: {
              block: (node) =>
                (node as unknown as { birthDate?: string }).birthDate,
              similarity: { kind: "fulltext", fields: ["name"] },
              threshold: 0.85,
            },
          },
          branchOrder: [BRANCH_A, BRANCH_B],
        },
      });
      expect(isOk(result)).toBe(true);
      if (isErr(result)) throw new Error(result.error.message);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
    expect(await target.nodes.Person.getById("a-keep" as never)).toBeDefined();
    expect(
      await target.nodes.Person.getById("z-drop" as never),
    ).toBeUndefined();
    expect(await target.nodes.Robot.getById("z-drop" as never)).toBeDefined();
  });

  it("refuses a same-id disjoint peer landing in the plan→commit window", async () => {
    const [forkPoint] = await createStoreWithSchema(
      disjointFoldGraph,
      await makeBackend(),
    );
    const [target] = await createStoreWithSchema(
      disjointFoldGraph,
      await makeBackend(),
    );
    const personBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await personBranch.store.nodes.Person.create(
      { name: "Clash" },
      { id: "shared" },
    );

    // Deterministic window write: the first commit-transaction call first
    // lands the disjoint peer, then delegates — exactly what a concurrent
    // writer in the plan→commit window would do.
    const original = target.transaction.bind(target);
    let injected = false;
    (target as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        await target.nodes.Robot.create({ name: "Window" }, { id: "shared" });
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [personBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
    // The window write survives; the stale plan committed nothing.
    expect(await target.nodes.Robot.getById("shared" as never)).toBeDefined();
    expect(
      await target.nodes.Person.getById("shared" as never),
    ).toBeUndefined();
  });
});
