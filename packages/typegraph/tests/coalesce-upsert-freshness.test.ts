/**
 * `coalesceUnchangedUpserts` must be a COST optimization, never a semantic one.
 *
 * The flag's contract (see `BaseStoreOptions.coalesceUnchangedUpserts`) is that
 * an upsert which would not change the stored value performs no write. With the
 * flag OFF the same call opens a write transaction, re-reads the row there, and
 * merges the caller's props over whatever it finds — so a writer that commits
 * between the collection's first read and the write still ends with the
 * caller's props applied. `upsertById` used to decide "skip" from that FIRST
 * read, which is a strictly earlier observation: a writer landing in between
 * left the store holding ITS props while the caller was handed back a row
 * claiming the caller's own. Same call, same interleaving, two different
 * outcomes depending on a flag that is supposed to only change cost.
 *
 * The interleaving is injected rather than raced: the write is driven from
 * inside the collection's own `getNode`, immediately after it returns, so the
 * window is exercised deterministically on every run and on every backend.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { asNodeId, defineGraph, defineNode } from "../src";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../src/backend/types";
import { createStore } from "../src/store";
import { createTracingBackend } from "./trace-backend";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string(), note: z.string().optional() }),
});

const graph = defineGraph({
  id: "coalesce_upsert_freshness",
  nodes: { Person: { type: Person } },
  edges: {},
});

const ID = asNodeId<typeof Person>("subject");

/**
 * Wraps `getNode` so a competing writer commits AFTER the read observes the row
 * and BEFORE the caller acts on what it observed — the window a concurrent
 * commit occupies in production. One-shot: only the first armed read triggers
 * it, so the re-read the fix adds observes the competitor rather than causing a
 * second one.
 */
function interposingBackend(
  base: GraphBackend,
  interpose: () => Promise<void>,
): Readonly<{ backend: GraphBackend; arm: () => void; reads: () => number }> {
  let armed = false;
  let reads = 0;

  // Counting must follow the write transaction: the re-verification read runs
  // against the transaction target, so a wrapper that only decorates the
  // top-level backend would report the pre-fix round-trip count and pass either
  // way. Interposition stays on the top-level read alone — that is the
  // observation the skip decision used to be made from.
  function counted<T extends GraphBackend | TransactionBackend>(target: T): T {
    return {
      ...target,
      getNode: async (graphId: string, kind: string, id: string) => {
        reads += 1;
        return target.getNode(graphId, kind, id);
      },
    };
  }

  const backend: GraphBackend = {
    ...counted(base),
    getNode: async (graphId: string, kind: string, id: string) => {
      reads += 1;
      const row = await base.getNode(graphId, kind, id);
      if (armed) {
        armed = false;
        await interpose();
      }
      return row;
    },
    transaction: (fn, options) =>
      base.transaction((target) => fn(counted(target)), options),
  };
  return {
    backend,
    arm: () => {
      armed = true;
    },
    reads: () => reads,
  };
}

describe("coalescing upsert freshness", () => {
  let raw: GraphBackend;

  beforeEach(() => {
    ({ backend: raw } = createLocalSqliteBackend());
  });

  it("applies the caller's props when a writer commits between the read and the decision", async () => {
    // The competitor writes through the UNWRAPPED backend, so its own reads
    // never re-enter the interposition.
    const competitor = createStore(graph, raw);
    const { backend, arm } = interposingBackend(raw, async () => {
      await competitor.nodes.Person.update(ID, { name: "competitor" });
    });
    const store = createStore(graph, backend, {
      coalesceUnchangedUpserts: true,
    });

    await store.nodes.Person.create({ name: "original" }, { id: ID });

    // Re-stating the props the row already holds is exactly the case the flag
    // coalesces — and exactly the case where a skipped write loses.
    arm();
    const result = await store.nodes.Person.upsertById(ID, {
      name: "original",
    });

    expect(result.name).toBe("original");
    const stored = await store.nodes.Person.getById(ID);
    expect(stored?.name).toBe("original");
  });

  it("matches the flag-off outcome for the same interleaving", async () => {
    const competitor = createStore(graph, raw);
    const { backend, arm } = interposingBackend(raw, async () => {
      await competitor.nodes.Person.update(ID, { name: "competitor" });
    });
    const store = createStore(graph, backend);

    await store.nodes.Person.create({ name: "original" }, { id: ID });

    arm();
    await store.nodes.Person.upsertById(ID, { name: "original" });

    const stored = await store.nodes.Person.getById(ID);
    expect(stored?.name).toBe("original");
  });

  it("still coalesces — no write, original version preserved — when nothing intervenes", async () => {
    const store = createStore(graph, raw, { coalesceUnchangedUpserts: true });
    const created = await store.nodes.Person.create(
      { name: "original" },
      { id: ID },
    );

    const result = await store.nodes.Person.upsertById(ID, {
      name: "original",
    });

    // A coalesced upsert resolves with the EXISTING node: same version, same
    // updatedAt. A write would have advanced both.
    expect(result.meta.version).toBe(created.meta.version);
    expect(result.meta.updatedAt).toBe(created.meta.updatedAt);
  });

  it("still skips the write while reading the same number of rows the flag-off path does", async () => {
    // A re-stated, value-identical upsert. Flag OFF it is a real write, and its
    // cost is two reads: the collection's, plus `performNodeUpdate`'s
    // in-transaction re-read. Flag ON the second read is the SKIP decision
    // instead — same read count, no write. That equality is the point: the
    // decision was moved to where the write would have been, not merely
    // repeated, and coalescing still buys what it claims to buy.
    const plain = interposingBackend(raw, () => Promise.resolve());
    const plainStore = createStore(graph, plain.backend);
    await plainStore.nodes.Person.create({ name: "original" }, { id: ID });

    const plainBefore = plain.reads();
    await plainStore.nodes.Person.upsertById(ID, { name: "original" });
    expect(plain.reads() - plainBefore).toBe(2);

    const coalescing = interposingBackend(raw, () => Promise.resolve());
    const coalescingStore = createStore(graph, coalescing.backend, {
      coalesceUnchangedUpserts: true,
    });
    const created = await coalescingStore.nodes.Person.getById(ID);
    const cleanBefore = coalescing.reads();
    const skipped = await coalescingStore.nodes.Person.upsertById(ID, {
      name: "original",
    });
    expect(coalescing.reads() - cleanBefore).toBe(2);
    // No write: version and updatedAt are the ones the flag-off store left.
    expect(skipped.meta.version).toBe(created?.meta.version);
    expect(skipped.meta.updatedAt).toBe(created?.meta.updatedAt);
  });

  it("takes the skip decision's evidence inside a transaction, and writes nothing", async () => {
    // The structural guard behind the freshness cases above. What must hold is
    // that the read the skip rests on is taken INSIDE a transaction — on SQLite
    // that transaction is `BEGIN IMMEDIATE`, so no other writer can be between
    // the evidence and the elided write — and that the skip really is a write
    // of nothing.
    //
    // What this cannot distinguish, and does not claim to: computing the
    // verdict inside that transaction versus just after it closes. Both read
    // the same row at the same instant, and a verdict is a pure function of the
    // row, so nothing in-process can tell them apart. Deciding inside is what
    // the code does because it keeps the claim and the mechanism identical; the
    // regression this test exists to catch is the read escaping the transaction
    // altogether, which is the defect that was actually shipped.
    const trace = createTracingBackend(raw);
    const store = createStore(graph, trace.backend, {
      coalesceUnchangedUpserts: true,
    });
    await store.nodes.Person.create({ name: "original" }, { id: ID });

    trace.reset();
    await store.nodes.Person.upsertById(ID, { name: "original" });

    const begin = trace.calls.indexOf("transaction:begin");
    const commit = trace.calls.indexOf("transaction:commit");
    const decisionRead = trace.calls.indexOf("tx.getNode");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(commit).toBeGreaterThan(begin);
    // The evidence is read between BEGIN and COMMIT, not on the autocommit
    // connection before either.
    expect(decisionRead).toBeGreaterThan(begin);
    expect(decisionRead).toBeLessThan(commit);
    // And the transaction that carried it wrote nothing at all.
    expect(
      trace.calls.filter((call) => /update|insert|delete/iu.test(call)),
    ).toEqual([]);
  });

  it("resurrects rather than skipping when the row is tombstoned between read and decision", async () => {
    const competitor = createStore(graph, raw);
    const { backend, arm } = interposingBackend(raw, async () => {
      await competitor.nodes.Person.delete(ID);
    });
    const store = createStore(graph, backend, {
      coalesceUnchangedUpserts: true,
    });

    await store.nodes.Person.create({ name: "original" }, { id: ID });

    // A tombstoned row is never coalesced (an upsert over it is a
    // resurrection), so the decision must be re-derived from the row as it is
    // when the write would run, not as it was at the first read.
    arm();
    const result = await store.nodes.Person.upsertById(ID, {
      name: "original",
    });

    expect(result.name).toBe("original");
    expect(await store.nodes.Person.getById(ID)).toBeDefined();
  });
});
