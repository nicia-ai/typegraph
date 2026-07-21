import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineGraph,
  defineNode,
  type GraphBackend,
  type TransactionBackend,
} from "../src";
import { type SqlFragment } from "../src/query/sql-fragment";
import { createInitializedStore, createTestBackend } from "./test-utils";

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

type ReadCounts = Readonly<{
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
  const counts = { targetNodeReads: 0, foldProbes: 0 };

  function countReads<T extends GraphBackend | TransactionBackend>(
    target: T,
  ): T {
    // A Proxy rather than a spread: transaction targets carry methods on a
    // prototype, and spreading one silently drops `getNodes`, which would make
    // the batch path look unprimed.
    return new Proxy(target, {
      get(source, property, receiver) {
        const value: unknown = Reflect.get(source, property, receiver);
        if (typeof value !== "function") return value;
        const method = value as (...args: unknown[]) => unknown;
        if (property === "getNode") {
          return (...args: unknown[]) => {
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

  const backend: GraphBackend = countReads({
    ...base,
    transaction: (fn, options) =>
      base.transaction((tx) => fn(countReads(tx)), options),
  } satisfies GraphBackend);

  return {
    backend,
    counts,
    reset: () => {
      counts.targetNodeReads = 0;
      counts.foldProbes = 0;
    },
  };
}

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

  it("reads the created id exactly once when resurrecting a tombstone", async () => {
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
    expect(counts.targetNodeReads).toBe(1);
  });

  it("skips the identity fold probe for generated ids", async () => {
    const { backend, counts, reset } = countingBackend("unused");
    const store = await createInitializedStore(identityGraph, backend);

    reset();
    await store.nodes.Person.create({ name: "Generated" });

    // A generated id cannot already exist under another kind, so there is
    // nothing to fold against and the probe is pure cost.
    expect(counts.foldProbes).toBe(0);
  });

  it("folds a caller-supplied id with one probe, not one per node kind", async () => {
    const { backend, counts, reset } = countingBackend("supplied");
    const store = await createInitializedStore(identityGraph, backend);

    reset();
    await store.nodes.Person.create({ name: "Supplied" }, { id: "supplied" });

    expect(counts.targetNodeReads).toBe(1);
    // Three node kinds are registered; the fold is still a single bare-id
    // lookup, which `nodes_id_idx` serves as an indexed seek.
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
