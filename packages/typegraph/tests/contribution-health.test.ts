/**
 * The contribution health ladder's refusals (#377, #337).
 *
 * The happy paths and the drift/repair/rebuild verdicts live in the shared
 * cross-backend suite, because they are query-layer semantics that only
 * count as verified when the same case runs on every backend. What lives
 * here is the complement: the states no shipped backend can reach, so the
 * only way to pin them is to build a backend that declines.
 *
 * Every one of these is a *declared* gap. The rule they enforce is that a
 * backend which cannot do something says so — through
 * `capabilities.contributions` and a typed error naming the reason — and
 * never by returning an answer that looks like success. `probe` in
 * particular must never answer "ready" without having looked.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  type ContributionProbeEntry,
  ContributionRebuildUnsupportedError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  fts5Strategy,
  searchable,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import {
  type ContributionMaterializerDeps,
  contributionRebuildSupported,
  createContributionMaterializer,
} from "../src/backend/drizzle/contribution-materializations";
import type {
  ContributionMaterializationIdentity,
  ContributionMaterializationRow,
  ContributionRepopulationStats,
  RecordContributionMaterializationParams,
  SchemaWriteTransactionBackend,
} from "../src/backend/types";
import { type FulltextStrategy } from "../src/query/dialect/fulltext-strategy";
import { createTestBackend } from "./test-utils";

const GRAPH_ID = "contribution-health";
const FULLTEXT_TABLE = "typegraph_node_fulltext";

const Article = defineNode("Article", {
  schema: z.object({ title: searchable(), body: z.string() }),
});

const graph = defineGraph({
  id: GRAPH_ID,
  nodes: { Article: { type: Article } },
  edges: {},
});

/**
 * The error a rejected promise carries, or `undefined` when it resolves.
 * These tests assert on refusals, so the error object itself — its class,
 * its `reason`, its `details` — is the assertion subject rather than a
 * message match.
 */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

/**
 * A backend that does not implement the named ports, which is what "the
 * backend cannot do this" means at the type level: an absent method, not
 * a method that throws. A proxy rather than a rest-spread because the
 * backends are built as objects with bound closures, and omitting a key
 * must not also rebind or drop the rest.
 */
function withoutPorts<T extends object>(
  backend: T,
  ...ports: readonly (keyof T & string)[]
): T {
  const hidden = new Set<PropertyKey>(ports);
  return new Proxy(backend, {
    get: (target, property, receiver) =>
      hidden.has(property) ? undefined : (
        Reflect.get(target, property, receiver)
      ),
    has: (target, property) =>
      !hidden.has(property) && Reflect.has(target, property),
  });
}

/** Repopulation that must never be reached when a refusal is correct. */
const unreachableRepopulate = vi.fn(
  (): Promise<ContributionRepopulationStats> => {
    throw new Error("repopulate must not run when the rebuild is refused");
  },
);

/**
 * A materializer whose marker store is in memory and whose fence is
 * present or absent by choice. Only the seams these refusals depend on
 * are modeled; the shared suite covers everything that actually executes.
 */
function createRefusingMaterializer(
  options: Readonly<{
    fulltextStrategy?: FulltextStrategy;
    withFence?: boolean;
  }> = {},
) {
  const markers = new Map<string, ContributionMaterializationRow>();
  const execDdl = vi.fn((): Promise<void> => Promise.resolve());
  const fenceRuns = vi.fn();

  const deps: ContributionMaterializerDeps = {
    dialect: "sqlite",
    fenceTarget: {
      dialect: "sqlite",
      capabilities: {
        execution: {
          interactiveTransactions: true,
          atomicBatch: "none",
          unitOfWork: "interactive",
        },
        windowFunctions: true,
        pessimisticLocks: {
          advisoryLocks: false,
          tableLocks: false,
          serializedWriters: true,
        },
      },
    },
    fulltextStrategy: options.fulltextStrategy ?? fts5Strategy,
    fulltextTableName: FULLTEXT_TABLE,
    vectorStrategy: undefined,
    execDdl,
    ensureMarkerTable: () => Promise.resolve(),
    getMarkers: (graphId) =>
      Promise.resolve(
        [...markers.values()].filter((row) => row.graphId === graphId),
      ),
    recordMarker: (params: RecordContributionMaterializationParams) => {
      markers.set(params.tableName, {
        graphId: params.graphId,
        logicalName: params.logicalName,
        owner: params.owner,
        tableName: params.tableName,
        signature: params.signature,
        materializedAt: params.materializedAt,
        lastAttemptedAt: params.attemptedAt,
        lastError: params.error,
      });
      return Promise.resolve();
    },
    deleteMarker: (identity: ContributionMaterializationIdentity) => {
      markers.delete(identity.tableName);
      return Promise.resolve();
    },
    tableExists: () => Promise.resolve(true),
    ...(options.withFence === true ?
      {
        schemaWriteTransaction: <T>(
          _graphId: string,
          _fn: (tx: SchemaWriteTransactionBackend) => Promise<T>,
        ): Promise<T> => {
          fenceRuns();
          throw new Error("fence body must not run when the rebuild refuses");
        },
      }
    : {}),
  };

  return {
    materializer: createContributionMaterializer(deps),
    execDdl,
    fenceRuns,
  };
}

/** The fts5 strategy with its teardown DDL removed, as a pre-#337 one would be. */
const strategyWithoutTeardown: FulltextStrategy = {
  ...fts5Strategy,
  ownedTables: (primaryTableName) =>
    fts5Strategy
      .ownedTables(primaryTableName)
      .map(({ dropDdl: _dropDdl, ...contribution }) => contribution),
};

describe("rebuildContribution refusals", () => {
  it("refuses a vector rebuild before touching any storage", async () => {
    const { materializer, execDdl, fenceRuns } = createRefusingMaterializer({
      withFence: true,
    });

    const error = await captureRejection(
      materializer.rebuildContribution(
        GRAPH_ID,
        "vector",
        unreachableRepopulate,
      ),
    );

    expect(error).toBeInstanceOf(ContributionRebuildUnsupportedError);
    expect(error).toMatchObject({
      code: "CONTRIBUTION_REBUILD_UNSUPPORTED",
      reason: "vector-source-unavailable",
    });
    // The message has to say why rather than just "unsupported": the
    // reason IS the finding — TypeGraph never sees what produced a vector.
    expect((error as Error).message).toContain(
      "the vectors callers supply and never the inputs that produced them",
    );
    expect((error as { suggestion?: string }).suggestion).toContain(
      "reembedVectorField",
    );

    // A refusal, not a partial attempt.
    expect(execDdl).not.toHaveBeenCalled();
    expect(fenceRuns).not.toHaveBeenCalled();
    expect(unreachableRepopulate).not.toHaveBeenCalled();
  });

  it("refuses when the strategy declares no teardown DDL", async () => {
    const { materializer, execDdl } = createRefusingMaterializer({
      fulltextStrategy: strategyWithoutTeardown,
      withFence: true,
    });

    const error = await captureRejection(
      materializer.rebuildContribution(
        GRAPH_ID,
        "fulltext",
        unreachableRepopulate,
      ),
    );

    expect(error).toBeInstanceOf(ContributionRebuildUnsupportedError);
    expect(error).toMatchObject({
      reason: "no-drop-ddl",
      // The identity of the contribution that cannot be torn down, so an
      // operator can see which strategy needs the declaration.
      details: {
        owner: "fts5",
        logicalName: "fulltext",
        physicalName: FULLTEXT_TABLE,
      },
    });
    // Not "synthesize a DROP TABLE and carry on": guessing at a teardown
    // the strategy never sanctioned is how a rebuild destroys more than
    // it was asked to.
    expect(execDdl).not.toHaveBeenCalled();
  });

  it("refuses when the backend has no transactional schema fence", async () => {
    const { materializer, execDdl } = createRefusingMaterializer();

    const error = await captureRejection(
      materializer.rebuildContribution(
        GRAPH_ID,
        "fulltext",
        unreachableRepopulate,
      ),
    );

    expect(error).toBeInstanceOf(ContributionRebuildUnsupportedError);
    expect(error).toMatchObject({ reason: "no-schema-fence" });
    // Running unfenced would risk exactly the state the atomicity exists
    // to prevent: storage attested but empty.
    expect(execDdl).not.toHaveBeenCalled();
  });

  it("checks the refusal order the ladder depends on", async () => {
    // Vector wins over every other precondition: a backend that could not
    // rebuild anything must still explain that vector storage is the case
    // no backend can ever rebuild, rather than blaming its own wiring.
    const { materializer } = createRefusingMaterializer({
      fulltextStrategy: strategyWithoutTeardown,
    });

    await expect(
      materializer.rebuildContribution(
        GRAPH_ID,
        "vector",
        unreachableRepopulate,
      ),
    ).rejects.toMatchObject({ reason: "vector-source-unavailable" });
  });
});

describe("contributionRebuildSupported", () => {
  it("requires both a teardown declaration and a transactional fence", () => {
    expect(
      contributionRebuildSupported(fts5Strategy, FULLTEXT_TABLE, true),
    ).toBe(true);
    expect(
      contributionRebuildSupported(fts5Strategy, FULLTEXT_TABLE, false),
    ).toBe(false);
    expect(
      contributionRebuildSupported(
        strategyWithoutTeardown,
        FULLTEXT_TABLE,
        true,
      ),
    ).toBe(false);
  });
});

describe("probeContributions on a backend that cannot probe", () => {
  it("reports no entries when the backend has no contribution machinery", async () => {
    const base = createTestBackend();
    const backend = withoutPorts(
      deriveBackend(base, {
        capabilities: { ...base.capabilities, contributions: undefined },
      }),
      "probeContributions",
    );
    const [store] = await createStoreWithSchema(graph, backend);

    // Nothing was ever materialized here, so there is nothing to assess —
    // and an empty result is the honest way to say that. It reads as
    // "nothing to assess", never as "assessed and healthy", because a
    // declared projection always produces an entry.
    await expect(store.probeContributions()).resolves.toEqual({ entries: [] });
  });

  it("refuses when contributions are supported but unprobeable", async () => {
    const base = createTestBackend();
    const backend = withoutPorts(
      deriveBackend(base, {
        capabilities: {
          ...base.capabilities,
          contributions: { supported: true, probe: false, rebuild: false },
        },
      }),
      "probeContributions",
    );
    const [store] = await createStoreWithSchema(graph, backend);

    // The declared gap. Answering `ready` here would be the one answer a
    // readiness check must never give: this backend provisioned storage it
    // cannot verify, and reporting health without looking is worse than
    // refusing.
    const error = await captureRejection(store.probeContributions());
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: { capability: "contributions", operation: "probe" },
    });
  });

  it("refuses a rebuild on a backend without the port", async () => {
    const base = createTestBackend();
    const backend = withoutPorts(base, "rebuildContribution");
    const [store] = await createStoreWithSchema(graph, backend);

    const error = await captureRejection(store.rebuildContribution("fulltext"));
    expect(error).toBeInstanceOf(ConfigurationError);
    expect(error).toMatchObject({
      details: { capability: "contributions", operation: "rebuild" },
    });
  });

  it("refuses to refill a scope the store cannot reconstruct, even if the backend accepted it", async () => {
    // The port's contract is that implementations refuse `"vector"` before
    // anything is dropped. A backend that ignored it would reach the
    // store's refill callback, which only knows how to reconstruct
    // fulltext — writing fulltext rows over storage just dropped for
    // another projection is worse than the refusal that was skipped, so
    // the store restates the invariant instead of trusting it.
    const base = createTestBackend();
    const dropped: string[] = [];
    const backend = deriveBackend(base, {
      rebuildContribution: async (_graphId, scope, refill) => {
        dropped.push(scope);
        // The refill target is never read: the store's guard throws first.
        const stats = await refill(base);
        return { rebuilt: [], ...stats };
      },
    });
    const [store] = await createStoreWithSchema(graph, backend);

    const error = await captureRejection(store.rebuildContribution("vector"));
    expect(error).toBeInstanceOf(ContributionRebuildUnsupportedError);
    expect(error).toMatchObject({
      reason: "vector-source-unavailable",
      details: { contribution: "vector" },
    });
    // The refusal came from the refill, so the port really was entered —
    // this is the mid-operation discovery, not the upfront gate.
    expect(dropped).toEqual(["vector"]);
  });

  it("still probes projections it can assess when a probe is available", async () => {
    const probeContributions = vi.fn(
      (): Promise<readonly ContributionProbeEntry[]> =>
        Promise.resolve([{ contribution: "fulltext", state: "ready" }]),
    );
    const base = createTestBackend();
    const backend = deriveBackend(base, { probeContributions });
    const [store] = await createStoreWithSchema(graph, backend);

    await expect(store.probeContributions()).resolves.toEqual({
      entries: [{ contribution: "fulltext", state: "ready" }],
    });
    // No vector support on this backend, so no vector slots are offered
    // for assessment — reporting them would be a false positive on every
    // store it opens.
    expect(probeContributions).toHaveBeenCalledWith(GRAPH_ID, []);
  });
});
