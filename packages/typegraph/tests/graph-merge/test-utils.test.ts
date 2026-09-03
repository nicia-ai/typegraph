import {
  CardinalityError,
  createStoreWithSchema,
  DatabaseOperationError,
  defineGraph,
  defineNode,
  generateId,
  TypeGraphError,
  UniquenessError,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  BaseVersionMismatchError,
  BranchError,
  IdentityMergeConflictError,
  InvalidMergeOptionsError,
  MergeConflictError,
  MergeConstraintConflictError,
  MergeError,
  SimilarityUnavailableError,
  StaleMergePlanError,
  translateMergeCommitError,
} from "../../src/graph-merge/errors";
import type { Result } from "../../src/graph-merge/result";
import { err, isErr, isOk, ok, unwrap } from "../../src/graph-merge/result";
import type {
  BackendMatrixEntry,
  MergeBackendFixture,
  SharedPgliteMergeEngine,
} from "./test-utils";
import {
  backendMatrix,
  createSqliteMergeBackend,
  getStoreBackend,
  setupSharedPgliteMergeEngine,
} from "./test-utils";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const graph = defineGraph({
  id: "merge-test-utils",
  nodes: { Person: { type: Person } },
  edges: {},
});

describe("backend matrix selection", () => {
  beforeEach(() => {
    vi.stubEnv("POSTGRES_URL", undefined);
    vi.stubEnv("TYPEGRAPH_TEST_BACKEND", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("keeps both local backends in the default lane", () => {
    expect(backendMatrix().map((entry) => entry.name)).toEqual([
      "SQLite",
      "PGlite",
    ]);
  });
  it("adds the server when a URL is supplied without a selector", () => {
    vi.stubEnv("POSTGRES_URL", "postgresql://localhost/test");
    expect(backendMatrix().map((entry) => entry.name)).toEqual([
      "SQLite",
      "PGlite",
      "Postgres",
    ]);
  });
  it("selects only the server for the dedicated lane", () => {
    vi.stubEnv("POSTGRES_URL", "postgresql://localhost/test");
    vi.stubEnv("TYPEGRAPH_TEST_BACKEND", "postgres");
    expect(backendMatrix().map((entry) => entry.name)).toEqual(["Postgres"]);
  });
  it.each([undefined, ""])(
    "refuses server selection without a URL (%s)",
    (url) => {
      vi.stubEnv("POSTGRES_URL", url);
      vi.stubEnv("TYPEGRAPH_TEST_BACKEND", "postgres");
      expect(() => backendMatrix()).toThrow("requires POSTGRES_URL");
    },
  );
  it("refuses an unknown selector", () => {
    vi.stubEnv("TYPEGRAPH_TEST_BACKEND", "typo");
    expect(() => backendMatrix()).toThrow("Unsupported TYPEGRAPH_TEST_BACKEND");
  });
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

  it("translates deterministic commit constraints with actionable details and cause", () => {
    const cardinality = new CardinalityError({
      edgeKind: "primaryEncounter",
      fromKind: "Patient",
      fromId: "pat-1",
      cardinality: "oneActive",
      existingCount: 1,
    });
    const translated = translateMergeCommitError(cardinality);

    expect(translated).toBeInstanceOf(MergeConstraintConflictError);
    const conflict = translated as MergeConstraintConflictError;
    expect(conflict).toBeInstanceOf(MergeError);
    expect(conflict.code).toBe("GRAPH_MERGE_CONSTRAINT_CONFLICT");
    expect(conflict.category).toBe("constraint");
    expect(conflict.cause).toBe(cardinality);
    expect(conflict.details).toMatchObject({
      constraintCode: "CARDINALITY_ERROR",
      constraintErrorName: "CardinalityError",
      edgeKind: "primaryEncounter",
      fromId: "pat-1",
      cardinality: "oneActive",
      existingCount: 1,
    });
    expect(conflict.details.constraintDetails).toBe(cardinality.details);
  });

  it("covers uniqueness without reclassifying system or stale-plan failures", () => {
    const uniqueness = new UniquenessError({
      constraintName: "byMrn",
      kind: "Patient",
      existingId: "pat-1",
      newId: "pat-2",
      fields: ["mrn"],
    });
    const uniquenessConflict = translateMergeCommitError(
      uniqueness,
    ) as MergeConstraintConflictError;
    expect(uniquenessConflict).toBeInstanceOf(MergeConstraintConflictError);
    expect(uniquenessConflict.details["constraintName"]).toBe("byMrn");
    expect(uniquenessConflict.details.constraintErrorName).toBe(
      "UniquenessError",
    );

    const backendFailure = new DatabaseOperationError("offline", {
      operation: "insert",
      entity: "node",
    });
    const stale = new StaleMergePlanError("target moved");
    const identityConflict = new IdentityMergeConflictError(
      "identity truth conflicts",
    );
    expect(translateMergeCommitError(backendFailure)).toBe(backendFailure);
    expect(translateMergeCommitError(stale)).toBe(stale);
    expect(translateMergeCommitError(identityConflict)).toBe(identityConflict);
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

  it("InvalidMergeOptionsError is a user error with a stable code", () => {
    const error = new InvalidMergeOptionsError("invalid options");

    expect(error).toBeInstanceOf(MergeError);
    expect(error.code).toBe("GRAPH_MERGE_INVALID_OPTIONS");
    expect(error.category).toBe("user");
  });

  it("error codes are mutually distinct", () => {
    const codes = [
      new MergeError("a").code,
      new BranchError("b").code,
      new InvalidMergeOptionsError("invalid").code,
      new SimilarityUnavailableError("c").code,
      new MergeConflictError("d").code,
      new MergeConstraintConflictError(
        new CardinalityError({
          edgeKind: "e",
          fromKind: "N",
          fromId: "n",
          cardinality: "one",
          existingCount: 1,
        }),
      ).code,
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
      expect(getStoreBackend(store)).toBe(fixture.backend);

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

describe("setupSharedPgliteMergeEngine", () => {
  let engine: SharedPgliteMergeEngine | undefined;

  afterEach(async () => {
    await engine?.dispose();
  });

  it("isolates simultaneously active stores on one PGlite engine", async () => {
    engine = await setupSharedPgliteMergeEngine();
    const first = await engine.makeFixture();
    const second = await engine.makeFixture();
    try {
      const [firstStore] = await createStoreWithSchema(graph, first.backend);
      const [secondStore] = await createStoreWithSchema(graph, second.backend);
      const created = await firstStore.nodes.Person.create({ name: "Ada" });

      await expect(
        firstStore.nodes.Person.getById(created.id),
      ).resolves.toEqual(created);
      await expect(
        secondStore.nodes.Person.getById(created.id),
      ).resolves.toBeUndefined();
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  });
});
