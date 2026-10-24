import type { EdgeRow } from "../backend/types";
import type { GraphData } from "../interchange";
import { validateImportProperties } from "../interchange/import";
import { acyclicEdgeRelations } from "../store/acyclicity";
import { COMPOSITION_RELATION_NAME } from "../store/claims/axis";
import {
  edgeCardinalityAxisReferences,
  edgeCardinalitySpec,
} from "../store/claims/edge-claims";
import { resolveEdgeMatchIdentityStorage } from "../store/edge-match-key";
import {
  type CandidateIdentityScope,
  readCandidateIdentityClosure,
} from "./candidate-identity-closure";
import type { CandidateWriteSet } from "./candidate-write-set";
import { parseRowProps } from "./canonical-props";
import { CandidateWriteSetError } from "./errors";
import { captureMergePlanTargetFence } from "./merge";
import type { MergePlanTargetFence } from "./plan-schema";
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
  hasScopedIdentityReads,
  importGraph,
  isBackendDerivedFrom,
  sharesSerializedTransactionResource,
  storeBackend,
  storeRuntime,
} from "./typegraph-internal";
import type { MakeBackend, WorkingCopyStrategy } from "./working-copy";
import { graphWithoutNodeUniqueness } from "./working-copy";

type EntityReference = Readonly<{ kind: string; id: string }>;

/**
 * Why candidate planning stages the whole target instead of the candidate's
 * own rows. Each scope produces a correct plan; the reason names the cost.
 */
export type CandidatePlanningScopeReason =
  | "revision-tracking-disabled"
  | "composition"
  | "acyclic-relation"
  | "target-side-cardinality"
  | "missing-active-source-read"
  | "missing-match-identity-read"
  | "missing-scoped-identity-reads"
  | "match-identity-owners-unavailable"
  | "match-identity-owner-not-clone-visible"
  | "planned-evolution";

/** The rows candidate planning stages, and why when it is not the candidate's own. */
export type CandidatePlanningScope =
  Readonly<{ scope: "candidate" }> | WholeTargetPlanningScope;

/** {@link CandidatePlanningScope}'s whole-target decision. */
export type WholeTargetPlanningScope = Readonly<{
  scope: "whole-target";
  reason: CandidatePlanningScopeReason;
}>;

const CANDIDATE_SCOPE = { scope: "candidate" } as const;

export function wholeTargetPlanningScope(
  reason: CandidatePlanningScopeReason,
): WholeTargetPlanningScope {
  return { scope: "whole-target", reason };
}

/**
 * The scope a target admits before any candidate is read: the one owner of
 * candidate-planning eligibility.
 *
 * Cardinality peers use the exact claim key and holder liveness. `oneActive`
 * needs the optional active-only source read so ended history cannot make a
 * candidate lookup grow with the graph. Durable match identity requires an
 * exact keyed owner read. Ontology disjointness uses live same-id siblings.
 *
 * A target-side cardinality, an acyclic relation and composition (which is
 * both a one-whole claim and an acyclic relation) each constrain rows the
 * sparse base never reads: the holders at an edge's target endpoint, and the
 * paths between its endpoints. A graph declaring any of them plans against
 * the whole target instead.
 */
export function candidatePlanningScope<G extends GraphDef>(
  target: Store<G>,
): CandidatePlanningScope {
  if (!target.revisionTrackingEnabled)
    return wholeTargetPlanningScope("revision-tracking-disabled");
  const acyclicRelations = acyclicEdgeRelations(target.graph, target.registry);
  if (
    acyclicRelations.some(
      (relation) => relation.name === COMPOSITION_RELATION_NAME,
    )
  )
    return wholeTargetPlanningScope("composition");
  if (acyclicRelations.length > 0)
    return wholeTargetPlanningScope("acyclic-relation");
  const edges = Object.values(target.graph.edges);
  if (
    edges.some((edge) =>
      edgeCardinalityAxisReferences(edge).some(
        (axis) => axis.direction === "target",
      ),
    )
  )
    return wholeTargetPlanningScope("target-side-cardinality");
  const backend = storeBackend(target);
  if (
    backend.findActiveEdgesBySourceV1 === undefined &&
    edges.some((edge) => edge.cardinality === "oneActive")
  )
    return wholeTargetPlanningScope("missing-active-source-read");
  if (
    backend.findEdgesByMatchIdentity === undefined &&
    edges.some((edge) => edge.matchIdentity !== undefined)
  )
    return wholeTargetPlanningScope("missing-match-identity-read");
  if (
    target.graph.identity !== undefined &&
    !hasScopedIdentityReads(storeRuntime(target))
  )
    return wholeTargetPlanningScope("missing-scoped-identity-reads");
  return CANDIDATE_SCOPE;
}

/**
 * The decided scope. A candidate scope carries what seeds its sparse base: the
 * durable match-identity owners its edges name, read under `fence`.
 */
export type CandidatePlanningScopeResolution =
  | Readonly<{
      planningScope: typeof CANDIDATE_SCOPE;
      fence: MergePlanTargetFence;
      matchIdentityOwners: readonly EdgeRow[];
    }>
  | Readonly<{
      planningScope: WholeTargetPlanningScope;
    }>;

/**
 * {@link candidatePlanningScope} refined by the candidate itself. The owner
 * query controls whether sparse import sees an existing edge, so it is bound
 * to one target revision with the sparse seed; an owner that cannot be read,
 * or is excluded from the clone projection, plans against the whole target.
 */
export async function resolveCandidatePlanningScope<G extends GraphDef>(
  target: Store<G>,
  writeSet: CandidateWriteSet,
): Promise<CandidatePlanningScopeResolution> {
  const planningScope = candidatePlanningScope(target);
  if (planningScope.scope === "whole-target") return { planningScope };
  const fence = await captureMergePlanTargetFence(target);
  const owners = await readCandidateMatchIdentityOwners(target, writeSet);
  if (owners === undefined)
    return {
      planningScope: wholeTargetPlanningScope(
        "match-identity-owners-unavailable",
      ),
    };
  if (!matchIdentityOwnersAreCloneVisible(owners))
    return {
      planningScope: wholeTargetPlanningScope(
        "match-identity-owner-not-clone-visible",
      ),
    };
  return { planningScope, fence, matchIdentityOwners: owners };
}

/**
 * Reads only the durable owners named by candidate edges. `undefined` means
 * the exact lookup cannot be performed safely (for example, a custom backend
 * omits the optional capability or a candidate key cannot be derived).
 */
export async function readCandidateMatchIdentityOwners<G extends GraphDef>(
  target: Store<G>,
  writeSet: CandidateWriteSet,
): Promise<readonly EdgeRow[] | undefined> {
  const backend = storeBackend(target);
  const readOwners = backend.findEdgesByMatchIdentity;
  if (readOwners === undefined) {
    return (
        Object.values(target.graph.edges).some(
          (edge) => edge.matchIdentity !== undefined,
        )
      ) ?
        undefined
      : [];
  }
  const identities = new Map<
    string,
    Readonly<{ kind: string; name: string; key: string }>
  >();
  try {
    for (const edge of writeSet.edges) {
      const registration = target.graph.edges[edge.kind];
      if (registration === undefined) return undefined;
      const validatedProperties = validateImportProperties(
        edge.properties,
        registration.type.schema,
        "allow",
      );
      if (!validatedProperties.success) return undefined;
      const identity = resolveEdgeMatchIdentityStorage(
        registration.matchIdentity,
        {
          fromKind: edge.from.kind,
          fromId: edge.from.id,
          toKind: edge.to.kind,
          toId: edge.to.id,
          props: validatedProperties.data,
        },
        { graphId: target.graphId, edgeKind: edge.kind },
      );
      if (identity === undefined) continue;
      identities.set(JSON.stringify([edge.kind, identity.name, identity.key]), {
        kind: edge.kind,
        name: identity.name,
        key: identity.key,
      });
    }
  } catch {
    // Let the full-clone/import path own malformed candidate validation.
    return undefined;
  }
  if (identities.size === 0) return [];
  return readOwners({
    graphId: target.graphId,
    identities: [...identities.values()],
  });
}

/** Whether every returned owner is included in the default clone projection. */
export function matchIdentityOwnersAreCloneVisible(
  owners: readonly EdgeRow[],
): boolean {
  return owners.every((owner) => owner.deleted_at === undefined);
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
  matchIdentityOwners: readonly EdgeRow[],
): Promise<
  Readonly<{ document: GraphData; identityScope?: CandidateIdentityScope }>
> {
  const backend = storeBackend(target);
  const verdict = batchPointReadVerdict(backend);
  const edgesById = await getEdgeRowsByIds(
    backend,
    verdict,
    target.graphId,
    writeSet.edges.map((edge) => edge.id),
  );
  const cardinalityReads = new Map<
    string,
    Parameters<GraphBackend["findEdgesByKind"]>[0]
  >();
  const activeReads = new Map<
    string,
    Parameters<NonNullable<GraphBackend["findActiveEdgesBySourceV1"]>>[0]
  >();
  function addActiveRead(
    edgeKind: string,
    fromKind: string,
    fromId: string,
  ): void {
    activeReads.set(JSON.stringify([edgeKind, fromKind, fromId]), {
      graphId: target.graphId,
      edgeKind,
      fromKind,
      fromId,
    });
  }
  for (const edge of writeSet.edges) {
    const cardinality = target.graph.edges[edge.kind]?.cardinality ?? "many";
    if (cardinality === "many") continue;
    const spec = edgeCardinalitySpec({ direction: "source", cardinality });
    if (spec.holderLiveness === "liveAndActive") {
      addActiveRead(edge.kind, edge.from.kind, edge.from.id);
      continue;
    }
    const exactPair = spec.keyShape === "fromAndTo";
    const read = {
      graphId: target.graphId,
      kind: edge.kind,
      fromKind: edge.from.kind,
      fromId: edge.from.id,
      ...(exactPair ? { toKind: edge.to.kind, toId: edge.to.id } : {}),
      excludeDeleted: true,
      orderBy: "id" as const,
    };
    cardinalityReads.set(
      JSON.stringify([
        edge.kind,
        edge.from.kind,
        edge.from.id,
        ...(exactPair ? [edge.to.kind, edge.to.id] : []),
      ]),
      read,
    );
  }
  for (const edge of edgesById.values()) {
    if (target.graph.edges[edge.kind]?.cardinality === "oneActive")
      addActiveRead(edge.kind, edge.from_kind, edge.from_id);
  }
  const relevantEdgesById = new Map(edgesById);
  for (const edge of matchIdentityOwners) {
    relevantEdgesById.set(edge.id, edge);
  }
  for (const read of cardinalityReads.values()) {
    for (const edge of await backend.findEdgesByKind(read))
      relevantEdgesById.set(edge.id, edge);
  }
  const readActive = backend.findActiveEdgesBySourceV1;
  if (readActive === undefined) {
    if (activeReads.size > 0)
      throw new CandidateWriteSetError(
        "Bounded oneActive planning requires an active-only source read.",
      );
  } else {
    for (const read of activeReads.values()) {
      for (const edge of await readActive(read))
        relevantEdgesById.set(edge.id, edge);
    }
  }
  const references = new Map<string, EntityReference>();
  function add(reference: EntityReference): void {
    references.set(referenceKey(reference), reference);
  }
  for (const node of writeSet.nodes) add(node);
  for (const edge of writeSet.edges) {
    add(edge.from);
    add(edge.to);
  }
  for (const edge of relevantEdgesById.values()) {
    if (edge.deleted_at !== undefined) continue;
    add({ kind: edge.from_kind, id: edge.from_id });
    add({ kind: edge.to_kind, id: edge.to_id });
  }
  for (const assertion of writeSet.identity?.assertions ?? []) {
    add(assertion.a);
    add(assertion.b);
    if (assertion.endedBy !== undefined) add(assertion.endedBy);
  }
  if (target.graph.ontology.length > 0 && target.graph.identity === undefined) {
    const ids = [...new Set([...references.values()].map((ref) => ref.id))];
    for (const peer of await storeRuntime(target).liveNodesSharingIds(
      ids,
      backend,
    ))
      add(peer);
  }
  const identityClosure =
    target.graph.identity === undefined ?
      undefined
    : await readCandidateIdentityClosure(target, backend, {
        references: [...references.values()],
        ...(writeSet.identity === undefined ?
          {}
        : {
            assertionIds: writeSet.identity.assertions.map(
              (assertion) => assertion.id,
            ),
          }),
        includeArchival: false,
      });
  for (const reference of identityClosure?.cloneReferences ?? [])
    add(reference);
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
  for (const row of relevantEdgesById.values()) {
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
    document: {
      formatVersion: "2.0",
      exportedAt: "1970-01-01T00:00:00.000Z",
      source: { type: "external", description: "bounded candidate baseline" },
      nodes,
      edges,
      ...(identityClosure === undefined ?
        {}
      : {
          identity: {
            profile: "typegraph-identity-v1",
            mode: "state",
            assertions: [...identityClosure.cloneState],
          },
        }),
    },
    ...(identityClosure === undefined ?
      {}
    : {
        identityScope: {
          baseState: identityClosure.baseState,
          cloneState: identityClosure.cloneState,
        },
      }),
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
 * The scope accessor exposes the same target identity projection used to seed
 * the copy, so the subsequent diff compares one bounded baseline.
 */
export function sparseCandidateWorkingCopyStrategy<G extends GraphDef>(
  writeSet: CandidateWriteSet,
  makeBackend: MakeBackend,
  matchIdentityOwners: readonly EdgeRow[],
): Readonly<{
  strategy: WorkingCopyStrategy<G>;
  identityScope: () => CandidateIdentityScope | undefined;
}> {
  let scopedIdentity: CandidateIdentityScope | undefined;
  return {
    strategy: {
      create: async (target) => {
        const { document, identityScope } = await sparseBaseDocument(
          target,
          writeSet,
          matchIdentityOwners,
        );
        scopedIdentity = identityScope;
        const backend = await makeBackend();
        // An aliased backend still belongs to the target. Refuse it before
        // cleanup takes ownership of independently allocated backends.
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
    },
    identityScope: () => scopedIdentity,
  };
}

export function boundedCandidateKeys(
  writeSet: CandidateWriteSet,
): LineageDelta {
  return candidateKeys(writeSet);
}
