import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  generateId,
  TypeGraphError,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  BaseVersionMismatchError,
  BranchError,
  MergeConflictError,
  MergeError,
  SimilarityUnavailableError,
} from "../../src/graph-merge/errors";
import type { Result } from "../../src/graph-merge/result";
import { err, isErr, isOk, ok, unwrap } from "../../src/graph-merge/result";
import type { BackendMatrixEntry, MergeBackendFixture } from "./test-utils";
import { backendMatrix, createSqliteMergeBackend } from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "merge-test-utils",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("graph-merge Result module", () => {
  it("round-trips ok() and reads its data", () => {
    const result = ok(42);
    expect(isOk(result)).toBe(true);
    expect(isErr(result)).toBe(false);
    expect(unwrap(result)).toBe(42);
  });

  it("round-trips err() and surfaces its error", () => {
    const cause = new Error("boom");
    const result = err(cause);
    expect(isErr(result)).toBe(true);
    expect(isOk(result)).toBe(false);
    if (isErr(result)) {
      expect(result.error).toBe(cause);
    }
    expect(() => unwrap(result)).toThrow(cause);
  });

  it("ok() defaults to undefined data when called with no argument", () => {
    const result = ok();
    expect(isOk(result)).toBe(true);
    expect(unwrap(result)).toBeUndefined();
  });

  it("narrows the discriminated union via the type guards", () => {
    const value: Result<number, Error> =
      Math.random() < 2 ? ok(1) : err(new Error("never"));
    if (isOk(value)) {
      const widened: number = value.data;
      expect(widened).toBe(1);
    } else {
      throw new Error("expected ok branch");
    }
  });
});

describe("graph-merge Result structural compatibility with TypeGraph", () => {
  it("is assignable to TypeGraph's Result shape (type-level drift guard)", () => {
    // The graph-merge subpath intentionally re-exports TypeGraph's internal
    // Result shape. If that shape drifts, the assignments below stop compiling.
    type TypeGraphResult<T, E = Error> =
      | Readonly<{ success: true; data: T }>
      | Readonly<{ success: false; error: E }>;

    const localOk: Result<number, Error> = ok(7);
    const localErr: Result<number, Error> = err(new Error("x"));

    const asPublicOk: TypeGraphResult<number, Error> = localOk;
    const asPublicErr: TypeGraphResult<number, Error> = localErr;

    // And the reverse direction: a value typed as the canonical shape must be
    // assignable back to our local Result.
    const publicValue: TypeGraphResult<number, Error> = {
      success: true,
      data: 9,
    };
    const backToLocal: Result<number, Error> = publicValue;

    expect(isOk(asPublicOk)).toBe(true);
    expect(isErr(asPublicErr)).toBe(true);
    expect(unwrap(backToLocal)).toBe(9);
  });
});

describe("MergeError hierarchy", () => {
  it("MergeError is a TypeGraphError with a stable code and cause chain", () => {
    const cause = new Error("underlying");
    const error = new MergeError("merge failed", { cause });
    expect(error).toBeInstanceOf(TypeGraphError);
    expect(error).toBeInstanceOf(MergeError);
    expect(error.name).toBe("MergeError");
    expect(error.code).toBe("GRAPH_MERGE_ERROR");
    expect(error.category).toBe("system");
    expect(error.cause).toBe(cause);
  });

  it("BranchError is a distinct TypeGraphError subclass", () => {
    const error = new BranchError("branch failed");
    expect(error).toBeInstanceOf(TypeGraphError);
    expect(error).toBeInstanceOf(BranchError);
    expect(error).not.toBeInstanceOf(MergeError);
    expect(error.code).toBe("GRAPH_MERGE_BRANCH_ERROR");
  });

  it("SimilarityUnavailableError discriminates from generic MergeError", () => {
    const error = new SimilarityUnavailableError("no embedder configured");
    expect(error).toBeInstanceOf(TypeGraphError);
    expect(error).toBeInstanceOf(MergeError);
    expect(error).toBeInstanceOf(SimilarityUnavailableError);
    expect(error.code).toBe("GRAPH_MERGE_SIMILARITY_UNAVAILABLE");
    expect(error.suggestion).toContain("embedder");
  });

  it("MergeConflictError discriminates and carries details", () => {
    const error = new MergeConflictError("unresolved conflict", {
      details: { entityId: "n1", property: "name" },
    });
    expect(error).toBeInstanceOf(MergeError);
    expect(error.code).toBe("GRAPH_MERGE_CONFLICT");
    expect(error.details).toEqual({ entityId: "n1", property: "name" });
  });

  it("BaseVersionMismatchError discriminates with its own code", () => {
    const error = new BaseVersionMismatchError(
      "branch base@V differs from target",
    );
    expect(error).toBeInstanceOf(MergeError);
    expect(error).toBeInstanceOf(BaseVersionMismatchError);
    expect(error.code).toBe("GRAPH_MERGE_BASE_VERSION_MISMATCH");
    expect(error.suggestion).toContain("Re-branch");
  });

  it("error codes are mutually distinct", () => {
    const codes = [
      new MergeError("a").code,
      new BranchError("b").code,
      new SimilarityUnavailableError("c").code,
      new MergeConflictError("d").code,
      new BaseVersionMismatchError("e").code,
    ];
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe.each(backendMatrix())(
  "dual-backend fixtures: $name",
  (entry: BackendMatrixEntry) => {
    let fixture: MergeBackendFixture;

    afterEach(async () => {
      await fixture.cleanup();
    });

    it("yields a usable store via createStoreWithSchema", async () => {
      fixture = await entry.make();
      const [store, validation] = await createStoreWithSchema(
        graph,
        fixture.backend,
      );

      expect(validation).toBeDefined();
      expect(store.graphId).toBe("merge-test-utils");
      expect(store.backend).toBe(fixture.backend);

      const name = `Person-${generateId()}`;
      const created = await store.nodes.Person.create({ name });
      expect(created.id).toBeDefined();
      expect(created.name).toBe(name);

      const fetched = await store.nodes.Person.getById(created.id);
      expect(fetched?.name).toBe(name);
    });
  },
);

describe("createSqliteMergeBackend (direct)", () => {
  it("constructs and cleans up an in-memory SQLite backend", async () => {
    const fixture = createSqliteMergeBackend();
    expect(fixture.backend).toBeDefined();
    const [store] = await createStoreWithSchema(graph, fixture.backend);
    expect(store.graphId).toBe("merge-test-utils");
    await fixture.cleanup();
  });
});
