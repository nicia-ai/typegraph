import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  asNodeId,
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  type CandidateWriteSet,
  CandidateWriteSetError,
  captureCandidateWriteSetTarget,
  planCandidateWriteSet,
} from "../../src/graph-merge";
import { canonicalMergePlanJson } from "../../src/graph-merge/plan-canonical";
import { isErr, unwrap } from "../../src/graph-merge/result";
import { requireDefined } from "../../src/utils/presence";
import { createSqliteMergeBackend } from "./test-utils";

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

describe("candidate write-set planning", () => {
  let baseBackend: GraphBackend;
  let cleanupBase: () => Promise<void>;

  beforeEach(() => {
    const fixture = createSqliteMergeBackend();
    baseBackend = fixture.backend;
    cleanupBase = fixture.cleanup;
  });

  afterEach(async () => cleanupBase());

  async function setup() {
    const [target] = await createStoreWithSchema(graph, baseBackend, {
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
