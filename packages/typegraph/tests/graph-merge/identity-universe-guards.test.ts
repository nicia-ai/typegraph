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
  merge,
  mergeAgainstBase,
  mergeIncremental,
} from "../../src/graph-merge/merge";
import {
  DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
  encodeClassFingerprint,
  RETRACTION_DELETION_OVERRULED_DROP_REASON,
  RETRACTION_TARGET_MISMATCH_DROP_REASON,
} from "../../src/graph-merge/merge-identity";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { asIdentityAssertionId } from "../../src/identity/types";
import { importGraph } from "../../src/interchange";
import { sql } from "../../src/query/sql-fragment";
import { asCompiledStatementSql } from "../../src/query/sql-intent";
import { getCommittedSchemaVersion, migrateSchema } from "../../src/schema";
import { storeRuntime } from "../../src/store/runtime-port";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix, identityAssertionDocument } from "./test-utils";

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

/** The same anchored shape under the assertion-only profile. */
const anchoredIgnoreGraph = defineGraph({
  id: "identity_universe_ignore",
  nodes: {
    Person: { type: Person },
    Robot: { type: Robot },
    Anchor: { type: Anchor },
  },
  edges: {},
  ontology: [disjointWith(Person, Robot)],
  identity: { sameIdAcrossKinds: "ignore" },
});

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");
const BRANCH_C = asBranchId("branch-c");

describe.each(backendMatrix())("identity universe guards [$name]", (entry) => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    // Every fixture is released even when one disposer rejects — stopping at
    // the first failure would leak the remaining backends (and, on the shared
    // Postgres lane, their connections) for the rest of the worker process.
    // Reverse order so a fixture is torn down before whatever it was built on.
    const outcomes = await Promise.allSettled(
      cleanups.toReversed().map((cleanup) => cleanup()),
    );
    const rejection = outcomes.find(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    if (rejection !== undefined) {
      throw rejection.reason instanceof Error ?
          rejection.reason
        : new Error(String(rejection.reason));
    }
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

  it("refuses a window `different` landing before the baseline", async () => {
    // Negative truth is invisible to peers, liveness, and class structure:
    // the recheck must consume the FRESH target ledger, so a different(a, b)
    // committed between planning and the baseline fails typed.
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

    const sameBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await sameBranch.store.identity.assertSame(
      { kind: "Anchor", id: "a" },
      { kind: "Anchor", id: "b" },
    );

    const runtime = storeRuntime(target);
    const originalProbe = runtime.liveNodesSharingIds;
    let calls = 0;
    (runtime as { liveNodesSharingIds: unknown }).liveNodesSharingIds = async (
      ids: readonly string[],
      probeTarget?: unknown,
    ) => {
      calls += 1;
      if (calls === 2) {
        await target.identity.assertDifferent(
          { kind: "Anchor", id: "a" },
          { kind: "Anchor", id: "b" },
        );
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
        branches: [sameBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected identity merge conflict");
      expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    } finally {
      (runtime as { liveNodesSharingIds: unknown }).liveNodesSharingIds =
        originalProbe;
    }
    expect(
      await target.identity.areSame(
        { kind: "Anchor", id: "a" },
        { kind: "Anchor", id: "b" },
      ),
    ).toBe(false);
  });

  it("refuses a window `different` landing between baseline and transaction", async () => {
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

    const sameBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await sameBranch.store.identity.assertSame(
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
        await target.identity.assertDifferent(
          { kind: "Anchor", id: "a" },
          { kind: "Anchor", id: "b" },
        );
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [sameBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
    expect(
      await target.identity.areSame(
        { kind: "Anchor", id: "a" },
        { kind: "Anchor", id: "b" },
      ),
    ).toBe(false);
  });

  it("guards negative truth under the ignore profile too", async () => {
    // Explicit assertions exist under both profiles, so the negative-ledger
    // guard must not be fold-gated: a window different(a, b) against a
    // planned same(a, b) refuses typed on an "ignore" graph as well.
    const [forkPoint] = await createStoreWithSchema(
      anchoredIgnoreGraph,
      await makeBackend(),
    );
    await forkPoint.nodes.Anchor.create({ name: "A" }, { id: "a" });
    await forkPoint.nodes.Anchor.create({ name: "B" }, { id: "b" });
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;

    const sameBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await sameBranch.store.identity.assertSame(
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
        await target.identity.assertDifferent(
          { kind: "Anchor", id: "a" },
          { kind: "Anchor", id: "b" },
        );
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [sameBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
    expect(
      await target.identity.areSame(
        { kind: "Anchor", id: "a" },
        { kind: "Anchor", id: "b" },
      ),
    ).toBe(false);

    // A rerun sees the different at PLAN time and refuses typed there.
    const rerun = await mergeIncremental({
      forkPoint,
      target,
      branches: [sameBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    expect(isErr(rerun)).toBe(true);
    if (isOk(rerun)) throw new Error("Expected identity merge conflict");
    expect(rerun.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("tolerates a benign window same-id node under the ignore profile", async () => {
    // Under "ignore" a same-id row never folds, so a window Anchor (not
    // disjoint with Person) at a planned Person id is an unrelated target
    // advance the guard must not refuse.
    const [forkPoint] = await createStoreWithSchema(
      anchoredIgnoreGraph,
      await makeBackend(),
    );
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    const personBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await personBranch.store.nodes.Person.create(
      { name: "P" },
      { id: "shared" },
    );

    const original = target.transaction.bind(target);
    let injected = false;
    (target as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        await target.nodes.Anchor.create({ name: "Window" }, { id: "shared" });
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
      if (isErr(result)) throw result.error;
      expect(isOk(result)).toBe(true);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
    expect(await target.nodes.Person.getById("shared" as never)).toBeDefined();
    expect(await target.nodes.Anchor.getById("shared" as never)).toBeDefined();
  });

  it("refuses a DISJOINT window same-id node under the ignore profile", async () => {
    // Disjoint id-sharing is a create-time constraint under both profiles:
    // a window Robot at a planned Person id changes plan legality even
    // though nothing folds.
    const [forkPoint] = await createStoreWithSchema(
      anchoredIgnoreGraph,
      await makeBackend(),
    );
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    const personBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await personBranch.store.nodes.Person.create(
      { name: "P" },
      { id: "shared" },
    );

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
    expect(
      await target.nodes.Person.getById("shared" as never),
    ).toBeUndefined();
  });

  it("refuses a pre-existing disjoint same-id peer at plan time under ignore", async () => {
    // The create-time disjoint-id constraint is profile-independent, so the
    // plan-time simulation must model it even when nothing folds.
    const [forkPoint] = await createStoreWithSchema(
      anchoredIgnoreGraph,
      await makeBackend(),
    );
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    await target.nodes.Robot.create({ name: "R" }, { id: "shared" });
    const personBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await personBranch.store.nodes.Person.create(
      { name: "P" },
      { id: "shared" },
    );

    const result = await mergeIncremental({
      forkPoint,
      target,
      branches: [personBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    expect(
      await target.nodes.Person.getById("shared" as never),
    ).toBeUndefined();
  });

  it.each([
    ["ignore", anchoredIgnoreGraph],
    ["fold", anchoredFoldGraph],
  ] as const)(
    "allows replacing a disjoint same-id node under %s",
    async (_profile, graphDef) => {
      // A branch deleting Robot:shared and creating disjoint Person:shared
      // is legal — the committed state holds only Person. Planned deletions
      // must be excluded from the guard baseline, or the stale Robot rejects
      // the replacement the commit itself would accept.
      const [forkPoint] = await createStoreWithSchema(
        graphDef,
        await makeBackend(),
      );
      await forkPoint.nodes.Robot.create({ name: "Old" }, { id: "shared" });
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), {
          id: asBranchId("target-clone"),
        }),
      ).store;
      const replaceBranch = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
      );
      await replaceBranch.store.nodes.Robot.delete("shared" as never);
      await replaceBranch.store.nodes.Person.create(
        { name: "New" },
        { id: "shared" },
      );

      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [replaceBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      if (isErr(result)) throw result.error;
      expect(isOk(result)).toBe(true);
      expect(
        await target.nodes.Person.getById("shared" as never),
      ).toBeDefined();
      expect(
        await target.nodes.Robot.getById("shared" as never),
      ).toBeUndefined();
    },
  );

  it("allows deleting an identity bridge and asserting its ends different", async () => {
    // Deleting the bridge ends both touching assertions and SPLITS the class
    // {a, bridge, b}. Modeling the post-deletion class by filtering the old
    // member list would leave [a, b] pre-linked and falsely reject the
    // different(a, b) the branch legally asserted after the deletion.
    const [forkPoint] = await createStoreWithSchema(
      anchoredIgnoreGraph,
      await makeBackend(),
    );
    const a = await forkPoint.nodes.Anchor.create({ name: "A" }, { id: "a" });
    const bridge = await forkPoint.nodes.Anchor.create(
      { name: "Bridge" },
      { id: "bridge" },
    );
    const b = await forkPoint.nodes.Anchor.create({ name: "B" }, { id: "b" });
    await forkPoint.identity.assertSame(a, bridge);
    await forkPoint.identity.assertSame(bridge, b);
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;

    const splitBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await splitBranch.store.nodes.Anchor.delete("bridge" as never);
    await splitBranch.store.identity.assertDifferent(
      { kind: "Anchor", id: "a" },
      { kind: "Anchor", id: "b" },
    );

    const result = await mergeIncremental({
      forkPoint,
      target,
      branches: [splitBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    if (isErr(result)) throw result.error;
    expect(isOk(result)).toBe(true);
    expect(
      await target.nodes.Anchor.getById("bridge" as never),
    ).toBeUndefined();
    expect(
      await target.identity.areDifferent(
        { kind: "Anchor", id: "a" },
        { kind: "Anchor", id: "b" },
      ),
    ).toBe(true);
  });

  it.each([
    ["deleting the bridge node", "delete" as const],
    ["retracting the bridge assertions", "retract" as const],
  ])(
    "refuses a surviving window same-assertion decisive after %s",
    async (_label, mode) => {
      // A window same(a, b) added while a and b are already transitively
      // connected changes NO fingerprint — the class members are identical
      // and the different-slice is empty. It becomes the decisive surviving
      // link once the plan removes the bridge and asserts a, b different;
      // only re-running the simulation on transaction reads can see it.
      const [forkPoint] = await createStoreWithSchema(
        anchoredIgnoreGraph,
        await makeBackend(),
      );
      const a = await forkPoint.nodes.Anchor.create({ name: "A" }, { id: "a" });
      const bridge = await forkPoint.nodes.Anchor.create(
        { name: "Bridge" },
        { id: "bridge" },
      );
      const b = await forkPoint.nodes.Anchor.create({ name: "B" }, { id: "b" });
      const first = await forkPoint.identity.assertSame(a, bridge);
      const second = await forkPoint.identity.assertSame(bridge, b);
      const target = unwrap(
        await branch(forkPoint, () => makeBackend(), {
          id: asBranchId("target-clone"),
        }),
      ).store;

      const splitBranch = unwrap(
        await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
      );
      if (mode === "delete") {
        await splitBranch.store.nodes.Anchor.delete("bridge" as never);
      } else {
        await splitBranch.store.identity.retractAssertion(first.assertion.id);
        await splitBranch.store.identity.retractAssertion(second.assertion.id);
      }
      await splitBranch.store.identity.assertDifferent(
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
          await target.identity.assertSame(
            { kind: "Anchor", id: "a" },
            { kind: "Anchor", id: "b" },
          );
        }
        return (original as (f: unknown, o: unknown) => unknown)(fn, options);
      };
      try {
        const result = await mergeIncremental({
          forkPoint,
          target,
          branches: [splitBranch],
          options: { branchOrder: [BRANCH_A] },
        });
        expect(isErr(result)).toBe(true);
        if (isOk(result)) throw new Error("Expected typed replan refusal");
        expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
      } finally {
        (target as { transaction: unknown }).transaction = original;
      }
      // A rerun sees the surviving same at PLAN time and refuses typed.
      const rerun = await mergeIncremental({
        forkPoint,
        target,
        branches: [splitBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(rerun)).toBe(true);
      if (isOk(rerun)) throw new Error("Expected identity merge conflict");
      expect(rerun.error).toBeInstanceOf(IdentityMergeConflictError);
    },
  );

  /** {@link identityAssertionDocument} for the Anchor kind this suite folds on. */
  function assertionDocument(
    id: string,
    a: string,
    b: string,
    validFrom?: string,
  ): Parameters<typeof importGraph>[1] {
    return identityAssertionDocument("Anchor", id, a, b, validFrom);
  }

  async function anchoredForkPoint() {
    const [forkPoint] = await createStoreWithSchema(
      anchoredIgnoreGraph,
      await makeBackend(),
    );
    for (const id of ["a", "b", "c", "d"]) {
      await forkPoint.nodes.Anchor.create({ name: id }, { id });
    }
    return forkPoint;
  }

  it("rejects one assertion id staged for two truths at plan time", async () => {
    const forkPoint = await anchoredForkPoint();
    const branchA = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
    );
    const first = await importGraph(
      branchA.store,
      assertionDocument("shared-id", "a", "b"),
      { onConflict: "skip" },
    );
    const second = await importGraph(
      branchB.store,
      assertionDocument("shared-id", "c", "d"),
      { onConflict: "skip" },
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const result = await merge(forkPoint, [branchA, branchB], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("rejects a staged id already identifying different target truth", async () => {
    const forkPoint = await anchoredForkPoint();
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    const imported = await importGraph(
      target,
      assertionDocument("shared-id", "c", "d"),
      { onConflict: "skip" },
    );
    expect(imported.success).toBe(true);
    const sameBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchImport = await importGraph(
      sameBranch.store,
      assertionDocument("shared-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(branchImport.success).toBe(true);

    const result = await mergeIncremental({
      forkPoint,
      target,
      branches: [sameBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("refuses a window assertion reusing a planned id outside the universe", async () => {
    const forkPoint = await anchoredForkPoint();
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    const sameBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchImport = await importGraph(
      sameBranch.store,
      assertionDocument("shared-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(branchImport.success).toBe(true);

    // The window row reuses the planned id with endpoints c, d — entirely
    // outside the plan's member universe, so no ledger-slice or class
    // fingerprint sees it; only the by-id revalidation can.
    const original = target.transaction.bind(target);
    let injected = false;
    (target as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        const windowImport = await importGraph(
          target,
          assertionDocument("shared-id", "c", "d"),
          { onConflict: "skip" },
        );
        if (!windowImport.success) throw new Error("window import failed");
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [sameBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
    // A rerun sees the stored row at PLAN time and refuses typed.
    const rerun = await mergeIncremental({
      forkPoint,
      target,
      branches: [sameBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    expect(isErr(rerun)).toBe(true);
    if (isOk(rerun)) throw new Error("Expected identity merge conflict");
    expect(rerun.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("keeps unrelated target truth when a retraction's id was reused", async () => {
    // The branch retracted x-shared=same(a,b); the INDEPENDENT target uses
    // x-shared for same(c,d). A retraction reduced to its bare id would end
    // the target's row — deleting truth the branch never saw — so the plan
    // validates the complete retracted row against the target and skips,
    // visibly, when the truths differ: the branch's intent ("MY assertion no
    // longer holds") is already satisfied by that assertion's absence.
    const forkPoint = await anchoredForkPoint();
    const forkImport = await importGraph(
      forkPoint,
      assertionDocument("x-shared", "a", "b"),
      { onConflict: "skip" },
    );
    expect(forkImport.success).toBe(true);
    const retractBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await retractBranch.store.identity.retractAssertion(
      asIdentityAssertionId("x-shared"),
    );

    const [target] = await createStoreWithSchema(
      anchoredIgnoreGraph,
      await makeBackend(),
    );
    for (const id of ["a", "b", "c", "d"]) {
      await target.nodes.Anchor.create({ name: id }, { id });
    }
    const targetImport = await importGraph(
      target,
      assertionDocument("x-shared", "c", "d"),
      { onConflict: "skip" },
    );
    expect(targetImport.success).toBe(true);

    const result = await mergeIncremental({
      forkPoint,
      target,
      branches: [retractBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    if (isErr(result)) throw result.error;
    expect(isOk(result)).toBe(true);
    expect(result.data.dropped).toContainEqual({
      kind: "identity",
      id: "x-shared",
      reason: RETRACTION_TARGET_MISMATCH_DROP_REASON,
    });
    const rows = await storeRuntime(target).identityAssertionRowsByIds([
      "x-shared",
    ]);
    expect(rows.get("x-shared")).toMatchObject({
      relation: "same",
      a: { kind: "Anchor", id: "c" },
      b: { kind: "Anchor", id: "d" },
    });
    expect(rows.get("x-shared")?.validTo).toBeUndefined();
  });

  it("refuses a window row claiming a planned id in snapshot mode", async () => {
    // Snapshot commits carry no identity peer probe — only the shared by-id
    // freshness guard runs inside commitPlan's transaction. The window row
    // claims the planned id and is immediately retracted, so the CURRENT
    // ledger (all the legacy base@V token fingerprints) looks unchanged;
    // only the ended-rows-included by-id check can see it.
    const forkPoint = await anchoredForkPoint();
    const assertBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchImport = await importGraph(
      assertBranch.store,
      assertionDocument("win-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(branchImport.success).toBe(true);

    const original = forkPoint.transaction.bind(forkPoint);
    let injected = false;
    (forkPoint as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        const windowImport = await importGraph(
          forkPoint,
          assertionDocument("win-id", "c", "d"),
          { onConflict: "skip" },
        );
        if (!windowImport.success) throw new Error("window import failed");
        await forkPoint.identity.retractAssertion(
          asIdentityAssertionId("win-id"),
        );
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await merge(forkPoint, [assertBranch], {});
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (forkPoint as { transaction: unknown }).transaction = original;
    }
    // A rerun sees the ended row at PLAN time and refuses typed.
    const rerun = await merge(forkPoint, [assertBranch], {});
    expect(isErr(rerun)).toBe(true);
    if (isOk(rerun)) throw new Error("Expected identity merge conflict");
    expect(rerun.error).toBeInstanceOf(IdentityMergeConflictError);
  });

  it("refuses in-transaction drift of a planned retraction's target row", async () => {
    // Assertion rows are immutable through every TypeGraph API, so this
    // simulates an out-of-band writer (raw SQL) swapping the truth behind a
    // planned retraction id in the plan→commit window: the commit must
    // refuse to end a row the plan never validated.
    const forkPoint = await anchoredForkPoint();
    const forkImport = await importGraph(
      forkPoint,
      assertionDocument("drift-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(forkImport.success).toBe(true);
    const targetBackend = await makeBackend();
    const target = unwrap(
      await branch(forkPoint, () => Promise.resolve(targetBackend), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    const retractBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await retractBranch.store.identity.retractAssertion(
      asIdentityAssertionId("drift-id"),
    );
    const executeStatement = targetBackend.executeStatement;
    if (executeStatement === undefined) {
      throw new Error("matrix backend must support statement execution");
    }

    const original = target.transaction.bind(target);
    let injected = false;
    (target as { transaction: unknown }).transaction = async (
      fn: unknown,
      options: unknown,
    ) => {
      if (!injected) {
        injected = true;
        await executeStatement(
          asCompiledStatementSql(
            sql`UPDATE typegraph_identity_assertions SET a_id = ${"c"}, b_id = ${"d"} WHERE id = ${"drift-id"}`,
          ),
        );
      }
      return (original as (f: unknown, o: unknown) => unknown)(fn, options);
    };
    try {
      const result = await mergeIncremental({
        forkPoint,
        target,
        branches: [retractBranch],
        options: { branchOrder: [BRANCH_A] },
      });
      expect(isErr(result)).toBe(true);
      if (isOk(result)) throw new Error("Expected typed replan refusal");
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    } finally {
      (target as { transaction: unknown }).transaction = original;
    }
  });

  it("keeps identity truth when a modification overrules a deletion", async () => {
    // Branch A deletes node b — the soft-delete CASCADES, ending same(a, b)
    // on the branch and staging that ending as a retraction indistinguishable
    // from intent. Branch B modifies b. Under the default "flag" policy the
    // modification wins and b survives; the cascaded retraction must not
    // outlive the overruled deletion and end the resurrected node's
    // assertion on the target.
    const forkPoint = await anchoredForkPoint();
    const forkImport = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(forkImport.success).toBe(true);
    const deleteBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await deleteBranch.store.nodes.Anchor.delete("b" as never);
    const modifyBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
    );
    await modifyBranch.store.nodes.Anchor.update("b" as never, {
      name: "b-modified",
    });

    const result = await merge(forkPoint, [deleteBranch, modifyBranch], {
      branchOrder: [BRANCH_A, BRANCH_B],
    });
    if (isErr(result)) throw result.error;
    expect(isOk(result)).toBe(true);
    expect(result.data.deleteModifyConflicts.length).toBeGreaterThan(0);
    expect(result.data.dropped).toContainEqual({
      kind: "identity",
      id: "cascade-id",
      reason: RETRACTION_DELETION_OVERRULED_DROP_REASON,
    });
    // The node survived WITH its identity truth.
    expect(await forkPoint.nodes.Anchor.getById("b" as never)).toMatchObject({
      name: "b-modified",
    });
    const rows = await storeRuntime(forkPoint).identityAssertionRowsByIds([
      "cascade-id",
    ]);
    expect(rows.get("cascade-id")?.validTo).toBeUndefined();
    expect(rows.get("cascade-id")).toMatchObject({
      a: { kind: "Anchor", id: "a" },
      b: { kind: "Anchor", id: "b" },
    });
  });

  it("prefers the target's committed row over a branch-minted duplicate id", async () => {
    // The ADVANCED target committed the pair under shared-x2; the branch
    // minted shared-x1 for the same pair. The applier is idempotent per
    // semantic pair, so shared-x1 can never actually be written — the
    // survivor pick must keep the committed id and drop the challenger,
    // or the report claims an id as applied that never lands while listing
    // the target's own committed row as dropped.
    const forkPoint = await anchoredForkPoint();
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    const targetImport = await importGraph(
      target,
      assertionDocument("shared-x2", "b", "c"),
      { onConflict: "skip" },
    );
    expect(targetImport.success).toBe(true);
    const mintBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchImport = await importGraph(
      mintBranch.store,
      assertionDocument("shared-x1", "b", "c"),
      { onConflict: "skip" },
    );
    expect(branchImport.success).toBe(true);

    const result = await mergeIncremental({
      forkPoint,
      target,
      branches: [mintBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    if (isErr(result)) throw result.error;
    expect(isOk(result)).toBe(true);
    const rows = await storeRuntime(target).identityAssertionRowsByIds([
      "shared-x1",
      "shared-x2",
    ]);
    expect(rows.get("shared-x2")?.validTo).toBeUndefined();
    expect(rows.get("shared-x1")).toBeUndefined();
    expect(result.data.dropped).toContainEqual({
      kind: "identity",
      id: "shared-x1",
      reason: DUPLICATE_IDENTITY_ASSERTION_DROP_REASON,
    });
    expect(result.data.dropped.some((item) => item.id === "shared-x2")).toBe(
      false,
    );
  });

  it("keeps an explicit retraction when a third branch overrules the deletion", async () => {
    // Branch A retracts cascade-id EXPLICITLY (no deletion). Branch B deletes
    // endpoint b (its diff stages the same retraction as a cascade). Branch C
    // modifies b, overruling B's deletion under the default "flag" policy.
    // Provenance must keep A's independent intent: only retractions whose
    // EVERY contributor is explained by an overruled deletion are dropped.
    const forkPoint = await anchoredForkPoint();
    const forkImport = await importGraph(
      forkPoint,
      assertionDocument("cascade-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(forkImport.success).toBe(true);
    const retractBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await retractBranch.store.identity.retractAssertion(
      asIdentityAssertionId("cascade-id"),
    );
    const deleteBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
    );
    await deleteBranch.store.nodes.Anchor.delete("b" as never);
    const modifyBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_C }),
    );
    await modifyBranch.store.nodes.Anchor.update("b" as never, {
      name: "b-modified",
    });

    const result = await merge(
      forkPoint,
      [retractBranch, deleteBranch, modifyBranch],
      { branchOrder: [BRANCH_A, BRANCH_B, BRANCH_C] },
    );
    expect(isOk(result)).toBe(true);
    if (isErr(result)) throw result.error;
    // The node survives the overruled deletion — but branch A's explicit
    // retraction survives with it: the assertion is ENDED, not preserved.
    expect(await forkPoint.nodes.Anchor.getById("b" as never)).toMatchObject({
      name: "b-modified",
    });
    const rows = await storeRuntime(forkPoint).identityAssertionRowsByIds([
      "cascade-id",
    ]);
    expect(rows.get("cascade-id")?.validTo).toBeDefined();
    expect(result.data.dropped.some((item) => item.id === "cascade-id")).toBe(
      false,
    );
  });

  it("refuses a branch whose store ran a schema operation after forking", async () => {
    // removeKinds on the branch's backend commits a new schema version and
    // cascades rows through its own preflights; projecting those side
    // effects into a merge as bare data changes would detach them from the
    // schema change that caused them. The merge must refuse typed instead.
    const forkPoint = await anchoredForkPoint();
    const branchBackend = await makeBackend();
    const driftBranch = unwrap(
      await branch(forkPoint, () => Promise.resolve(branchBackend), {
        id: BRANCH_A,
      }),
    );
    await driftBranch.store.identity.assertSame(
      { kind: "Anchor", id: "a" },
      { kind: "Anchor", id: "b" },
    );
    // A profile flip is a breaking schema change — exactly the migrateSchema
    // surgery a branch backend must not smuggle into a data merge.
    const driftedGraph = defineGraph({
      id: "identity_universe_ignore",
      nodes: {
        Person: { type: Person },
        Robot: { type: Robot },
        Anchor: { type: Anchor },
      },
      edges: {},
      ontology: [disjointWith(Person, Robot)],
      identity: { sameIdAcrossKinds: "fold" },
    });
    await migrateSchema(
      branchBackend,
      driftedGraph,
      requireDefined(
        await getCommittedSchemaVersion(branchBackend, driftedGraph.id),
      ),
    );

    const result = await merge(forkPoint, [driftBranch], {
      branchOrder: [BRANCH_A],
    });
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected schema-drift refusal");
    expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    expect(result.error.message).toContain("schema");
  });

  it("preserves a branch-authored validity window through the merge", async () => {
    // The branch recreates a tombstoned Person:x with an already-ENDED
    // valid-time window. The commit's resurrection upsert must carry that
    // window instead of resetting it to merge time — an ended member coming
    // back CURRENT would silently join Robot:x's live fold class.
    const [forkPoint] = await createStoreWithSchema(
      anchoredFoldGraph,
      await makeBackend(),
    );
    await forkPoint.nodes.Robot.create({ name: "robot" }, { id: "x" });
    await forkPoint.nodes.Anchor.create({ name: "anchor" }, { id: "x" });
    await forkPoint.nodes.Anchor.delete("x" as never);
    const windowBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await windowBranch.store.nodes.Anchor.create(
      { name: "anchor-historical" },
      {
        id: "x",
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2021-01-01T00:00:00.000Z",
      },
    );

    const result = await merge(forkPoint, [windowBranch], {
      branchOrder: [BRANCH_A],
    });
    expect(isOk(result)).toBe(true);
    if (isErr(result)) throw result.error;
    expect(await forkPoint.nodes.Anchor.getById("x" as never)).toBeUndefined();
    expect(
      await forkPoint.identity.membersOf({ kind: "Robot", id: "x" }),
    ).toEqual([{ kind: "Robot", id: "x" }]);
  });

  it("counts applied ledger effects, not planned intents", async () => {
    // The ADVANCED target's own addition is staged back at it and skipped by
    // the idempotent applier; the branch's identical import is an exact-match
    // skip. Only the branch's genuinely new assertion creates a row, and the
    // report must say so.
    const forkPoint = await anchoredForkPoint();
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    const targetImport = await importGraph(
      target,
      assertionDocument("shared-x2", "a", "b"),
      { onConflict: "skip" },
    );
    expect(targetImport.success).toBe(true);
    const countBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchImport = await importGraph(
      countBranch.store,
      assertionDocument("shared-x2", "a", "b"),
      { onConflict: "skip" },
    );
    expect(branchImport.success).toBe(true);
    await countBranch.store.identity.assertSame(
      { kind: "Anchor", id: "c" },
      { kind: "Anchor", id: "d" },
    );

    const result = await mergeIncremental({
      forkPoint,
      target,
      branches: [countBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    expect(isOk(result)).toBe(true);
    if (isErr(result)) throw result.error;
    expect(result.data.merged.identity).toEqual({ asserted: 1, retracted: 0 });
  });

  it("stages a same-id truth replacement instead of diffing it empty", async () => {
    // The one legal way two truths share an id inside ONE lineage: the branch
    // hard-deletes an endpoint (physically removing the assertion row),
    // recreates it, and imports the same id for different truth. A
    // presence-only identity diff sees the id on both sides and stages
    // NOTHING — the merge silently keeps the base truth while the branch
    // believes the replacement. The diff must compare complete truth and
    // surface the replacement so planning refuses unsupported id reuse typed.
    const forkPoint = await anchoredForkPoint();
    const forkImport = await importGraph(
      forkPoint,
      assertionDocument("swap-id", "a", "b"),
      { onConflict: "skip" },
    );
    expect(forkImport.success).toBe(true);
    const target = unwrap(
      await branch(forkPoint, () => makeBackend(), {
        id: asBranchId("target-clone"),
      }),
    ).store;
    const replaceBranch = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    await replaceBranch.store.nodes.Anchor.delete("a" as never);
    await replaceBranch.store.nodes.Anchor.hardDelete("a" as never);
    await replaceBranch.store.nodes.Anchor.create({ name: "a" }, { id: "a" });
    const reimport = await importGraph(
      replaceBranch.store,
      assertionDocument("swap-id", "c", "d"),
      { onConflict: "skip" },
    );
    expect(reimport.success).toBe(true);

    const result = await mergeIncremental({
      forkPoint,
      target,
      branches: [replaceBranch],
      options: { branchOrder: [BRANCH_A] },
    });
    // The replacement cannot be applied (the applier refuses reusing an ended
    // row's id), so the only sound outcome is a typed plan-time refusal — not
    // a silent success that keeps the base truth the branch replaced.
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
    // Plan-time refusal: the target's row is untouched.
    const rows = await storeRuntime(target).identityAssertionRowsByIds([
      "swap-id",
    ]);
    expect(rows.get("swap-id")).toMatchObject({
      a: { kind: "Anchor", id: "a" },
      b: { kind: "Anchor", id: "b" },
    });
    expect(rows.get("swap-id")?.validTo).toBeUndefined();
  });

  it("rejects one id staged for the same pair with two validities", async () => {
    // Same id, same semantic pair, different validFrom: the semantic survivor
    // dedupe would collapse the two into one — reporting the id as dropped
    // while also applying it — so the complete-truth id check runs on the RAW
    // staged assertions, before the survivor pass.
    const forkPoint = await anchoredForkPoint();
    const branchA = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_A }),
    );
    const branchB = unwrap(
      await branch(forkPoint, () => makeBackend(), { id: BRANCH_B }),
    );
    const first = await importGraph(
      branchA.store,
      assertionDocument("dup-id", "a", "b"),
      { onConflict: "skip" },
    );
    const second = await importGraph(
      branchB.store,
      assertionDocument("dup-id", "a", "b", "2024-02-01T00:00:00.000Z"),
      { onConflict: "skip" },
    );
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);

    const result = await merge(forkPoint, [branchA, branchB], {});
    expect(isErr(result)).toBe(true);
    if (isOk(result)) throw new Error("Expected identity merge conflict");
    expect(result.error).toBeInstanceOf(IdentityMergeConflictError);
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
      if (isErr(result)) throw result.error;
      expect(isOk(result)).toBe(true);
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
