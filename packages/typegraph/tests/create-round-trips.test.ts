import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  type CompiledRowsSql,
  DatabaseOperationError,
  defineGraph,
  defineNode,
  type GraphBackend,
  type TransactionBackend,
} from "../src";
import { deriveBackend } from "../src/backend/derive-backend";
import type { UpdateNodeParams } from "../src/backend/types";
import { type SqlFragment } from "../src/query/sql-fragment";
import {
  createInitializedStore,
  createTestBackend,
  expectAuditedBackend,
  expectImmutableLowerBoundRefusal,
} from "./test-utils";

const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
const Author = defineNode("Author", {
  schema: z.object({ penName: z.string() }),
});
const Company = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});

const nodes = {
  Person: { type: Person },
  Author: { type: Author },
  Company: { type: Company },
} as const;

const plainGraph = defineGraph({
  id: "create_round_trips_plain",
  nodes,
  edges: {},
});

const identityGraph = defineGraph({
  id: "create_round_trips_identity",
  nodes,
  edges: {},
  identity: { sameIdAcrossKinds: "fold" },
});

const PEER_RESURRECTION_VALID_FROM = "2024-01-01T00:00:00.000Z";
const RACED_RESURRECTION_VALID_FROM = "2023-06-01T00:00:00.000Z";

type ReadCounts = Readonly<{
  /** All `getNode` probes, including generated ids unknown to the test. */
  allNodeReads: number;
  /** `getNode` probes issued for the node being created. */
  targetNodeReads: number;
  /** Bare-id cross-kind fold probes issued by identity. */
  foldProbes: number;
}>;

/**
 * Counts the reads a write path issues, through both the outer backend and the
 * transaction target writes actually run against.
 *
 * The create path's cost is dominated by these probes and a redundant one is
 * easy to reintroduce — nothing else in the suite would notice, because a
 * duplicate read changes no observable result.
 */
function isFoldProbe(compiled: SqlFragment): boolean {
  const text = compiled.chunks
    .map((chunk) => (chunk.kind === "text" ? chunk.value : ""))
    .join("");
  return (
    text.includes("SELECT kind, id") && text.includes("deleted_at IS NULL")
  );
}

function countingBackend(targetId: string): Readonly<{
  backend: GraphBackend;
  counts: ReadCounts;
  reset: () => void;
}> {
  const base = createTestBackend();
  const counts = { allNodeReads: 0, targetNodeReads: 0, foldProbes: 0 };

  function countTransactionReads(
    target: TransactionBackend,
  ): TransactionBackend {
    // A Proxy rather than a spread for TRANSACTION targets: their methods live
    // on a prototype, and spreading one silently drops `getNodes`, which would
    // make the batch path look unprimed. A transaction-scoped backend is
    // unaudited by construction, so a fresh object loses nothing.
    return new Proxy(target, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (property === "getNode") {
          return (...args: unknown[]) => {
            counts.allNodeReads += 1;
            if (args[2] === targetId) counts.targetNodeReads += 1;
            return method.apply(source, args);
          };
        }
        if (property === "execute") {
          return (...args: unknown[]) => {
            if (isFoldProbe(args[0] as SqlFragment)) counts.foldProbes += 1;
            return method.apply(source, args);
          };
        }
        return value;
      },
    });
  }

  // The ROOT backend goes through the seam instead of a second Proxy. A
  // hand-rolled Proxy is a distinct object and the serialized-resource audit is
  // WeakMap-keyed, so wrapping a derived backend in one discards the verdict
  // `deriveBackend` just carried — exactly the loss the spread had.
  const backend: GraphBackend = deriveBackend(base, {
    getNode: (graphId: string, kind: string, id: string) => {
      counts.allNodeReads += 1;
      if (id === targetId) counts.targetNodeReads += 1;
      return base.getNode(graphId, kind, id);
    },
    execute: <T>(query: CompiledRowsSql): Promise<readonly T[]> => {
      if (isFoldProbe(query)) counts.foldProbes += 1;
      return base.execute<T>(query);
    },
    transaction: (fn, options) =>
      base.transaction((tx) => fn(countTransactionReads(tx)), options),
  });

  return {
    backend,
    counts,
    reset: () => {
      counts.allNodeReads = 0;
      counts.targetNodeReads = 0;
      counts.foldProbes = 0;
    },
  };
}

function peerResurrectionBackend(targetId: string): GraphBackend {
  const base = createTestBackend();
  return deriveBackend(base, {
    transaction: (fn, options) =>
      base.transaction((transactionTarget) => {
        let peerInjected = false;
        const racingTarget = new Proxy(transactionTarget, {
          get(source, property, receiver) {
            const value: unknown = Reflect.get(source, property, receiver);
            if (property !== "updateNode" || typeof value !== "function") {
              return value;
            }
            const updateNode = value as (
              params: Parameters<GraphBackend["updateNode"]>[0],
            ) => ReturnType<GraphBackend["updateNode"]>;
            return async (
              params: Parameters<GraphBackend["updateNode"]>[0],
            ) => {
              if (
                !peerInjected &&
                params.id === targetId &&
                params.clearDeleted === true
              ) {
                peerInjected = true;
                await updateNode.call(source, {
                  ...params,
                  props: { name: "Peer" },
                  validFrom: PEER_RESURRECTION_VALID_FROM,
                });
              }
              try {
                return await updateNode.call(source, params);
              } catch (error) {
                if (
                  error instanceof DatabaseOperationError &&
                  error.details.reason === "no_row_returned"
                ) {
                  throw new DatabaseOperationError(
                    "Backend-specific zero-row update",
                    error.details,
                    { cause: error },
                  );
                }
                throw error;
              }
            };
          },
        });
        return fn(racingTarget);
      }, options),
  });
}

/**
 * A backend whose transaction target loses TWO races, in the one order that
 * makes a resurrecting upsert's `clearDeleted` statement match a row its own
 * read judged LIVE:
 *
 *  1. a peer resurrects the tombstone between the collection's probe and
 *     `performNodeUpdate`'s read, stamping the window itself, so that read finds
 *     a live row and the window guard measures the row's STORED lower bound;
 *  2. the peer re-tombstones it before the UPDATE, so `deleted_at IS NOT NULL`
 *     matches after all instead of affecting zero rows and falling through to
 *     the resurrection recovery.
 *
 * Both peer writes are real calls against the same target — the state
 * transitions a competitor would commit, not a masked read.
 */
function resurrectThenRetombstoneBackend(targetId: string): GraphBackend {
  const base = createTestBackend();
  return deriveBackend(base, {
    transaction: (fn, options) =>
      base.transaction((transactionTarget) => {
        let peerResurrected = false;
        let peerReTombstoned = false;
        const racingTarget = new Proxy(transactionTarget, {
          get(source, property, receiver) {
            const value: unknown = Reflect.get(source, property, receiver);
            if (typeof value !== "function") return value;
            if (property === "getNode") {
              const getNode = value as TransactionBackend["getNode"];
              return async (graphId: string, kind: string, id: string) => {
                const row = await getNode(graphId, kind, id);
                if (
                  peerResurrected ||
                  id !== targetId ||
                  row?.deleted_at === undefined
                ) {
                  return row;
                }
                peerResurrected = true;
                await transactionTarget.updateNode({
                  graphId,
                  kind,
                  id,
                  props: { name: "Peer" },
                  clearDeleted: true,
                  validFrom: RACED_RESURRECTION_VALID_FROM,
                });
                return getNode(graphId, kind, id);
              };
            }
            if (property === "updateNode") {
              const updateNode = value as TransactionBackend["updateNode"];
              return async (params: UpdateNodeParams) => {
                if (
                  !peerReTombstoned &&
                  params.id === targetId &&
                  params.clearDeleted === true
                ) {
                  peerReTombstoned = true;
                  await transactionTarget.deleteNode({
                    graphId: params.graphId,
                    kind: params.kind,
                    id: params.id,
                  });
                }
                return updateNode(params);
              };
            }
            return value;
          },
        });
        return fn(racingTarget);
      }, options),
  });
}

describe("the read-counting double itself", () => {
  it("stays on the base's serialized resource", () => {
    // The double is what every case below runs against, so if it reads as
    // unowned the suite exercises write paths whose import/clone guards have
    // lost their subject. Neither the `tests/**` lint block nor the type-aware
    // scanner can see the shape that loses it — a hand-rolled Proxy over the
    // derived backend is a distinct object and the audit is WeakMap-keyed — so
    // the verdict is asserted at runtime here.
    const { backend } = countingBackend("target");
    expect(expectAuditedBackend(backend)).toBe("serialized");
  });
});

describe("create-path round trips", () => {
  it("reads the created id exactly once on a plain graph", async () => {
    const { backend, counts, reset } = countingBackend("solo");
    const store = await createInitializedStore(plainGraph, backend);

    reset();
    await store.nodes.Person.create({ name: "Solo" }, { id: "solo" });

    // One probe answers both questions the create path asks: is the id taken,
    // and is it a tombstone to resurrect.
    expect(counts.targetNodeReads).toBe(1);
  });

  it("re-checks a tombstone immediately before resurrection", async () => {
    const { backend, counts, reset } = countingBackend("gone");
    const store = await createInitializedStore(plainGraph, backend);
    const gone = await store.nodes.Person.create(
      { name: "Gone" },
      { id: "gone" },
    );
    await store.nodes.Person.delete(gone.id);

    reset();
    const revived = await store.nodes.Person.create(
      { name: "Back" },
      { id: "gone" },
    );

    expect(revived.name).toBe("Back");
    // The second read is isolated to the rare resurrection branch. It prevents
    // a stale preparation result from overwriting a peer resurrection.
    expect(counts.targetNodeReads).toBe(2);
  });

  it("does not overwrite a peer resurrection between re-read and update", async () => {
    const store = await createInitializedStore(
      plainGraph,
      peerResurrectionBackend("contended"),
    );
    const original = await store.nodes.Person.create(
      { name: "Original" },
      { id: "contended" },
    );
    await store.nodes.Person.delete(original.id);

    await expect(
      store.nodes.Person.create({ name: "Late writer" }, { id: "contended" }),
    ).rejects.toThrow(/already exists/u);
  });

  it("lets an upsert overwrite a peer resurrection without replacing its validity window", async () => {
    const store = await createInitializedStore(
      plainGraph,
      peerResurrectionBackend("contended-upsert"),
    );
    const original = await store.nodes.Person.create(
      { name: "Original" },
      { id: "contended-upsert" },
    );
    await store.nodes.Person.delete(original.id);

    // No stated lower bound, so the recovery re-run is an ordinary update: the
    // peer owns the revived row's window and this writer owns its props.
    const revived = await store.nodes.Person.upsertById("contended-upsert", {
      name: "Late writer",
    });

    expect(revived.name).toBe("Late writer");
    expect(revived.meta.validFrom).toBe(PEER_RESURRECTION_VALID_FROM);
  });

  it("refuses an upsert that loses a resurrection race while stating its own validFrom", async () => {
    // The recovery path converts a lost resurrection into an ordinary update of
    // the peer's now-live row, and an ordinary update cannot store a lower
    // bound. This case asserted that the stated bound was dropped and the props
    // applied anyway; the write now refuses instead of quietly landing under a
    // window the caller did not ask for.
    const store = await createInitializedStore(
      plainGraph,
      peerResurrectionBackend("contended-refused"),
    );
    const original = await store.nodes.Person.create(
      { name: "Original" },
      { id: "contended-refused" },
    );
    await store.nodes.Person.delete(original.id);

    await expectImmutableLowerBoundRefusal(
      store.nodes.Person.upsertById(
        "contended-refused",
        { name: "Late writer" },
        { validFrom: "2025-01-01T00:00:00.000Z" },
      ),
    );

    // Nothing landed. The refusal rolls its transaction back, and the simulated
    // peer's resurrection is injected INSIDE that transaction, so the row is
    // left tombstoned rather than revived — which is also the proof the late
    // writer's props did not half-apply.
    expect(await store.nodes.Person.getById(original.id)).toBeUndefined();
  });

  it("keeps the bound it accepted when the resurrection target is read live", async () => {
    const store = await createInitializedStore(
      plainGraph,
      resurrectThenRetombstoneBackend("raced-resurrection"),
    );
    const original = await store.nodes.Person.create(
      { name: "Original" },
      { id: "raced-resurrection" },
    );
    await store.nodes.Person.delete(original.id);

    // The peer's bound restated verbatim: the guard sees a live row, compares
    // the stated bound against the stored one, and ACCEPTS it. An accepted
    // option is applied, so the row must come back carrying it — the leg cannot
    // state a resurrection decision it never reached and write the bound away
    // as SQL NULL.
    const revived = await store.nodes.Person.upsertById(
      "raced-resurrection",
      { name: "Late writer" },
      { validFrom: RACED_RESURRECTION_VALID_FROM },
    );

    expect(revived.name).toBe("Late writer");
    expect(revived.meta.validFrom).toBe(RACED_RESURRECTION_VALID_FROM);
  });

  it("skips the identity fold probe for generated ids", async () => {
    const { backend, counts, reset } = countingBackend("unused");
    const store = await createInitializedStore(identityGraph, backend);

    reset();
    await store.nodes.Person.create({ name: "Generated" });

    // A generated id cannot already exist under another kind, so there is
    // nothing to find under the same or another kind. Both probes are pure
    // network cost on the successful create path.
    expect(counts.allNodeReads).toBe(0);
    expect(counts.foldProbes).toBe(0);
  });

  it("folds a caller-supplied id with one probe, not one per node kind", async () => {
    const { backend, counts, reset } = countingBackend("supplied");
    const store = await createInitializedStore(identityGraph, backend);

    reset();
    await store.nodes.Person.create({ name: "Supplied" }, { id: "supplied" });

    expect(counts.targetNodeReads).toBe(1);
    // Three node kinds are registered; the fold is still a single bare-id
    // lookup, which `typegraph_nodes_id_idx` serves as an indexed seek.
    expect(counts.foldProbes).toBe(1);
  });

  it("keeps batch creates at one fold probe regardless of batch size", async () => {
    const { backend, counts, reset } = countingBackend("batch-0");
    const store = await createInitializedStore(identityGraph, backend);

    reset();
    await store.nodes.Person.bulkInsert(
      Array.from({ length: 25 }, (_unused, index) => ({
        props: { name: `Person ${index}` },
        id: `batch-${index}`,
      })),
    );

    // Batch preparation primes existence through one `getNodes` per kind, so
    // the per-row `getNode` fallback must never fire.
    expect(counts.targetNodeReads).toBe(0);
    expect(counts.foldProbes).toBe(1);
  });
});
