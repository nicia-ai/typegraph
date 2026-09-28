import type { GraphData } from "../interchange";
import type { CandidateWriteSet } from "./candidate-write-set";
import { parseRowProps } from "./canonical-props";
import { CandidateWriteSetError } from "./errors";
import type {
  GraphBackend,
  GraphDef,
  LineageDelta,
  Store,
} from "./typegraph-internal";
import {
  batchPointReadVerdict,
  canonicalizeDatabaseTimestamp,
  createStoreWithSchema,
  getEdgeRowsByIds,
  getNodeRowsByIds,
  importGraph,
  isBackendDerivedFrom,
  sharesSerializedTransactionResource,
  storeBackend,
} from "./typegraph-internal";
import type { MakeBackend, WorkingCopyStrategy } from "./working-copy";
import { graphWithoutNodeUniqueness } from "./working-copy";

type EntityReference = Readonly<{ kind: string; id: string }>;

/**
 * Only constraints whose import checks are local to the candidate's row ids
 * can be checked against a sparse clone. Cardinality and durable edge match
 * identity can inspect other edges, while ontology can add cross-kind claims.
 */
export function canUseSparseCandidatePlanning<G extends GraphDef>(
  target: Store<G>,
): boolean {
  return (
    target.revisionTrackingEnabled &&
    target.graph.identity === undefined &&
    target.graph.ontology.length === 0 &&
    Object.values(target.graph.edges).every(
      (edge) =>
        (edge.cardinality ?? "many") === "many" &&
        edge.matchIdentity === undefined,
    )
  );
}

function referenceKey(reference: EntityReference): string {
  return JSON.stringify([reference.kind, reference.id]);
}

function canonicalTimestamp(value: unknown): string {
  const timestamp = canonicalizeDatabaseTimestamp(value);
  if (timestamp === undefined) {
    throw new CandidateWriteSetError(
      "A committed candidate peer has an invalid stored timestamp.",
    );
  }
  return timestamp;
}

function candidateKeys(writeSet: CandidateWriteSet): LineageDelta {
  return {
    kind: "keys",
    nodes: writeSet.nodes.map((node) => ({ kind: node.kind, id: node.id })),
    edges: writeSet.edges.map((edge) => ({ kind: edge.kind, id: edge.id })),
  };
}

/** The exact node/edge rows whose prior state changes candidate import semantics. */
async function sparseBaseDocument<G extends GraphDef>(
  target: Store<G>,
  writeSet: CandidateWriteSet,
): Promise<GraphData> {
  const backend = storeBackend(target);
  const verdict = batchPointReadVerdict(backend);
  const edgesById = await getEdgeRowsByIds(
    backend,
    verdict,
    target.graphId,
    writeSet.edges.map((edge) => edge.id),
  );
  const references = new Map<string, EntityReference>();
  function add(reference: EntityReference): void {
    references.set(referenceKey(reference), reference);
  }
  for (const node of writeSet.nodes) add(node);
  for (const edge of writeSet.edges) {
    add(edge.from);
    add(edge.to);
  }
  for (const edge of edgesById.values()) {
    if (edge.deleted_at !== undefined) continue;
    add({ kind: edge.from_kind, id: edge.from_id });
    add({ kind: edge.to_kind, id: edge.to_id });
  }
  const idsByKind = new Map<string, string[]>();
  for (const reference of references.values()) {
    const ids = idsByKind.get(reference.kind) ?? [];
    ids.push(reference.id);
    idsByKind.set(reference.kind, ids);
  }
  const nodes: GraphData["nodes"] = [];
  for (const [kind, ids] of idsByKind) {
    const rows = await getNodeRowsByIds(
      backend,
      verdict,
      target.graphId,
      kind,
      ids,
    );
    for (const row of rows.values()) {
      if (row.deleted_at !== undefined) continue;
      nodes.push({
        kind: row.kind,
        id: row.id,
        properties: parseRowProps(row.props),
        validFrom:
          row.valid_from === undefined ?
            null
          : canonicalTimestamp(row.valid_from),
        ...(row.valid_to === undefined ?
          {}
        : { validTo: canonicalTimestamp(row.valid_to) }),
        meta: {
          version: row.version,
          createdAt: canonicalTimestamp(row.created_at),
          updatedAt: canonicalTimestamp(row.updated_at),
        },
      });
    }
  }
  const edges: GraphData["edges"] = [];
  for (const row of edgesById.values()) {
    if (row.deleted_at !== undefined) continue;
    edges.push({
      kind: row.kind,
      id: row.id,
      from: { kind: row.from_kind, id: row.from_id },
      to: { kind: row.to_kind, id: row.to_id },
      properties: parseRowProps(row.props),
      validFrom:
        row.valid_from === undefined ?
          null
        : canonicalTimestamp(row.valid_from),
      ...(row.valid_to === undefined ?
        {}
      : { validTo: canonicalTimestamp(row.valid_to) }),
      meta: {
        createdAt: canonicalTimestamp(row.created_at),
        updatedAt: canonicalTimestamp(row.updated_at),
      },
    });
  }
  return {
    formatVersion: "2.0",
    exportedAt: "1970-01-01T00:00:00.000Z",
    source: { type: "external", description: "bounded candidate baseline" },
    nodes,
    edges,
  };
}

function assertIndependentBackend(
  targetBackend: GraphBackend,
  candidateBackend: GraphBackend,
): void {
  if (
    targetBackend === candidateBackend ||
    isBackendDerivedFrom(targetBackend, candidateBackend) ||
    isBackendDerivedFrom(candidateBackend, targetBackend) ||
    sharesSerializedTransactionResource(targetBackend, candidateBackend)
  ) {
    throw new CandidateWriteSetError(
      "The transient candidate backend must be independent of the target backend.",
    );
  }
}

/**
 * A disposable working copy seeded only with candidate rows and references.
 * Identity-enabled graphs keep the full clone until scoped ledger reads can
 * establish the complete affected identity closure.
 */
export function sparseCandidateWorkingCopyStrategy<G extends GraphDef>(
  writeSet: CandidateWriteSet,
  makeBackend: MakeBackend,
): WorkingCopyStrategy<G> {
  return {
    create: async (target) => {
      const document = await sparseBaseDocument(target, writeSet);
      const backend = await makeBackend();
      // An aliased backend still belongs to the target. Refuse it before the
      // cleanup scope takes ownership of independently allocated backends.
      assertIndependentBackend(storeBackend(target), backend);
      try {
        const [store] = await createStoreWithSchema(
          graphWithoutNodeUniqueness(target.graph),
          backend,
          {
            revisionTracking: target.revisionTrackingEnabled,
            revisionJournal: false,
          },
        );
        const imported = await importGraph(store, document, {
          onConflict: "error",
          onUnknownProperty: "allow",
          validateReferences: true,
          refreshStatistics: false,
        });
        if (!imported.success) {
          throw new CandidateWriteSetError(
            "Unable to seed candidate peers into the transient staging store.",
            { details: { errors: imported.errors } },
          );
        }
        return store;
      } catch (error) {
        try {
          await backend.close();
        } catch {
          // Preserve the staging failure.
        }
        throw error;
      }
    },
  };
}

export function boundedCandidateKeys(
  writeSet: CandidateWriteSet,
): LineageDelta {
  return candidateKeys(writeSet);
}
