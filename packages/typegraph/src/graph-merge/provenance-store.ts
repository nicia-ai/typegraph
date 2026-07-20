/**
 * Sidecar provenance graph — durable, queryable `{branch, sourceId}` → canonical
 * tagging for a merge (open-item #5: "on-graph provenance persistence").
 *
 * The merge's in-memory {@link import("./types").ProvenanceIndex}
 * (`report.provenance.byBranch`) evaporates after the call. This module persists the
 * same contributions as TYPED nodes in a SIDECAR graph on the SAME backend as the
 * merge target — a separate graph (its own `graphId`-namespaced tables), so the
 * user's domain schema is untouched. It is a faithful prototype of a future
 * first-class TypeGraph `annotations` primitive (see `docs/design/annotations.md`).
 *
 * Persistence is POST-COMMIT and best-effort, by design: the merge's commit path is
 * unchanged and stays on the same public store/backend contracts. Provenance is derived and
 * re-runnable, and the node ids are DETERMINISTIC (a hash of `{targetGraphId, role,
 * canonicalKind, canonicalId, branchId, sourceId}`), so re-merging the same forks UPSERTS rather
 * than duplicating. Atomic-in-the-merge-transaction is a possible upgrade later
 * (TypeGraph's cross-store `withTransaction`), deliberately deferred for v1.
 */

import { z } from "zod";

import { compareStrings } from "./node-key";
import type { GraphDef, Node, Store } from "./typegraph-internal";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
  sha256Hex,
  storeBackend,
} from "./typegraph-internal";
import type { BranchId, ProvenanceRecord } from "./types";

/** The Provenance node: one row per `{branch, sourceId}` → canonical contribution. */
const Provenance = defineNode("Provenance", {
  schema: z.object({
    targetGraphId: z.string(),
    role: z.enum(["node", "edge"]),
    canonicalId: z.string(),
    canonicalKind: z.string(),
    branchId: z.string(),
    sourceId: z.string(),
  }),
});

/**
 * Derives the sidecar graph id for a target graph. Suffixing the target's own id
 * keeps each target graph's provenance in its own `graphId`-namespaced tables on a
 * shared backend, while a single `Provenance` schema serves all of them.
 */
export function provenanceGraphId(targetGraphId: string): string {
  return `${targetGraphId}::merge-provenance`;
}

/** Builds the sidecar provenance graph definition for a target graph. */
function buildProvenanceGraph(targetGraphId: string) {
  return defineGraph({
    id: provenanceGraphId(targetGraphId),
    nodes: { Provenance: { type: Provenance } },
    edges: {},
  });
}

/** The concrete sidecar provenance graph type. */
export type ProvenanceGraph = ReturnType<typeof buildProvenanceGraph>;

/** A persisted provenance node (the queryable record). */
export type ProvenanceNode = Node<typeof Provenance>;

/**
 * Opens — materializing the schema if needed — the provenance store for a target
 * store. Idempotent: safe to call before every persist/query, and shares the
 * backend with the target (so the caller must NOT close it
 * separately — closing the shared backend is the target owner's job).
 */
export async function openProvenanceStore<G extends GraphDef>(
  target: Store<G>,
): Promise<Store<ProvenanceGraph>> {
  const [store] = await createStoreWithSchema(
    buildProvenanceGraph(target.graphId),
    storeBackend(target),
  );
  return store;
}

/** Null byte — cannot occur in a normal id, so an unambiguous tuple separator. */
const ID_SEPARATOR = "\0";

/** Bytes of the SHA-256 digest kept (128 bits — collision-safe for provenance). */
const ID_DIGEST_BYTES = 16;

/**
 * Deterministic provenance node id: a hash of the contribution tuple, so
 * re-persisting the same contribution UPSERTS the same row (idempotent re-runs).
 *
 * Uses the shared {@link sha256Hex} (Web Crypto) instead of `node:crypto` so the
 * `graph-merge` entry point stays importable on every runtime the library
 * targets (Cloudflare Workers, Deno, browsers) — `base-version.ts` already hashes
 * its content fingerprint the same way.
 */
export async function provenanceNodeId(
  targetGraphId: string,
  record: ProvenanceRecord,
): Promise<string> {
  const tuple = [
    targetGraphId,
    record.role,
    // canonicalKind is part of node identity: two contributions to different-kind
    // canonicals that share a bare id (e.g. base Patient:x and Encounter:x) must NOT
    // hash to the same sidecar row and clobber each other (the (kind,id) identity model).
    record.canonicalKind,
    record.canonicalId,
    record.branchId,
    record.sourceId,
  ].join(ID_SEPARATOR);
  const digest = await sha256Hex(tuple, ID_DIGEST_BYTES);
  return `prov_${digest}`;
}

/**
 * Upserts one `Provenance` node per record into the sidecar store, keyed by the
 * deterministic id (re-running the same merge is a no-op upsert, never a
 * duplicate). Returns the row count written. The caller wraps this for best-effort
 * behavior — a failure here must not fail an already-committed merge.
 */
export async function persistProvenanceRecords(
  store: Store<ProvenanceGraph>,
  targetGraphId: string,
  records: readonly ProvenanceRecord[],
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }
  const items = await Promise.all(
    records.map(async (record) => ({
      id: await provenanceNodeId(targetGraphId, record),
      props: {
        targetGraphId,
        role: record.role,
        canonicalId: record.canonicalId,
        canonicalKind: record.canonicalKind,
        branchId: record.branchId,
        sourceId: record.sourceId,
      },
    })),
  );
  await store.nodes.Provenance.bulkUpsertById(items);
  return items.length;
}

/** Filter for {@link readProvenance}. Each field, when set, narrows the result. */
export type ProvenanceQuery = Readonly<{
  branchId?: BranchId | string;
  canonicalId?: string;
  role?: "node" | "edge";
}>;

/**
 * Reads persisted provenance back, filtered and stably ordered. The sidecar is a
 * normal typed graph, so this is a thin ergonomic wrapper over
 * `store.nodes.Provenance.find()` (filtered in memory — provenance volumes are
 * modest; a query-builder `where` is the scale path). Answers "which canonical
 * entities did branch X contribute to?" and "who contributed canonical Y?".
 */
export async function readProvenance(
  store: Store<ProvenanceGraph>,
  query: ProvenanceQuery = {},
): Promise<readonly ProvenanceNode[]> {
  const all = await store.nodes.Provenance.find();
  return all
    .filter(
      (node) =>
        (query.branchId === undefined || node.branchId === query.branchId) &&
        (query.canonicalId === undefined ||
          node.canonicalId === query.canonicalId) &&
        (query.role === undefined || node.role === query.role),
    )
    .sort((left, right) => compareStrings(left.id, right.id));
}
