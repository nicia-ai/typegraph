import { z } from "zod";

import {
  asNodeId,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "../../../src";
import { readIdentityTransitions } from "../../../src/identity/transition-log";
import { storeRuntime } from "../../../src/store/runtime-port";
import { createTestBackend } from "../../test-utils";

export const Person = defineNode("Person", { schema: z.object({ name: z.string() }) });
export const Org = defineNode("Org", { schema: z.object({ name: z.string() }) });
export const knows = defineEdge("knows", { schema: z.object({}) });
export const graph = defineGraph({
  id: "audit_idlog_h",
  nodes: { Person: { type: Person }, Org: { type: Org } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
  identity: { sameIdAcrossKinds: "fold" },
});
export const IDS = ["a","b","c","d","e","f","g","h","i","j"];
export const ALL_REFS = IDS.flatMap((id) => [
  { kind: "Person", id },
  { kind: "Org", id },
]);
export const P = (id: string) => ({ kind: "Person" as const, id });
export const O = (id: string) => ({ kind: "Org" as const, id });
export { asNodeId };

export async function newStore(options: Record<string, unknown> = {}) {
  const [store] = await createAdapterStoreWithSchema(graph, createTestBackend(), {
    history: true,
    ...options,
  });
  return store;
}
export type TestStore = Awaited<ReturnType<typeof newStore>>;

export async function classSnapshot(store: TestStore): Promise<string> {
  const page = await store.identity.classes({ limit: 1000 });
  return page.classes
    .map((c) => c.members.map((m) => `${m.kind}:${m.id}`).toSorted().join("+"))
    .filter((s) => s.includes("+"))
    .toSorted()
    .join(" | ");
}
export async function noteCount(store: TestStore): Promise<number> {
  const ctx = storeRuntime(store).identityContext();
  const rows = await readIdentityTransitions(ctx.backend, ctx.schema, ctx.graphId, {
    classRefs: ALL_REFS,
    limit: 100000,
  });
  return rows.length;
}
export async function allRows(store: TestStore) {
  const ctx = storeRuntime(store).identityContext();
  return readIdentityTransitions(ctx.backend, ctx.schema, ctx.graphId, {
    classRefs: ALL_REFS,
    limit: 100000,
  });
}
/** run op; report membership change vs note growth */
export async function observe(label: string, store: TestStore, op: () => Promise<unknown>) {
  const before = await classSnapshot(store);
  const n0 = await noteCount(store);
  let err: unknown;
  try {
    await op();
  } catch (error) {
    err = error;
  }
  const after = await classSnapshot(store);
  const n1 = await noteCount(store);
  const changed = before !== after;
  const grew = n1 > n0;
  const flag = changed && !grew ? "MISSING-NOTE" : !changed && grew ? "SPURIOUS?" : "ok";
  console.log(`[${flag}] ${label}: classes "${before}" -> "${after}" notes ${n0}->${n1}${err ? ` ERR=${(err as Error).constructor.name}: ${(err as Error).message.slice(0, 120)}` : ""}`);
  return { changed, grew, err };
}

import { createRecordedInstant, recordedInstantRevision } from "../../../src/core/temporal";

/** Brute-force: revisions where ref's membership changed per asOfRecorded, vs. boundaries discoverable through replay/transitionsOf. */
export async function boundaryAudit(label: string, store: TestStore, refs = ALL_REFS) {
  const now = await store.recordedNow();
  if (now === undefined) return;
  const top = recordedInstantRevision(now);
  const wall = new Date().toISOString();
  const problems: string[] = [];
  for (const ref of refs) {
    let prev = "";
    const changed: number[] = [];
    for (let r = 1; r <= top; r++) {
      let cur: string;
      try {
        const members = await store.asOfRecorded(createRecordedInstant(r, wall)).identity.membersOf(ref as never);
        cur = members.map((m) => `${m.kind}:${m.id}`).toSorted().join(",");
      } catch (error) {
        cur = `ERR`;
      }
      if (cur !== prev) changed.push(r);
      prev = cur;
    }
    // Only changes where >1 member visible or leaving a multi class matter
    const discovered = new Set<number>();
    let cursor: string | undefined;
    do {
      const page = await store.identity.transitionsOf(ref as never, { limit: 2000, ...(cursor ? { cursor } : {}) } as never);
      for (const t of page.transitions) discovered.add(recordedInstantRevision(t.recorded));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    // singleton -> singleton appearance (node create) is not an identity transition; filter changes by multi-member involvement
    const multi: number[] = [];
    let p2: string[] = [];
    for (let r = 1; r <= top; r++) {
      let members: string[] = [];
      try {
        members = (await store.asOfRecorded(createRecordedInstant(r, wall)).identity.membersOf(ref as never)).map((m) => `${m.kind}:${m.id}`).toSorted();
      } catch {}
      const involved = members.length > 1 || p2.length > 1;
      if (involved && members.join(",") !== p2.join(",")) multi.push(r);
      p2 = members;
    }
    const missing = multi.filter((r) => !discovered.has(r));
    if (missing.length > 0) problems.push(`${ref.kind}:${ref.id} membership changed at ${missing.join(",")} but transitionsOf found boundaries [${[...discovered].join(",")}]`);
  }
  console.log(`[audit ${problems.length ? "FAIL" : "ok"}] ${label}${problems.length ? "\n  " + problems.join("\n  ") : ""}`);
  return problems;
}
