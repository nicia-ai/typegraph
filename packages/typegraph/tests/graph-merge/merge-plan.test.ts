import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  asNodeId,
  asRecordedInstant,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import {
  BaseVersionMismatchError,
  InvalidMergePlanError,
  MergePlanCapabilityError,
  MergePlanDigestMismatchError,
  MergePlanningStaleError,
  MergePlanOwnerMismatchError,
  MergePlanSchemaMismatchError,
  MergePlanTargetMismatchError,
  StaleMergePlanError,
  UnsupportedMergePlanVersionError,
} from "../../src/graph-merge/errors";
import {
  applyMergePlan,
  planMerge,
  planMergeIncremental,
} from "../../src/graph-merge/merge";
import { canonicalMergePlanJson } from "../../src/graph-merge/plan-canonical";
import type { MergePlanArtifact } from "../../src/graph-merge/plan-schema";
import { constructMergePlanArtifact } from "../../src/graph-merge/plan-wire";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type { Embedder, GraphBranch } from "../../src/graph-merge/types";
import { asBaseVersion, asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix, createSqliteMergeBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), group: z.string() }),
});

it("produces identical portable plan content across every merge backend", async () => {
  const portablePlans: string[] = [];
  for (const entry of backendMatrix()) {
    const baseFixture = await entry.make();
    const branchFixture = await entry.make();
    try {
      const [base] = await createStoreWithSchema(graph, baseFixture.backend, {
        revisionTracking: true,
      });
      const source = unwrap(
        await branch(base, () => Promise.resolve(branchFixture.backend), {
          id: asBranchId("portable-source"),
        }),
      );
      await source.store.nodes.Person.create(
        { name: "Alice", group: "g" },
        { id: "portable-alice", validFrom: "2026-01-01T00:00:00.000Z" },
      );
      const artifact = unwrap(await planMerge(base, [source]));
      const portable = {
        mode: artifact.mode,
        proposed: artifact.proposed,
        writes: artifact.writes,
        guards: artifact.guards,
        review: artifact.review,
        provenance: artifact.provenance,
      };
      portablePlans.push(JSON.stringify(portable));
      expect(isOk(await applyMergePlan(base, artifact))).toBe(true);
    } finally {
      await branchFixture.cleanup();
      await baseFixture.cleanup();
    }
  }
  expect(new Set(portablePlans).size).toBe(1);
});

const graph = defineGraph({
  id: "merge-plan-lifecycle",
  nodes: { Person: { type: Person } },
  edges: {},
});

type TestGraph = typeof graph;

describe("public merge plan lifecycle", () => {
  let cleanups: (() => Promise<void>)[];

  beforeEach(() => {
    cleanups = [];
  });

  afterEach(async () => {
    for (const cleanup of cleanups.reverse()) await cleanup();
  });

  function makeBackend(): GraphBackend {
    const fixture = createSqliteMergeBackend();
    cleanups.push(fixture.cleanup);
    return fixture.backend;
  }

  async function makeBase(graphId = graph.id): Promise<Store<TestGraph>> {
    const selectedGraph =
      graphId === graph.id ? graph : { ...graph, id: graphId };
    const [store] = await createStoreWithSchema(selectedGraph, makeBackend(), {
      revisionTracking: true,
    });
    return store;
  }

  async function makeHistoryBase(): Promise<Store<TestGraph>> {
    const [store] = await createStoreWithSchema(graph, makeBackend(), {
      history: true,
    });
    return store;
  }

  it("binds empty-graph plan fences to the complete allocation owner", async () => {
    const target = await makeBase();
    const owner = await target.allocationOwner();
    const source = await makeBranch(target, "empty-owner");
    const artifact = unwrap(await planMerge(target, [source]));
    expect(artifact.target.revision.owner).toEqual(owner);
    expect(artifact.target.revision.revision).toBeNull();
    await target.rotateAllocationOwner(owner);
    const result = await applyMergePlan(target, artifact);
    expect(isErr(result)).toBe(true);
    if (!isErr(result)) throw new Error("Expected retired-fence refusal.");
    expect(result.error).toMatchObject({
      code: "GRAPH_ALLOCATION_OWNER_MISMATCH",
    });
    expect(await target.nodes.Person.count()).toBe(0);
  });

  it("refuses unbound and foreign-namespace recorded fork points even for an empty branch", async () => {
    const target = await makeHistoryBase();
    await target.nodes.Person.create({ name: "root", group: "g" });
    const source = await makeBranch(target, "empty-source");
    const recorded = requireDefined(await target.recordedNow());
    const foreign = asRecordedInstant(
      recorded.replace(/^r2:([^:]+):[^:]+:/u, `r2:$1:${"f".repeat(32)}:`),
    );
    const legacy = asRecordedInstant(
      recorded.replace(/^r2:[^:]+:[^:]+:/u, "r1:"),
    );
    for (const cut of [foreign, legacy]) {
      const base = asBaseVersion(source.base.replace(recorded, cut));
      expect(base).not.toBe(source.base);
      const result = await planMergeIncremental({
        target,
        forkPoint: { recorded: cut, base },
        branches: [{ ...source, base }],
      });
      expect(isErr(result)).toBe(true);
      if (!isErr(result)) throw new Error("Expected ownership refusal.");
      expect(result.error).toMatchObject(
        cut === foreign ?
          { code: "GRAPH_ALLOCATION_OWNER_MISMATCH" }
        : { details: { code: "RECORDED_ANCHOR_UNBOUND" } },
      );
    }
  });

  async function rehashTarget(
    artifact: MergePlanArtifact,
    target: unknown,
  ): Promise<MergePlanArtifact> {
    const { digest: _digest, ...input } = artifact;
    return constructMergePlanArtifact({ ...input, target });
  }

  async function makeBranch(
    base: Store<TestGraph>,
    id: string,
  ): Promise<GraphBranch<TestGraph>> {
    return unwrap(
      await branch(base, () => Promise.resolve(makeBackend()), {
        id: asBranchId(id),
      }),
    );
  }

  it("round-trips, applies reviewed evidence, runs no planning callback, and is single-use", async () => {
    const base = await makeBase();
    const left = await makeBranch(base, "left");
    const right = await makeBranch(base, "right");
    await left.store.nodes.Person.create(
      { name: "Alice", group: "same" },
      { id: "alice-a" },
    );
    await right.store.nodes.Person.create(
      { name: "Alice", group: "same" },
      { id: "alice-b" },
    );
    const block = vi.fn(() => "same");
    const planned = await planMerge(base, [right, left], {
      resolve: {
        Person: {
          block,
          similarity: { kind: "fulltext", fields: ["name"] },
          threshold: 1,
        },
      },
      candidateDiagnostics: { limit: 4 },
    });
    expect(isOk(planned)).toBe(true);
    const artifact = unwrap(planned);
    expect(
      await base.nodes.Person.getById(asNodeId("alice-a")),
    ).toBeUndefined();
    expect(artifact.proposed.nodes.upserts).toBe(1);
    expect(artifact.review.resolutions[0]?.decisiveEdges).toHaveLength(1);
    expect(artifact.review.resolutions[0]?.decisiveEdges[0]).toMatchObject({
      decision: "scored",
      score: 1,
      threshold: 1,
    });
    expect(
      JSON.stringify(artifact.review.resolutions[0]?.decisiveEdges),
    ).not.toMatch(/Alice|same/);
    const callbackCalls = block.mock.calls.length;

    const parsed = JSON.parse(JSON.stringify(artifact)) as typeof artifact;
    const applied = await applyMergePlan(base, parsed);
    expect(isOk(applied)).toBe(true);
    expect(block).toHaveBeenCalledTimes(callbackCalls);
    expect(unwrap(applied).resolutions).toEqual(artifact.review.resolutions);
    expect(unwrap(applied).candidateDiagnostics?.truncated).toBe(false);

    const reapplied = await applyMergePlan(base, artifact);
    expect(isErr(reapplied)).toBe(true);
    if (isErr(reapplied))
      expect(reapplied.error).toBeInstanceOf(StaleMergePlanError);
  });

  it("refuses tampered, malformed, unsupported, wrong-graph, and stale plans before writes", async () => {
    const base = await makeBase();
    const fork = await makeBranch(base, "source");
    await fork.store.nodes.Person.create(
      { name: "Alice", group: "g" },
      { id: "alice" },
    );
    const artifact = unwrap(await planMerge(base, [fork]));

    const firstUpsert = requireDefined(artifact.writes.nodeUpserts[0]);
    const tampered = {
      ...artifact,
      writes: {
        ...artifact.writes,
        nodeUpserts: [
          {
            ...firstUpsert,
            setProps: { ...firstUpsert.setProps, name: "Mallory" },
          },
          ...artifact.writes.nodeUpserts.slice(1),
        ],
      },
    };
    const tamperedResult = await applyMergePlan(base, tampered);
    expect(isErr(tamperedResult)).toBe(true);
    if (isErr(tamperedResult)) {
      expect(tamperedResult.error).toBeInstanceOf(MergePlanDigestMismatchError);
    }

    const malformed = await applyMergePlan(base, {
      formatVersion: 1,
    } as unknown as typeof artifact);
    expect(isErr(malformed)).toBe(true);
    if (isErr(malformed))
      expect(malformed.error).toBeInstanceOf(InvalidMergePlanError);

    const unsupported = await applyMergePlan(base, {
      formatVersion: 99,
    } as unknown as typeof artifact);
    expect(isErr(unsupported)).toBe(true);
    if (isErr(unsupported)) {
      expect(unsupported.error).toBeInstanceOf(
        UnsupportedMergePlanVersionError,
      );
    }

    const other = await makeBase("other-merge-plan-target");
    const wrongGraph = await applyMergePlan(other, artifact);
    expect(isErr(wrongGraph)).toBe(true);
    if (isErr(wrongGraph)) {
      expect(wrongGraph.error).toBeInstanceOf(MergePlanTargetMismatchError);
    }

    const wrongSchemaArtifact = await rehashTarget(artifact, {
      ...artifact.target,
      schema: { ...artifact.target.schema, hash: "different-schema" },
    });
    const wrongSchema = await applyMergePlan(base, wrongSchemaArtifact);
    expect(isErr(wrongSchema)).toBe(true);
    if (isErr(wrongSchema)) {
      expect(wrongSchema.error).toBeInstanceOf(MergePlanSchemaMismatchError);
    }

    const wrongOriginArtifact = await rehashTarget(artifact, {
      ...artifact.target,
      revision: { ...artifact.target.revision, origin: "different-origin" },
    });
    const wrongOrigin = await applyMergePlan(base, wrongOriginArtifact);
    expect(isErr(wrongOrigin)).toBe(true);
    if (isErr(wrongOrigin)) {
      expect(wrongOrigin.error).toBeInstanceOf(MergePlanOwnerMismatchError);
    }

    await base.nodes.Person.create(
      { name: "Concurrent", group: "g" },
      { id: "concurrent" },
    );
    const stale = await applyMergePlan(base, artifact);
    expect(isErr(stale)).toBe(true);
    if (isErr(stale)) expect(stale.error).toBeInstanceOf(StaleMergePlanError);
    expect(await base.nodes.Person.getById(asNodeId("alice"))).toBeUndefined();
  });

  it("allows only one of two concurrent apply attempts to commit", async () => {
    const base = await makeBase();
    const fork = await makeBranch(base, "source");
    await fork.store.nodes.Person.create(
      { name: "Alice", group: "g" },
      { id: "alice" },
    );
    const artifact = unwrap(await planMerge(base, [fork]));
    const results = await Promise.all([
      applyMergePlan(base, artifact),
      applyMergePlan(base, artifact),
    ]);
    expect(results.filter((result) => isOk(result))).toHaveLength(1);
    expect(results.filter((result) => isErr(result))).toHaveLength(1);
  });

  it("consumes an empty history-backed plan exactly once", async () => {
    const base = await makeHistoryBase();
    const artifact = unwrap(await planMerge(base, []));
    expect(artifact.proposed).toMatchObject({
      nodes: { upserts: 0, deletions: 0 },
      edges: { upserts: 0, deletions: 0 },
    });

    expect(isOk(await applyMergePlan(base, artifact))).toBe(true);
    const second = await applyMergePlan(base, artifact);
    expect(isErr(second)).toBe(true);
    if (isErr(second)) expect(second.error).toBeInstanceOf(StaleMergePlanError);
  });

  it("requires durable revision tracking for public planning", async () => {
    const [untracked] = await createStoreWithSchema(graph, makeBackend());
    const result = await planMerge(untracked, []);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(MergePlanCapabilityError);
    }
  });

  it("plans and applies the incremental lifecycle", async () => {
    const forkPoint = await makeBase();
    const source = await makeBranch(forkPoint, "incremental-source");
    await source.store.nodes.Person.create(
      { name: "Alice", group: "g" },
      { id: "incremental-alice" },
    );
    const target = await makeBase();

    const planned = await planMergeIncremental({
      forkPoint,
      target,
      branches: [source],
    });
    expect(isOk(planned)).toBe(true);
    const artifact = unwrap(planned);
    expect(artifact.mode).toBe("incremental");
    expect(artifact.anchors.kind).toBe("incremental");
    expect(isOk(await applyMergePlan(target, artifact))).toBe(true);
    expect(
      await target.nodes.Person.getById(asNodeId("incremental-alice")),
    ).toBeDefined();
  });

  it("preserves the incremental tombstone-resurrection guard", async () => {
    const forkPoint = await makeBase();
    const source = await makeBranch(forkPoint, "incremental-tombstone-source");
    await source.store.nodes.Person.create(
      { name: "Branch Alice", group: "g" },
      { id: "reused-id" },
    );
    const target = await makeBase();
    await target.nodes.Person.create(
      { name: "Committed Alice", group: "g" },
      { id: "reused-id" },
    );
    await target.nodes.Person.delete(asNodeId("reused-id"));

    const artifact = unwrap(
      await planMergeIncremental({
        forkPoint,
        target,
        branches: [source],
      }),
    );
    expect(artifact.guards.incremental).toEqual({
      tombstoneResurrection: "refuse",
      lossyUpdates: "refuse",
      edgeIdentity: "preserve",
    });

    const applied = await applyMergePlan(target, artifact);
    expect(isErr(applied)).toBe(true);
    if (isErr(applied)) {
      expect(applied.error).toBeInstanceOf(InvalidMergePlanError);
      expect(applied.error.message).toMatch(/resurrect soft-deleted/i);
    }
  });

  it("canonicalizes plans and diagnostics independently of branch enumeration", async () => {
    const base = await makeBase();
    const branches = await Promise.all([
      makeBranch(base, "a"),
      makeBranch(base, "b"),
      makeBranch(base, "c"),
    ]);
    for (const [index, source] of branches.entries()) {
      await source.store.nodes.Person.create(
        { name: `Alice ${index}`, group: "same" },
        { id: `alice-${index}` },
      );
    }
    const options = {
      resolve: {
        Person: {
          block: () => "same",
          similarity: {
            kind: "custom" as const,
            score: (left: unknown, right: unknown) => {
              const leftIndex = Number(
                (left as Readonly<{ name: string }>).name.at(-1),
              );
              const rightIndex = Number(
                (right as Readonly<{ name: string }>).name.at(-1),
              );
              const low = Math.min(leftIndex, rightIndex);
              const distance = Math.abs(leftIndex - rightIndex);
              if (distance !== 1) return 0.1;
              return low === 0 ? 0.9 : 0.85;
            },
          },
          threshold: 0.8,
        },
      },
      clusterMaxDiameter: 1,
      candidateDiagnostics: { limit: 1 },
    };

    const forward = unwrap(await planMerge(base, branches, options));
    const reverse = unwrap(
      await planMerge(base, [...branches].reverse(), options),
    );
    expect(forward.review.diagnostics).toMatchObject({
      total: 3,
      limit: 1,
      truncated: true,
    });
    expect(JSON.stringify(forward)).toBe(JSON.stringify(reverse));
    expect(canonicalMergePlanJson(forward)).toBe(
      canonicalMergePlanJson(reverse),
    );
    expect(forward.digest).toEqual(reverse.digest);

    const completeDiagnostics = unwrap(
      await planMerge(base, branches, {
        ...options,
        candidateDiagnostics: { limit: 3 },
      }),
    ).review.diagnostics;
    expect(completeDiagnostics?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scoreDecision: "accepted",
          clusterDisposition: "retained",
        }),
        expect.objectContaining({
          scoreDecision: "accepted",
          clusterDisposition: {
            kind: "excluded",
            reason: "diameter",
          },
        }),
        expect.objectContaining({ scoreDecision: "rejected" }),
      ]),
    );
  });

  it("detects target movement during planning and returns no artifact", async () => {
    const base = await makeBase();
    const fork = await makeBranch(base, "source");
    await fork.store.nodes.Person.create(
      { name: "Alice", group: "g" },
      { id: "alice" },
    );
    let moved = false;
    const embedder: Embedder = async (texts) => {
      if (!moved) {
        moved = true;
        await base.nodes.Person.create(
          { name: "Concurrent", group: "g" },
          { id: "concurrent" },
        );
      }
      return texts.map(() => new Float32Array([1, 0]));
    };
    const result = await planMerge(base, [fork], {
      resolve: {
        Person: {
          block: () => "g",
          similarity: { kind: "vector", field: "name" },
          threshold: 0.5,
        },
      },
      embedder,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(MergePlanningStaleError);
    }
  });

  it("detects fork-point movement during incremental planning", async () => {
    const forkPoint = await makeBase();
    const target = await makeBase();
    const source = await makeBranch(forkPoint, "source");
    await source.store.nodes.Person.create(
      { name: "Alice", group: "g" },
      { id: "alice" },
    );
    let moved = false;
    const result = await planMergeIncremental({
      forkPoint,
      target,
      branches: [source],
      options: {
        resolve: {
          Person: {
            block: () => "g",
            similarity: { kind: "vector", field: "name" },
            threshold: 0.5,
          },
        },
        embedder: async (texts) => {
          if (!moved) {
            moved = true;
            await forkPoint.nodes.Person.create(
              { name: "Concurrent", group: "g" },
              { id: "concurrent-fork" },
            );
          }
          return texts.map(() => new Float32Array([1, 0]));
        },
      },
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    }
  });

  it("preflights malformed writes before any mechanical operation", async () => {
    const base = await makeBase();
    const fork = await makeBranch(base, "source");
    await fork.store.nodes.Person.create(
      { name: "Alice", group: "g" },
      { id: "alice" },
    );
    const artifact = unwrap(await planMerge(base, [fork]));
    const { digest: _digest, ...artifactInput } = artifact;
    const invalid = await constructMergePlanArtifact({
      ...artifactInput,
      writes: {
        ...artifact.writes,
        edgeUpserts: [
          {
            kind: "MissingEdgeKind",
            id: "bad-edge",
            from: { kind: "Person", id: "alice" },
            to: { kind: "Person", id: "alice" },
            setProps: {},
            unsetProps: [],
          },
        ],
      },
      proposed: {
        ...artifact.proposed,
        edges: { upserts: 1, deletions: 0 },
      },
    });
    const result = await applyMergePlan(base, invalid);
    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(InvalidMergePlanError);
    }
    expect(await base.nodes.Person.getById(asNodeId("alice"))).toBeUndefined();
  });
});
