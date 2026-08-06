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

import { encodeTupleKey } from "../utils/tuple-key";
import { parseRowProps } from "./canonical-props";
import { compareStrings } from "./node-key";
import type { GraphBackend, GraphDef, Node, Store } from "./typegraph-internal";
import {
  computeSchemaHash,
  ConfigurationError,
  createStoreWithSchema,
  defineInternalGraph,
  defineNode,
  serializeSchema,
  sha256Hex,
  storeBackend,
} from "./typegraph-internal";
import { asBranchId, type BranchId, type ProvenanceRecord } from "./types";

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

const PROVENANCE_OWNER = "@nicia-ai/typegraph/merge-provenance";
const PROVENANCE_OWNER_VERSION = 1;
const PROVENANCE_OWNER_ID = "merge-provenance-owner";

/**
 * Durable ownership claim for the sidecar graph id.
 *
 * Schema equality cannot establish ownership: an application is allowed to
 * define the same `Provenance` kind at the conventional sidecar id. The marker
 * row is therefore required independently of the schema hash on every sidecar
 * created by this version.
 */
const ProvenanceOwner = defineNode("ProvenanceOwner", {
  schema: z.object({
    owner: z.literal(PROVENANCE_OWNER),
    version: z.literal(PROVENANCE_OWNER_VERSION),
    targetGraphId: z.string(),
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
function buildOwnedProvenanceGraph(targetGraphId: string) {
  return defineInternalGraph({
    id: provenanceGraphId(targetGraphId),
    nodes: {
      Provenance: { type: Provenance },
      ProvenanceOwner: { type: ProvenanceOwner },
    },
    edges: {},
  });
}

/** The schema written by releases before durable sidecar ownership markers. */
function buildProvenanceGraph(targetGraphId: string) {
  return defineInternalGraph({
    id: provenanceGraphId(targetGraphId),
    nodes: { Provenance: { type: Provenance } },
    edges: {},
  });
}

/**
 * Public view of the sidecar graph. The ownership kind is deliberately hidden:
 * it is framework metadata, not provenance data or an application collection.
 */
export type ProvenanceGraph = ReturnType<typeof buildProvenanceGraph>;

/** A persisted provenance node (the queryable record). */
export type ProvenanceNode = Node<typeof Provenance>;

/**
 * Opens — materializing the schema if needed — the provenance store for a target.
 * Pass the target Store in ordinary application code; inspection tools that do
 * not have its GraphDef may instead pass the backend and target graph id.
 *
 * Idempotent: safe to call before every persist/query, and shares the backend
 * with the target (so the caller must NOT close it separately — closing the
 * shared backend is the target owner's job).
 */
export function openProvenanceStore<G extends GraphDef>(
  target: Store<G>,
): Promise<Store<ProvenanceGraph>>;
/** Opens a provenance store for standalone inspection without a target GraphDef. */
export function openProvenanceStore(
  backend: GraphBackend,
  targetGraphId: string,
): Promise<Store<ProvenanceGraph>>;
export async function openProvenanceStore<G extends GraphDef>(
  ...args:
    | readonly [target: Store<G>]
    | readonly [backend: GraphBackend, targetGraphId: string]
): Promise<Store<ProvenanceGraph>> {
  const [backend, targetGraphId] =
    args.length === 1 ? [storeBackend(args[0]), args[0].graphId] : args;
  const graph = buildOwnedProvenanceGraph(targetGraphId);
  const activeSchema = await backend.getActiveSchema(graph.id);
  let recognizedLegacySidecar = false;
  if (activeSchema !== undefined) {
    const expectedHash = await computeSchemaHash(
      serializeSchema(graph, activeSchema.version),
    );
    if (activeSchema.schema_hash === expectedHash) {
      if (!(await hasProvenanceOwnerMarker(backend, graph.id, targetGraphId))) {
        throw provenanceGraphIdCollision(graph.id, targetGraphId);
      }
    } else {
      const legacyHash = await computeSchemaHash(
        serializeSchema(
          buildProvenanceGraph(targetGraphId),
          activeSchema.version,
        ),
      );
      recognizedLegacySidecar =
        activeSchema.schema_hash === legacyHash &&
        (await isRecognizableLegacySidecar(backend, graph.id, targetGraphId));
      if (!recognizedLegacySidecar) {
        throw provenanceGraphIdCollision(graph.id, targetGraphId);
      }
    }
  }
  const [store] = await createStoreWithSchema(graph, backend);
  if (activeSchema === undefined || recognizedLegacySidecar) {
    await store.nodes.ProvenanceOwner.upsertById(PROVENANCE_OWNER_ID, {
      owner: PROVENANCE_OWNER,
      version: PROVENANCE_OWNER_VERSION,
      targetGraphId,
    });
  }
  return store as unknown as Store<ProvenanceGraph>;
}

function provenanceGraphIdCollision(
  graphId: string,
  targetGraphId: string,
): ConfigurationError {
  return new ConfigurationError(
    `Graph id "${graphId}" is already used by an application graph and cannot host merge provenance.`,
    {
      code: "GRAPH_MERGE_PROVENANCE_ID_COLLISION",
      graphId,
      targetGraphId,
    },
    {
      suggestion:
        "Rename the colliding application graph before enabling persisted merge provenance for this target.",
    },
  );
}

async function hasProvenanceOwnerMarker(
  backend: GraphBackend,
  graphId: string,
  targetGraphId: string,
): Promise<boolean> {
  const row = await backend.getNode(
    graphId,
    "ProvenanceOwner",
    PROVENANCE_OWNER_ID,
  );
  if (row === undefined || row.deleted_at !== undefined) return false;
  const parsed = ProvenanceOwner.schema.safeParse(parseRowProps(row.props));
  return parsed.success && parsed.data.targetGraphId === targetGraphId;
}

/**
 * Recognizes a pre-marker sidecar from its actual durable contents.
 *
 * An empty legacy graph is intentionally ambiguous with an empty application
 * graph of the same shape and is refused. Non-empty legacy sidecars are
 * admitted only when every row is a valid contribution for this target and
 * its deterministic id verifies. That preserves meaningful legacy sidecars
 * without falling back to schema equality as an ownership claim.
 */
async function isRecognizableLegacySidecar(
  backend: GraphBackend,
  graphId: string,
  targetGraphId: string,
): Promise<boolean> {
  const pageSize = 500;
  let after: string | undefined;
  let rowCount = 0;

  for (;;) {
    const rows = await backend.findNodesByKind({
      graphId,
      kind: "Provenance",
      temporalMode: "includeTombstones",
      excludeDeleted: false,
      orderBy: "id",
      ...(after === undefined ? {} : { after }),
      limit: pageSize,
    });
    for (const row of rows) {
      if (row.deleted_at !== undefined) return false;
      const parsed = Provenance.schema.safeParse(parseRowProps(row.props));
      if (!parsed.success || parsed.data.targetGraphId !== targetGraphId) {
        return false;
      }
      const expectedId = await provenanceNodeId(targetGraphId, {
        role: parsed.data.role,
        canonicalId: parsed.data.canonicalId,
        canonicalKind: parsed.data.canonicalKind,
        branchId: asBranchId(parsed.data.branchId),
        sourceId: parsed.data.sourceId,
      });
      if (row.id !== expectedId) return false;
      rowCount += 1;
    }
    if (rows.length < pageSize) break;
    after = rows.at(-1)?.id;
    if (after === undefined) break;
  }

  return rowCount > 0;
}

/** Separator used by provenance ids written before tuple escaping was added. */
const ID_SEPARATOR = "\0";

/** Bytes of the SHA-256 digest kept (128 bits — collision-safe for provenance). */
const ID_DIGEST_BYTES = 16;

/**
 * The tuple that IDENTIFIES a contribution: everything {@link provenanceNodeId}
 * hashes except the target graph id, which is fixed for one merge. Two records
 * agreeing on it are one sidecar row by definition, so a caller that collapses on
 * this key collapses exactly what the row identity would have collapsed —
 * `canonicalKind` is part of it because two same-id canonicals of different kinds
 * are different entities under the `(kind, id)` identity model.
 */
export function contributionKey(record: ProvenanceRecord): string {
  return encodeProvenanceTuple([
    record.role,
    record.canonicalKind,
    record.canonicalId,
    record.branchId,
    record.sourceId,
  ]);
}

/**
 * Preserves existing provenance ids for ordinary values while making the full
 * string domain injective. JSON tuple output never contains a literal NUL, so
 * it cannot collide with the legacy form, which has one between every field.
 */
function encodeProvenanceTuple(values: readonly string[]): string {
  return values.some((value) => value.includes(ID_SEPARATOR)) ?
      encodeTupleKey(values)
    : values.join(ID_SEPARATOR);
}

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
  const tuple = encodeProvenanceTuple([
    targetGraphId,
    record.role,
    record.canonicalKind,
    record.canonicalId,
    record.branchId,
    record.sourceId,
  ]);
  const digest = await sha256Hex(tuple, ID_DIGEST_BYTES);
  return `prov_${digest}`;
}

/**
 * Upserts one `Provenance` node per record into the sidecar store, keyed by the
 * deterministic id (re-running the same merge is a no-op upsert, never a
 * duplicate). Returns the row count written. The caller wraps this for best-effort
 * behavior — a failure here must not fail an already-committed merge.
 *
 * Records that hash to the SAME id are collapsed before the batch: the id is the
 * contribution's identity, so they are one row by definition — and a single
 * `bulkUpsertById` batch cannot create the same id twice. Collapsing here is what
 * makes the returned number the rows actually written for ANY caller, whatever
 * shape its record list arrived in.
 */
export async function persistProvenanceRecords(
  store: Store<ProvenanceGraph>,
  targetGraphId: string,
  records: readonly ProvenanceRecord[],
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }
  const identified = await Promise.all(
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
  const itemsById = new Map<string, (typeof identified)[number]>();
  for (const item of identified) {
    itemsById.set(item.id, item);
  }
  const items = [...itemsById.values()];
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
