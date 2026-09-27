import type { GraphBackend, GraphDef, Store } from "@nicia-ai/typegraph";
import {
  asNodeId,
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  disjointWith,
} from "@nicia-ai/typegraph";
import { createSqliteBackend } from "@nicia-ai/typegraph/adapters/drizzle/sqlite";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { deriveBackend } from "../../src/backend/derive-backend";
import {
  BaseVersionMismatchError,
  BranchError,
  type CandidateWriteSet,
  CandidateWriteSetError,
  captureCandidateWriteSetTarget,
  planCandidateWriteSet,
  planCandidateWriteSetReview,
  planMergeIncremental,
} from "../../src/graph-merge";
import { ingestionBranch } from "../../src/graph-merge/ingestion-branch";
import { canonicalMergePlanJson } from "../../src/graph-merge/plan-canonical";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { asBranchId } from "../../src/graph-merge/types";
import { importGraph } from "../../src/interchange";
import type { CompiledRowsSql } from "../../src/query/sql-intent";
import { requireDefined } from "../../src/utils/presence";
import { createSqliteMergeBackend, getStoreBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), externalKey: z.string() }),
});

const graph = defineGraph({
  id: "candidate-write-set",
  nodes: {
    Person: {
      type: Person,
      unique: [
        {
          name: "person_external_key",
          fields: ["externalKey"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
  },
  edges: {},
});
const related = defineEdge("related", { schema: z.object({}) });
const cardinalityGraph = defineGraph({
  id: "candidate-cardinality",
  nodes: { Person: { type: Person } },
  edges: {
    related: {
      type: related,
      from: [Person],
      to: [Person],
      cardinality: "one",
    },
  },
});
const Alias = defineNode("Alias", {
  schema: z.object({ name: z.string(), externalKey: z.string() }),
});
const disjointGraph = defineGraph({
  id: "candidate-disjoint",
  nodes: { Person: { type: Person }, Alias: { type: Alias } },
  edges: {},
  ontology: [disjointWith(Person, Alias)],
});
const matched = defineEdge("matched", {
  schema: z.object({ code: z.string() }),
});
const edgeIdentityGraph = defineGraph({
  id: "candidate-edge-match-identity",
  nodes: { Person: { type: Person } },
  edges: {
    matched: {
      type: matched,
      from: [Person],
      to: [Person],
      matchIdentity: { name: "code", fields: ["code"] },
    },
  },
});
const identityGraph = defineGraph({
  id: "candidate-identity",
  identity: { sameIdAcrossKinds: "fold" },
  nodes: { Person: { type: Person }, Alias: { type: Alias } },
  edges: {},
});

describe("candidate write-set planning", () => {
  let baseBackend: GraphBackend;
  let cleanupBase: () => Promise<void>;

  beforeEach(() => {
    const fixture = createSqliteMergeBackend();
    baseBackend = fixture.backend;
    cleanupBase = fixture.cleanup;
  });

  afterEach(async () => cleanupBase());

  async function setup(backend = baseBackend) {
    const [target] = await createStoreWithSchema(graph, backend, {
      revisionTracking: true,
    });
    await requireDefined(target.nodes.Person).create(
      { name: "Accepted", externalKey: "shared" },
      { id: "accepted", validFrom: "2026-01-01T00:00:00.000Z" },
    );
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "source-a",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [
        {
          kind: "Person",
          id: "candidate",
          properties: { name: "Proposed", externalKey: "shared" },
          validFrom: "2026-01-02T00:00:00.000Z",
        },
      ],
      edges: [],
    };
    return { target, writeSet };
  }

  function candidateBackend() {
    const fixture = createSqliteMergeBackend();
    const close = vi.spyOn(fixture.backend, "close");
    return { makeBackend: () => Promise.resolve(fixture.backend), close };
  }

  async function fullCloneImportSucceeded<G extends GraphDef>(
    target: Store<G>,
    writeSet: CandidateWriteSet,
    branchId: string,
  ): Promise<boolean> {
    const branch = unwrap(
      await ingestionBranch(target, candidateBackend().makeBackend, {
        id: asBranchId(branchId),
      }),
    );
    try {
      const imported = await importGraph(
        branch,
        {
          formatVersion: "2.0",
          exportedAt: "1970-01-01T00:00:00.000Z",
          source: { type: "external" },
          nodes: writeSet.nodes,
          edges: writeSet.edges,
          ...(writeSet.identity === undefined ?
            {}
          : { identity: writeSet.identity }),
        },
        {
          onConflict: "update",
          onUnknownProperty: "error",
          validateReferences: true,
          refreshStatistics: false,
        },
      );
      return imported.success;
    } finally {
      await branch.close();
    }
  }

  const options = {
    resolve: {
      Person: {
        similarity: {
          kind: "custom" as const,
          score: () => 1,
        },
        threshold: 1,
      },
    },
  };

  it("matches full clone staging when an existing edge occupies cardinality one", async () => {
    const [target] = await createStoreWithSchema(
      cardinalityGraph,
      baseBackend,
      {
        revisionTracking: true,
      },
    );
    const source = await target.nodes.Person.create(
      { name: "Source", externalKey: "source" },
      { id: "source" },
    );
    const existing = await target.nodes.Person.create(
      { name: "Existing", externalKey: "existing" },
      { id: "existing" },
    );
    const proposed = await target.nodes.Person.create(
      { name: "Proposed", externalKey: "proposed" },
      { id: "proposed" },
    );
    await target.edges.related.create(source, existing, {}, { id: "old-edge" });
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "cardinality-candidate",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [],
      edges: [
        {
          kind: "related",
          id: "new-edge",
          from: { kind: "Person", id: source.id },
          to: { kind: "Person", id: proposed.id },
          properties: {},
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    expect(
      await fullCloneImportSucceeded(target, writeSet, "full-cardinality"),
    ).toBe(false);
    const bounded = await planCandidateWriteSet({
      target,
      makeBackend: candidateBackend().makeBackend,
      writeSet,
    });
    expect(isErr(bounded)).toBe(true);
  });

  it("plans an unrelated candidate on a constrained graph", async () => {
    const [target] = await createStoreWithSchema(
      cardinalityGraph,
      baseBackend,
      { revisionTracking: true },
    );
    const source = await target.nodes.Person.create(
      { name: "Source", externalKey: "source" },
      { id: "source" },
    );
    const peer = await target.nodes.Person.create(
      { name: "Peer", externalKey: "peer" },
      { id: "peer" },
    );
    await target.edges.related.create(source, peer, {}, { id: "old-edge" });
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "unrelated-candidate",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [
        {
          kind: "Person",
          id: "new",
          properties: { name: "New", externalKey: "new" },
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
      edges: [],
    };
    const full = unwrap(
      await ingestionBranch(target, candidateBackend().makeBackend, {
        id: asBranchId(writeSet.sourceId),
      }),
    );
    try {
      const imported = await importGraph(
        full,
        {
          formatVersion: "2.0",
          exportedAt: "1970-01-01T00:00:00.000Z",
          source: { type: "external" },
          nodes: writeSet.nodes,
          edges: writeSet.edges,
        },
        {
          onConflict: "update",
          onUnknownProperty: "error",
          validateReferences: true,
          refreshStatistics: false,
        },
      );
      expect(imported.success).toBe(true);
      const expected = unwrap(
        await planMergeIncremental({
          forkPoint: target,
          target,
          branches: [full],
        }),
      );
      const actual = unwrap(
        await planCandidateWriteSet({
          target,
          makeBackend: candidateBackend().makeBackend,
          writeSet,
        }),
      );
      expect(canonicalMergePlanJson(actual)).toBe(
        canonicalMergePlanJson(expected),
      );
    } finally {
      await full.close();
    }
  });

  it("matches full clone planning for a candidate identity assertion and existing class", async () => {
    const [target] = await createStoreWithSchema(identityGraph, baseBackend, {
      revisionTracking: true,
    });
    for (const id of ["a", "bridge", "unrelated-a", "unrelated-b"]) {
      await target.nodes.Person.create(
        { name: id, externalKey: id },
        { id, validFrom: "2026-01-01T00:00:00.000Z" },
      );
    }
    await target.nodes.Alias.create(
      { name: "Alias b", externalKey: "alias-b" },
      { id: "b", validFrom: "2026-01-01T00:00:00.000Z" },
    );
    const inherited = await importGraph(
      target,
      {
        formatVersion: "2.0",
        exportedAt: "1970-01-01T00:00:00.000Z",
        source: { type: "external" },
        nodes: [],
        edges: [],
        identity: {
          profile: "typegraph-identity-v1",
          mode: "state",
          assertions: [
            {
              id: "inherited-same",
              relation: "same",
              a: { kind: "Person", id: "a" },
              b: { kind: "Person", id: "bridge" },
              validFrom: "2026-01-01T00:00:00.000Z",
            },
            {
              id: "unrelated-different",
              relation: "different",
              a: { kind: "Person", id: "unrelated-a" },
              b: { kind: "Person", id: "unrelated-b" },
              validFrom: "2026-01-01T00:00:00.000Z",
            },
          ],
        },
      },
      { onConflict: "error" },
    );
    expect(inherited.success).toBe(true);
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "identity-candidate",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [],
      edges: [],
      identity: {
        profile: "typegraph-identity-v1",
        mode: "state",
        assertions: [
          {
            id: "candidate-same",
            relation: "same",
            a: { kind: "Alias", id: "b" },
            b: { kind: "Person", id: "bridge" },
            validFrom: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    };
    const full = unwrap(
      await ingestionBranch(target, candidateBackend().makeBackend, {
        id: asBranchId(writeSet.sourceId),
      }),
    );
    try {
      const imported = await importGraph(
        full,
        {
          formatVersion: "2.0",
          exportedAt: "1970-01-01T00:00:00.000Z",
          source: { type: "external" },
          nodes: writeSet.nodes,
          edges: writeSet.edges,
          identity: writeSet.identity,
        },
        {
          onConflict: "update",
          onUnknownProperty: "error",
          validateReferences: true,
          refreshStatistics: false,
        },
      );
      expect(imported.success).toBe(true);
      const expected = unwrap(
        await planMergeIncremental({
          forkPoint: target,
          target,
          branches: [full],
        }),
      );
      const actual = unwrap(
        await planCandidateWriteSet({
          target,
          makeBackend: candidateBackend().makeBackend,
          writeSet,
        }),
      );
      expect(canonicalMergePlanJson(actual)).toBe(
        canonicalMergePlanJson(expected),
      );
    } finally {
      await full.close();
    }
  });

  it("keeps identity planning reads bounded as unrelated assertions grow", async () => {
    const [target] = await createStoreWithSchema(identityGraph, baseBackend, {
      revisionTracking: true,
    });
    const first = await target.nodes.Person.create(
      { name: "First", externalKey: "first" },
      { id: "first", validFrom: "2026-01-01T00:00:00.000Z" },
    );
    const second = await target.nodes.Person.create(
      { name: "Second", externalKey: "second" },
      { id: "second", validFrom: "2026-01-01T00:00:00.000Z" },
    );
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "identity-budget",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [],
      edges: [],
      identity: {
        profile: "typegraph-identity-v1",
        mode: "state",
        assertions: [
          {
            id: "proposed-same",
            relation: "same",
            a: { kind: "Person", id: first.id },
            b: { kind: "Person", id: second.id },
            validFrom: "2026-09-27T00:00:00.000Z",
          },
        ],
      },
    };
    async function measure() {
      const execute = baseBackend.execute;
      let statements = 0;
      let returnedRows = 0;
      const read = vi
        .spyOn(baseBackend, "execute")
        .mockImplementation(async <T>(query: CompiledRowsSql) => {
          const rows = await execute<T>(query);
          statements += 1;
          returnedRows += rows.length;
          return rows;
        });
      const targetWrite = vi.spyOn(baseBackend, "insertNode");
      try {
        unwrap(
          await planCandidateWriteSet({
            target,
            makeBackend: candidateBackend().makeBackend,
            writeSet,
          }),
        );
        return {
          statements,
          returnedRows,
          targetWrites: targetWrite.mock.calls.length,
        };
      } finally {
        read.mockRestore();
        targetWrite.mockRestore();
      }
    }
    const before = await measure();
    for (let index = 0; index < 40; index += 1) {
      const left = await target.nodes.Person.create(
        { name: `Left ${index}`, externalKey: `left-${index}` },
        { id: `left-${index}` },
      );
      const right = await target.nodes.Person.create(
        { name: `Right ${index}`, externalKey: `right-${index}` },
        { id: `right-${index}` },
      );
      await target.identity.assertDifferent(left, right);
    }
    const after = await measure();
    expect(after.statements).toBeLessThanOrEqual(before.statements);
    expect(after.returnedRows).toBe(before.returnedRows);
    expect(after.targetWrites).toBe(0);
  });

  it("rejects a candidate assertion contradicting a target identity class", async () => {
    const [target] = await createStoreWithSchema(identityGraph, baseBackend, {
      revisionTracking: true,
    });
    const first = await target.nodes.Person.create(
      { name: "First", externalKey: "first" },
      { id: "first", validFrom: "2026-01-01T00:00:00.000Z" },
    );
    const second = await target.nodes.Person.create(
      { name: "Second", externalKey: "second" },
      { id: "second", validFrom: "2026-01-01T00:00:00.000Z" },
    );
    await target.identity.assertDifferent(first, second);
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "contradicting-identity-candidate",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [],
      edges: [],
      identity: {
        profile: "typegraph-identity-v1",
        mode: "state",
        assertions: [
          {
            id: "candidate-same",
            relation: "same",
            a: { kind: "Person", id: first.id },
            b: { kind: "Person", id: second.id },
            validFrom: "2026-09-27T00:00:00.000Z",
          },
        ],
      },
    };
    expect(
      await fullCloneImportSucceeded(
        target,
        writeSet,
        "full-identity-conflict",
      ),
    ).toBe(false);
    expect(
      isErr(
        await planCandidateWriteSet({
          target,
          makeBackend: candidateBackend().makeBackend,
          writeSet,
        }),
      ),
    ).toBe(true);
  });

  it("refuses candidate-scoped review on a graph requiring a complete clone", async () => {
    const [target] = await createStoreWithSchema(
      cardinalityGraph,
      baseBackend,
      {
        revisionTracking: true,
      },
    );
    const review = await planCandidateWriteSetReview({
      target,
      makeBackend: candidateBackend().makeBackend,
      writeSet: {
        formatVersion: 1,
        sourceId: "review-candidate",
        target: await captureCandidateWriteSetTarget(target),
        nodes: [],
        edges: [],
      },
      policy: { id: "review-policy", context: {} },
      reviewScope: "candidate",
    });
    expect(isErr(review)).toBe(true);
    if (isErr(review)) expect(review.error.code).toBe("GRAPH_MERGE_REVIEW");
  });

  it("matches full clone staging for a disjoint same-id sibling", async () => {
    const [target] = await createStoreWithSchema(disjointGraph, baseBackend, {
      revisionTracking: true,
    });
    await target.nodes.Person.create(
      { name: "Person", externalKey: "person" },
      { id: "shared" },
    );
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "disjoint-candidate",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [
        {
          kind: "Alias",
          id: "shared",
          properties: { name: "Alias", externalKey: "alias" },
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
      edges: [],
    };
    expect(
      await fullCloneImportSucceeded(target, writeSet, "full-disjoint"),
    ).toBe(false);
    const bounded = await planCandidateWriteSet({
      target,
      makeBackend: candidateBackend().makeBackend,
      writeSet,
    });
    expect(isErr(bounded)).toBe(true);
  });

  it("matches full clone staging for an occupied durable edge identity", async () => {
    const [target] = await createStoreWithSchema(
      edgeIdentityGraph,
      baseBackend,
      {
        revisionTracking: true,
      },
    );
    const source = await target.nodes.Person.create(
      { name: "Source", externalKey: "source" },
      { id: "source" },
    );
    const peer = await target.nodes.Person.create(
      { name: "Peer", externalKey: "peer" },
      { id: "peer" },
    );
    await target.edges.matched.create(
      source,
      peer,
      { code: "shared" },
      { id: "old-edge" },
    );
    const writeSet: CandidateWriteSet = {
      formatVersion: 1,
      sourceId: "edge-identity-candidate",
      target: await captureCandidateWriteSetTarget(target),
      nodes: [],
      edges: [
        {
          kind: "matched",
          id: "new-edge",
          from: { kind: "Person", id: source.id },
          to: { kind: "Person", id: peer.id },
          properties: { code: "shared" },
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
    };
    expect(
      await fullCloneImportSucceeded(target, writeSet, "full-match-identity"),
    ).toBe(false);
    const bounded = await planCandidateWriteSet({
      target,
      makeBackend: candidateBackend().makeBackend,
      writeSet,
    });
    expect(isErr(bounded)).toBe(true);
  });

  it("returns a deterministic serialized property-conflict plan with source attribution", async () => {
    const { target, writeSet } = await setup();
    const firstBackend = candidateBackend();
    const secondBackend = candidateBackend();

    const first = unwrap(
      await planCandidateWriteSet({
        target,
        makeBackend: firstBackend.makeBackend,
        writeSet: JSON.parse(JSON.stringify(writeSet)) as unknown,
        options,
      }),
    );
    const second = unwrap(
      await planCandidateWriteSet({
        target,
        makeBackend: secondBackend.makeBackend,
        writeSet: structuredClone(writeSet),
        options,
      }),
    );

    expect(canonicalMergePlanJson(first)).toBe(canonicalMergePlanJson(second));
    expect(first.review.conflicts).toEqual([
      expect.objectContaining({
        kind: "Person",
        property: "name",
        resolution: "Accepted",
        values: [{ branchId: "source-a", value: "Proposed" }],
      }),
    ]);
    expect(first.review.provenanceRecords).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          branchId: "source-a",
          sourceId: "candidate",
        }),
      ]),
    );
    expect(firstBackend.close).toHaveBeenCalledOnce();
    expect(secondBackend.close).toHaveBeenCalledOnce();
  });

  it("does not apply the candidate writes to accepted state", async () => {
    const { target, writeSet } = await setup();
    const backend = candidateBackend();

    unwrap(
      await planCandidateWriteSet({
        target,
        makeBackend: backend.makeBackend,
        writeSet,
        options,
      }),
    );

    const people = requireDefined(target.nodes.Person);
    expect(await people.count()).toBe(1);
    expect(
      await people.getById(asNodeId<typeof Person>("candidate")),
    ).toBeUndefined();
    expect(
      await people.getById(asNodeId<typeof Person>("accepted")),
    ).toMatchObject({ name: "Accepted", externalKey: "shared" });
  });

  it("matches the full clone for overlapping and unrelated target rows", async () => {
    const { target, writeSet } = await setup();
    await target.nodes.Person.create(
      { name: "Unrelated", externalKey: "unrelated" },
      { id: "unrelated", validFrom: "2026-01-01T00:00:00.000Z" },
    );
    const updated = {
      ...writeSet,
      nodes: [
        ...writeSet.nodes,
        {
          kind: "Person",
          id: "accepted",
          properties: { name: "Changed", externalKey: "shared" },
          validFrom: "2026-01-01T00:00:00.000Z",
        },
      ],
    } satisfies CandidateWriteSet;
    const bounded = unwrap(
      await planCandidateWriteSet({
        target,
        makeBackend: candidateBackend().makeBackend,
        writeSet: updated,
        options,
      }),
    );
    const fullBranch = unwrap(
      await ingestionBranch(target, candidateBackend().makeBackend, {
        id: asBranchId(updated.sourceId),
      }),
    );
    try {
      const imported = await importGraph(
        fullBranch,
        {
          formatVersion: "2.0",
          exportedAt: "1970-01-01T00:00:00.000Z",
          source: { type: "external" },
          nodes: updated.nodes,
          edges: updated.edges,
        },
        {
          onConflict: "update",
          onUnknownProperty: "error",
          validateReferences: true,
          refreshStatistics: false,
        },
      );
      expect(imported.success).toBe(true);
      const full = unwrap(
        await planMergeIncremental({
          forkPoint: target,
          target,
          branches: [fullBranch],
          options,
        }),
      );
      expect(canonicalMergePlanJson(bounded)).toBe(
        canonicalMergePlanJson(full),
      );
    } finally {
      await fullBranch.close();
    }
  });

  it("refuses a target write during bounded point reads", async () => {
    const { target, writeSet } = await setup();
    const getNodes = baseBackend.getNodes;
    if (getNodes === undefined) throw new Error("Expected batched point read");
    vi.spyOn(baseBackend, "getNodes").mockImplementationOnce(
      async (graphId, kind, ids) => {
        const rows = await getNodes(graphId, kind, ids);
        await target.nodes.Person.create(
          { name: "Concurrent", externalKey: "concurrent" },
          { id: "concurrent" },
        );
        return rows;
      },
    );
    const result = await planCandidateWriteSet({
      target,
      makeBackend: candidateBackend().makeBackend,
      writeSet,
      options,
    });
    expect(isErr(result)).toBe(true);
    if (isErr(result))
      expect(result.error).toBeInstanceOf(BaseVersionMismatchError);
    expect(
      await target.nodes.Person.getById(asNodeId<typeof Person>("candidate")),
    ).toBeUndefined();
  });

  it("keeps planning reads and staging writes bounded as unrelated rows grow", async () => {
    const { target, writeSet } = await setup();
    async function measure() {
      const getNodes = baseBackend.getNodes;
      if (getNodes === undefined)
        throw new Error("Expected batched point read");
      let requestedIds = 0;
      let returnedRows = 0;
      const pointRead = vi
        .spyOn(baseBackend, "getNodes")
        .mockImplementation(async (graphId, kind, ids) => {
          requestedIds += ids.length;
          const rows = await getNodes(graphId, kind, ids);
          returnedRows += rows.length;
          return rows;
        });
      const nodeScan = vi.spyOn(baseBackend, "findNodesByKind");
      const edgeScan = vi.spyOn(baseBackend, "findEdgesByKind");
      const acrossKinds = baseBackend.findNodesAcrossKinds;
      const acrossKindsScan =
        acrossKinds === undefined ? undefined : (
          vi.spyOn(baseBackend, "findNodesAcrossKinds")
        );
      const targetWrite = vi.spyOn(baseBackend, "insertNode");
      const fixture = createSqliteMergeBackend();
      const stagingWrite = vi.spyOn(fixture.backend, "insertNode");
      try {
        unwrap(
          await planCandidateWriteSet({
            target,
            makeBackend: () => Promise.resolve(fixture.backend),
            writeSet,
            options,
          }),
        );
        return {
          requestedIds,
          returnedRows,
          nodeScans: nodeScan.mock.calls.length,
          edgeScans: edgeScan.mock.calls.length,
          acrossKindsScans: acrossKindsScan?.mock.calls.length ?? 0,
          targetWrites: targetWrite.mock.calls.length,
          stagingWrites: stagingWrite.mock.calls.length,
        };
      } finally {
        pointRead.mockRestore();
        nodeScan.mockRestore();
        edgeScan.mockRestore();
        acrossKindsScan?.mockRestore();
        targetWrite.mockRestore();
        stagingWrite.mockRestore();
      }
    }
    const before = await measure();
    for (let index = 0; index < 60; index += 1) {
      await target.nodes.Person.create(
        { name: `Unrelated ${index}`, externalKey: `unrelated-${index}` },
        { id: `unrelated-${index}` },
      );
    }
    const after = await measure();
    expect(after).toEqual(before);
    expect(after).toMatchObject({
      nodeScans: 0,
      edgeScans: 0,
      acrossKindsScans: 0,
      targetWrites: 0,
    });
    expect(after.returnedRows).toBeLessThanOrEqual(2);
  });

  it("does not refresh statistics for a disposable ingestion clone", async () => {
    const { target, writeSet } = await setup();
    const fixture = createSqliteMergeBackend();
    const refreshStatistics = vi.spyOn(fixture.backend, "refreshStatistics");

    unwrap(
      await planCandidateWriteSet({
        target,
        makeBackend: () => Promise.resolve(fixture.backend),
        writeSet,
        options,
      }),
    );

    expect(refreshStatistics).not.toHaveBeenCalled();
  });

  it("returns typed validation and schema-target refusals before provisioning", async () => {
    const { target, writeSet } = await setup();
    const makeBackend = vi.fn(() => {
      throw new Error("must not provision");
    });

    const malformed = await planCandidateWriteSet({
      target,
      makeBackend,
      writeSet: { formatVersion: 1 },
    });
    expect(isErr(malformed)).toBe(true);
    if (isErr(malformed)) {
      expect(malformed.error).toBeInstanceOf(CandidateWriteSetError);
      expect(malformed.error.code).toBe("GRAPH_MERGE_CANDIDATE_WRITE_SET");
    }

    const mismatched = await planCandidateWriteSet({
      target,
      makeBackend,
      writeSet: {
        ...writeSet,
        target: { ...writeSet.target, schemaHash: "another-schema" },
      },
    });
    expect(isErr(mismatched)).toBe(true);
    if (isErr(mismatched)) {
      expect(mismatched.error).toBeInstanceOf(CandidateWriteSetError);
      expect(mismatched.error.details).toMatchObject({
        expected: writeSet.target,
      });
    }
    expect(makeBackend).not.toHaveBeenCalled();
  });

  it("returns a typed refusal when transient staging provisioning throws", async () => {
    const { target, writeSet } = await setup();
    const cause = new Error("provisioning failed");

    const result = await planCandidateWriteSet({
      target,
      makeBackend: () => Promise.reject(cause),
      writeSet,
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(CandidateWriteSetError);
      expect(result.error.message).toBe(
        "Unable to create the transient candidate staging store.",
      );
      expect(result.error.cause).toBeInstanceOf(BranchError);
    }
  });

  it("refuses a candidate backend that is the target backend without closing the target", async () => {
    const { target, writeSet } = await setup();
    const targetBackend = getStoreBackend(target);
    const close = vi.spyOn(targetBackend, "close");

    const result = await planCandidateWriteSet({
      target,
      writeSet,
      makeBackend: () => Promise.resolve(targetBackend),
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(CandidateWriteSetError);
    }
    expect(close).not.toHaveBeenCalled();
    expect(await target.nodes.Person.count()).toBe(1);
    await target.nodes.Person.create({
      name: "Still usable",
      externalKey: "still-usable",
    });
    expect(await target.nodes.Person.count()).toBe(2);
  });

  it("refuses a candidate backend derived from the target without closing it", async () => {
    const { target, writeSet } = await setup();
    const targetBackend = getStoreBackend(target);
    const close = vi.spyOn(targetBackend, "close");
    const candidateBackend = deriveBackend(targetBackend, {});

    const result = await planCandidateWriteSet({
      target,
      writeSet,
      makeBackend: () => Promise.resolve(candidateBackend),
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(CandidateWriteSetError);
    }
    expect(close).not.toHaveBeenCalled();
    expect(await target.nodes.Person.count()).toBe(1);
    await target.nodes.Person.create({
      name: "Still usable",
      externalKey: "still-usable",
    });
    expect(await target.nodes.Person.count()).toBe(2);
  });

  it("refuses a second candidate wrapper over the target's serialized connection without closing it", async () => {
    const sqlite = new Database(":memory:");
    const targetBackend = createSqliteBackend(drizzle(sqlite), {
      executionProfile: { isSync: true },
    });
    try {
      const { target, writeSet } = await setup(targetBackend);
      const candidateBackend = createSqliteBackend(drizzle(sqlite), {
        executionProfile: { isSync: true },
      });
      const close = vi.spyOn(candidateBackend, "close");

      const result = await planCandidateWriteSet({
        target,
        writeSet,
        makeBackend: () => Promise.resolve(candidateBackend),
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error).toBeInstanceOf(CandidateWriteSetError);
      }
      expect(close).not.toHaveBeenCalled();
      expect(await target.nodes.Person.count()).toBe(1);
      await target.nodes.Person.create({
        name: "Still usable",
        externalKey: "still-usable",
      });
      expect(await target.nodes.Person.count()).toBe(2);
    } finally {
      await targetBackend.close();
      sqlite.close();
    }
  });

  it("plans against a target row whose undeclared properties validateStore reports as healthy", async () => {
    const { target, writeSet } = await setup();
    await getStoreBackend(target).insertNode({
      graphId: target.graphId,
      kind: "Person",
      id: "legacy-extra",
      props: { name: "Legacy", externalKey: "legacy", legacyFlag: true },
    });
    expect(
      (await target.validateStore({ entity: "node", kind: "Person" }))
        .violations,
    ).toEqual([]);

    const backend = candidateBackend();
    const planned = unwrap(
      await planCandidateWriteSet({
        target,
        makeBackend: backend.makeBackend,
        writeSet,
        options,
      }),
    );
    expect(
      planned.writes.nodeDeletes.some((entry) => entry.id === "legacy-extra"),
    ).toBe(false);
    expect(
      planned.writes.nodeUpserts.some(
        (entry) =>
          entry.id === "legacy-extra" &&
          entry.unsetProps.includes("legacyFlag"),
      ),
    ).toBe(false);
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("refuses a candidate write set that carries undeclared properties", async () => {
    const { target, writeSet } = await setup();
    const backend = candidateBackend();
    const result = await planCandidateWriteSet({
      target,
      makeBackend: backend.makeBackend,
      writeSet: {
        ...writeSet,
        nodes: [
          {
            ...writeSet.nodes[0],
            properties: {
              name: "Proposed",
              externalKey: "shared",
              legacyFlag: true,
            },
          },
        ],
      },
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(CandidateWriteSetError);
      expect(result.error.details["errors"]).toEqual([
        expect.objectContaining({ entityType: "node", id: "candidate" }),
      ]);
      expect(JSON.stringify(result.error.details["errors"])).toContain(
        "legacyFlag",
      );
    }
    expect(backend.close).toHaveBeenCalledOnce();
  });

  it("closes staging after an attributed import refusal", async () => {
    const { target, writeSet } = await setup();
    const backend = candidateBackend();
    const result = await planCandidateWriteSet({
      target,
      makeBackend: backend.makeBackend,
      writeSet: {
        ...writeSet,
        nodes: [
          {
            ...writeSet.nodes[0],
            properties: { name: 42, externalKey: "invalid" },
          },
        ],
      },
    });

    expect(isErr(result)).toBe(true);
    if (isErr(result)) {
      expect(result.error).toBeInstanceOf(CandidateWriteSetError);
      expect(result.error.details["errors"]).toEqual([
        expect.objectContaining({ entityType: "node", id: "candidate" }),
      ]);
    }
    expect(backend.close).toHaveBeenCalledOnce();
  });
});
