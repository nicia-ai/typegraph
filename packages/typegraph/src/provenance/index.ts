import type { EdgeRow, NodeRow } from "../backend/types";
import type { GraphDef } from "../core/define-graph";
import type { NodeRegistration } from "../core/types";
import { ConfigurationError, NodeNotFoundError } from "../errors";
import type {
  DynamicNodeCollection,
  HistorySafeTransactionBackend,
  HistoryStore,
  HistoryTransactionContext,
} from "../store";
import {
  applyNodeResurrect,
  applyNodeSoftDelete,
} from "../store/operations/node-write-pipeline";
import { lockRecordedGraphWrite } from "../store/recorded-capture";
import { isPlainObject } from "../utils/object";

const DEFAULT_RETRACTED_FIELD = "retracted";
const KEY_SEPARATOR = "\u0000";

type NodeKind<G extends GraphDef> = Extract<keyof G["nodes"], string>;
type EdgeKind<G extends GraphDef> = Extract<keyof G["edges"], string>;

export type ProvenanceNodeRef<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
> = Readonly<{
  kind: K;
  id: string;
}>;

export type ProvenanceJustificationRef<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
> = ProvenanceNodeRef<G, K>;
export type ProvenanceFactRef<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
> = ProvenanceNodeRef<G, K>;

type ProvenanceSourceConfig<G extends GraphDef = GraphDef> =
  | Readonly<{
      kind: NodeKind<G>;
      retractedField?: string;
    }>
  | Readonly<{
      kinds: readonly NodeKind<G>[];
      retractedField?: string;
    }>;

export type ProvenanceRetractionConfig<G extends GraphDef = GraphDef> =
  Readonly<{
    source: ProvenanceSourceConfig<G>;
    justification: Readonly<{ kind: NodeKind<G> }>;
    fact: Readonly<{ kinds: readonly NodeKind<G>[] }>;
    premiseOf: Readonly<{ kind: EdgeKind<G> }>;
    derives: Readonly<{ kind: EdgeKind<G> }>;
  }>;

type SourceKindsFromConfig<
  G extends GraphDef,
  C extends ProvenanceRetractionConfig<G>,
> =
  C["source"] extends Readonly<{ kind: infer K }> ? Extract<K, NodeKind<G>>
  : C["source"] extends Readonly<{ kinds: readonly (infer K)[] }> ?
    Extract<K, NodeKind<G>>
  : NodeKind<G>;

type FactKindsFromConfig<
  G extends GraphDef,
  C extends ProvenanceRetractionConfig<G>,
> =
  C["fact"] extends Readonly<{ kinds: readonly (infer K)[] }> ?
    Extract<K, NodeKind<G>>
  : NodeKind<G>;

type JustificationKindFromConfig<
  G extends GraphDef,
  C extends ProvenanceRetractionConfig<G>,
> =
  C["justification"] extends Readonly<{ kind: infer K }> ?
    Extract<K, NodeKind<G>>
  : NodeKind<G>;

export type SurvivedVia<
  G extends GraphDef = GraphDef,
  FactKind extends NodeKind<G> = NodeKind<G>,
  JustificationKind extends NodeKind<G> = NodeKind<G>,
> = Readonly<{
  fact: ProvenanceFactRef<G, FactKind>;
  via: readonly ProvenanceJustificationRef<G, JustificationKind>[];
}>;

export type RetractionReport<
  G extends GraphDef = GraphDef,
  FactKind extends NodeKind<G> = NodeKind<G>,
  JustificationKind extends NodeKind<G> = NodeKind<G>,
> = Readonly<{
  died: readonly ProvenanceFactRef<G, FactKind>[];
  survivedVia: readonly SurvivedVia<G, FactKind, JustificationKind>[];
  unaffected: readonly ProvenanceFactRef<G, FactKind>[];
}>;

export type RetractionCapability<
  G extends GraphDef = GraphDef,
  SourceKind extends NodeKind<G> = NodeKind<G>,
  FactKind extends NodeKind<G> = NodeKind<G>,
  JustificationKind extends NodeKind<G> = NodeKind<G>,
> = Readonly<{
  retract: (
    source: ProvenanceNodeRef<G, SourceKind>,
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  retractMany: (
    sources: readonly ProvenanceNodeRef<G, SourceKind>[],
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  unRetract: (
    source: ProvenanceNodeRef<G, SourceKind>,
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  unRetractMany: (
    sources: readonly ProvenanceNodeRef<G, SourceKind>[],
  ) => Promise<RetractionReport<G, FactKind, JustificationKind>>;
  holding: () => Promise<readonly ProvenanceFactRef<G, FactKind>[]>;
}>;

type NormalizedConfig = Readonly<{
  sourceKinds: readonly string[];
  retractedField: string;
  justificationKind: string;
  factKinds: readonly string[];
  premiseOfKind: string;
  derivesKind: string;
}>;

type ProvenanceRows = Readonly<{
  justifications: ReadonlyMap<string, NodeRow>;
  facts: ReadonlyMap<string, NodeRow>;
  premiseEdges: readonly EdgeRow[];
  deriveEdges: readonly EdgeRow[];
}>;

type SupportEdges = Readonly<{
  premisesByJustification: ReadonlyMap<string, readonly string[]>;
  factsByJustification: ReadonlyMap<string, readonly string[]>;
  justificationsByPremise: ReadonlyMap<string, readonly string[]>;
}>;

type SupportSnapshot = Readonly<{
  facts: ReadonlyMap<string, NodeRow>;
  supportedFactKeys: ReadonlySet<string>;
  believedFactKeys: ReadonlySet<string>;
  firingJustificationKeysByFact: ReadonlyMap<string, readonly string[]>;
  affectedFactKeys: (source: ProvenanceNodeRef) => ReadonlySet<string>;
}>;

type SourceRetractedState = "retracted" | "available";

type SourceRow<G extends GraphDef> = Readonly<{
  source: ProvenanceNodeRef<G>;
  row: NodeRow;
}>;

function refKey(ref: ProvenanceNodeRef): string {
  return `${ref.kind}${KEY_SEPARATOR}${ref.id}`;
}

function rowKey(row: Pick<NodeRow, "kind" | "id">): string {
  return refKey({ kind: row.kind, id: row.id });
}

function edgeFromKey(edge: EdgeRow): string {
  return refKey({ kind: edge.from_kind, id: edge.from_id });
}

function edgeToKey(edge: EdgeRow): string {
  return refKey({ kind: edge.to_kind, id: edge.to_id });
}

function keyToRef<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
>(key: string): ProvenanceNodeRef<G, K> {
  const separatorIndex = key.indexOf(KEY_SEPARATOR);
  if (separatorIndex === -1) {
    throw new ConfigurationError(
      "Invalid provenance identity key.",
      { key },
      {
        suggestion:
          "Report this TypeGraph provenance bug with the graph roles that produced the key.",
      },
    );
  }
  const kind = key.slice(0, separatorIndex);
  const id = key.slice(separatorIndex + KEY_SEPARATOR.length);
  return { kind, id } as ProvenanceNodeRef<G, K>;
}

function sortedReferences<
  G extends GraphDef = GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
>(keys: Iterable<string>): ProvenanceNodeRef<G, K>[] {
  return [...keys]
    .toSorted((left, right) => left.localeCompare(right))
    .map((key) => keyToRef<G, K>(key));
}

function parseNodeProps(row: NodeRow): Record<string, unknown> {
  const parsed = JSON.parse(row.props) as unknown;
  if (!isPlainObject(parsed)) {
    throw new ConfigurationError(
      `Node ${row.kind}/${row.id} props are not an object.`,
      { kind: row.kind, id: row.id },
    );
  }
  return parsed;
}

function sourceRetractedState(
  row: NodeRow,
  retractedField: string,
): SourceRetractedState {
  const props = parseNodeProps(row);
  const value = props[retractedField];
  if (value === undefined) return "available";
  if (typeof value !== "boolean") {
    throw new ConfigurationError(
      `Provenance source field "${retractedField}" must contain a boolean value.`,
      { kind: row.kind, id: row.id, field: retractedField },
      {
        suggestion:
          "Use a source node schema with a boolean retracted flag, for example z.boolean().default(false).",
      },
    );
  }
  return value ? "retracted" : "available";
}

function normalizeConfig<G extends GraphDef>(
  graph: G,
  config: ProvenanceRetractionConfig<G>,
): NormalizedConfig {
  const sourceKinds = sourceKindsFromConfig(config.source);
  const justificationKind = config.justification.kind;
  const factKinds = [...config.fact.kinds];
  const premiseOfKind = config.premiseOf.kind;
  const derivesKind = config.derives.kind;
  const retractedField =
    config.source.retractedField ?? DEFAULT_RETRACTED_FIELD;

  if (sourceKinds.length === 0) {
    throw new ConfigurationError(
      "Provenance retraction requires at least one source kind.",
      { role: "source" },
    );
  }

  if (factKinds.length === 0) {
    throw new ConfigurationError(
      "Provenance retraction requires at least one fact kind.",
      { role: "fact" },
    );
  }

  const duplicateSourceKinds = duplicateValues(sourceKinds);
  if (duplicateSourceKinds.length > 0) {
    throw new ConfigurationError("Provenance source kinds must be unique.", {
      duplicateSourceKinds,
    });
  }

  const duplicateFactKinds = duplicateValues(factKinds);
  if (duplicateFactKinds.length > 0) {
    throw new ConfigurationError("Provenance fact kinds must be unique.", {
      duplicateFactKinds,
    });
  }

  for (const kind of sourceKinds) assertNodeKind(graph, kind, "source");
  assertNodeKind(graph, justificationKind, "justification");
  for (const kind of factKinds) assertNodeKind(graph, kind, "fact");
  for (const kind of sourceKinds)
    assertSourceField(graph, kind, retractedField);
  assertEdgeKind(graph, premiseOfKind, "premiseOf");
  assertEdgeKind(graph, derivesKind, "derives");

  if (
    factKinds.some(
      (kind) => sourceKinds.includes(kind) || kind === justificationKind,
    )
  ) {
    throw new ConfigurationError(
      "Provenance fact kinds must be distinct from source and justification kinds.",
      { sourceKinds, justificationKind, factKinds },
    );
  }

  assertEdgeEndpoints(graph, premiseOfKind, {
    role: "premiseOf",
    fromKinds: sourceKinds,
    toKinds: [justificationKind],
  });
  assertEdgeEndpoints(graph, derivesKind, {
    role: "derives",
    fromKinds: [justificationKind],
    toKinds: factKinds,
  });

  return {
    sourceKinds,
    retractedField,
    justificationKind,
    factKinds,
    premiseOfKind,
    derivesKind,
  };
}

function sourceKindsFromConfig<G extends GraphDef>(
  source: ProvenanceSourceConfig<G>,
): string[] {
  if ("kinds" in source) return [...source.kinds];
  return [source.kind];
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }
  return [...duplicates].toSorted((left, right) => left.localeCompare(right));
}

function assertNodeKind<G extends GraphDef>(
  graph: G,
  kind: string,
  role: string,
): void {
  if (Object.hasOwn(graph.nodes, kind)) return;
  throw new ConfigurationError(
    `Provenance ${role} kind "${kind}" is not a node kind in this graph.`,
    { role, kind, graphId: graph.id },
  );
}

function assertEdgeKind<G extends GraphDef>(
  graph: G,
  kind: string,
  role: string,
): void {
  if (Object.hasOwn(graph.edges, kind)) return;
  throw new ConfigurationError(
    `Provenance ${role} kind "${kind}" is not an edge kind in this graph.`,
    { role, kind, graphId: graph.id },
  );
}

function assertSourceField<G extends GraphDef>(
  graph: G,
  sourceKind: string,
  retractedField: string,
): void {
  const registration = graph.nodes[sourceKind];
  if (registration === undefined) return;
  if (Object.hasOwn(registration.type.schema.shape, retractedField)) return;
  throw new ConfigurationError(
    `Provenance source kind "${sourceKind}" must include field "${retractedField}".`,
    { sourceKind, retractedField },
    {
      suggestion:
        "Add a boolean retracted flag to the source node schema or pass source.retractedField.",
    },
  );
}

function assertEdgeEndpoints<G extends GraphDef>(
  graph: G,
  edgeKind: string,
  expected: Readonly<{
    role: string;
    fromKinds: readonly string[];
    toKinds: readonly string[];
  }>,
): void {
  const registration = graph.edges[edgeKind];
  if (registration === undefined) return;
  const fromKinds = new Set(registration.from.map((node) => node.kind));
  const toKinds = new Set(registration.to.map((node) => node.kind));
  for (const kind of expected.fromKinds) {
    if (fromKinds.has(kind)) continue;
    throw new ConfigurationError(
      `Provenance ${expected.role} edge "${edgeKind}" cannot start at "${kind}".`,
      { edgeKind, role: expected.role, expectedFrom: kind },
    );
  }
  for (const kind of expected.toKinds) {
    if (toKinds.has(kind)) continue;
    throw new ConfigurationError(
      `Provenance ${expected.role} edge "${edgeKind}" cannot end at "${kind}".`,
      { edgeKind, role: expected.role, expectedTo: kind },
    );
  }
}

async function findNodeRows(
  backend: HistorySafeTransactionBackend,
  graphId: string,
  kind: string,
  includeTombstones: boolean,
): Promise<readonly NodeRow[]> {
  return backend.findNodesByKind({
    graphId,
    kind,
    excludeDeleted: !includeTombstones,
    temporalMode: includeTombstones ? "includeTombstones" : "includeEnded",
    orderBy: "id",
  });
}

async function findEdgeRows(
  backend: HistorySafeTransactionBackend,
  graphId: string,
  kind: string,
): Promise<readonly EdgeRow[]> {
  return backend.findEdgesByKind({
    graphId,
    kind,
    excludeDeleted: true,
    temporalMode: "includeEnded",
    orderBy: "id",
  });
}

async function readRoles(
  backend: HistorySafeTransactionBackend,
  graphId: string,
  config: NormalizedConfig,
): Promise<ProvenanceRows> {
  const [justificationRows, factRowsByKind, premiseEdges, deriveEdges] =
    await Promise.all([
      findNodeRows(backend, graphId, config.justificationKind, false),
      Promise.all(
        config.factKinds.map((kind) =>
          findNodeRows(backend, graphId, kind, true),
        ),
      ),
      findEdgeRows(backend, graphId, config.premiseOfKind),
      findEdgeRows(backend, graphId, config.derivesKind),
    ]);
  const factRows = factRowsByKind.flat();

  return {
    justifications: rowsByKey(justificationRows),
    facts: rowsByKey(factRows),
    premiseEdges,
    deriveEdges,
  };
}

function rowsByKey(rows: readonly NodeRow[]): ReadonlyMap<string, NodeRow> {
  const byKey = new Map<string, NodeRow>();
  for (const row of rows) byKey.set(rowKey(row), row);
  return byKey;
}

function appendGroupedValue(
  groups: Map<string, string[]>,
  key: string,
  value: string,
): void {
  const group = groups.get(key);
  if (group === undefined) {
    groups.set(key, [value]);
    return;
  }
  if (group.includes(value)) return;
  group.push(value);
}

function buildSupportEdges(
  config: NormalizedConfig,
  rows: ProvenanceRows,
): SupportEdges {
  const premisesByJustification = new Map<string, string[]>();
  const factsByJustification = new Map<string, string[]>();
  const justificationsByPremise = new Map<string, string[]>();

  for (const edge of rows.premiseEdges) {
    if (edge.to_kind !== config.justificationKind) continue;
    if (!isPremiseKind(config, edge.from_kind)) continue;

    const premiseKey = edgeFromKey(edge);
    const justificationKey = edgeToKey(edge);
    appendGroupedValue(premisesByJustification, justificationKey, premiseKey);
    appendGroupedValue(justificationsByPremise, premiseKey, justificationKey);
  }

  for (const edge of rows.deriveEdges) {
    if (edge.from_kind !== config.justificationKind) continue;
    if (!config.factKinds.includes(edge.to_kind)) continue;
    appendGroupedValue(
      factsByJustification,
      edgeFromKey(edge),
      edgeToKey(edge),
    );
  }

  return {
    premisesByJustification,
    factsByJustification,
    justificationsByPremise,
  };
}

/**
 * The whole-graph read a support computation needs: the role rows, the support
 * edges derived from them, and the (non-retracted-visible) source rows. Loaded
 * once per transition so `before` and `after` snapshots share one read instead
 * of scanning the entire provenance graph twice — the graph structure is
 * identical across a transition, only source availability changes.
 */
type SupportGraph = Readonly<{
  roles: ProvenanceRows;
  supportEdges: SupportEdges;
  sourceRows: readonly NodeRow[];
}>;

async function loadSupportGraph(
  backend: HistorySafeTransactionBackend,
  graphId: string,
  config: NormalizedConfig,
): Promise<SupportGraph> {
  const roles = await readRoles(backend, graphId, config);
  const supportEdges = buildSupportEdges(config, roles);
  const sourceRowsByKind = await Promise.all(
    config.sourceKinds.map((kind) =>
      findNodeRows(backend, graphId, kind, false),
    ),
  );
  return { roles, supportEdges, sourceRows: sourceRowsByKind.flat() };
}

function availableSourceKeys(
  sourceRows: readonly NodeRow[],
  retractedField: string,
): Set<string> {
  const available = new Set<string>();
  for (const row of sourceRows) {
    if (sourceRetractedState(row, retractedField) === "available") {
      available.add(rowKey(row));
    }
  }
  return available;
}

/**
 * The pure TMS fixpoint: given the loaded graph and the set of available
 * (non-retracted) source keys, derive which facts are supported and believed.
 * No I/O — the same {@link SupportGraph} feeds both the pre- and post-transition
 * snapshots with different availability sets.
 */
function computeSupportSnapshot(
  graph: Pick<SupportGraph, "roles" | "supportEdges">,
  available: ReadonlySet<string>,
): SupportSnapshot {
  const { roles, supportEdges } = graph;
  const supported = new Set<string>();
  const inSet = new Set<string>(available);
  const firingJustifications = new Set<string>();
  const firingJustificationKeysByFact = new Map<string, string[]>();

  let changed = true;
  while (changed) {
    changed = false;
    for (const [justificationKey] of roles.justifications) {
      if (firingJustifications.has(justificationKey)) continue;
      const premises =
        supportEdges.premisesByJustification.get(justificationKey) ?? [];
      if (!allPremisesSupported(premises, inSet)) continue;

      firingJustifications.add(justificationKey);
      const derivedFacts =
        supportEdges.factsByJustification.get(justificationKey) ?? [];
      for (const factKey of derivedFacts) {
        if (!roles.facts.has(factKey)) continue;
        appendGroupedValue(
          firingJustificationKeysByFact,
          factKey,
          justificationKey,
        );
        if (supported.has(factKey)) continue;
        supported.add(factKey);
        inSet.add(factKey);
        changed = true;
      }
    }
  }

  const believed = new Set<string>();
  for (const key of supported) {
    const row = roles.facts.get(key);
    if (row !== undefined && row.deleted_at === undefined) believed.add(key);
  }

  return {
    facts: roles.facts,
    supportedFactKeys: supported,
    believedFactKeys: believed,
    firingJustificationKeysByFact,
    affectedFactKeys(target: ProvenanceNodeRef): ReadonlySet<string> {
      return computeAffectedFactKeys(target, roles, supportEdges);
    },
  };
}

async function computeSupport(
  backend: HistorySafeTransactionBackend,
  graphId: string,
  config: NormalizedConfig,
): Promise<SupportSnapshot> {
  const graph = await loadSupportGraph(backend, graphId, config);
  return computeSupportSnapshot(
    graph,
    availableSourceKeys(graph.sourceRows, config.retractedField),
  );
}

function isPremiseKind(config: NormalizedConfig, kind: string): boolean {
  return config.sourceKinds.includes(kind) || config.factKinds.includes(kind);
}

function allPremisesSupported(
  premises: readonly string[],
  supported: ReadonlySet<string>,
): boolean {
  for (const premise of premises) {
    if (!supported.has(premise)) return false;
  }
  return true;
}

function computeAffectedFactKeys(
  source: ProvenanceNodeRef,
  roles: ProvenanceRows,
  supportEdges: SupportEdges,
): ReadonlySet<string> {
  const affected = new Set<string>();
  const frontier = [refKey(source)];
  const seen = new Set<string>(frontier);

  while (frontier.length > 0) {
    const current = frontier.shift();
    if (current === undefined) continue;

    const justifications =
      supportEdges.justificationsByPremise.get(current) ?? [];
    for (const justificationKey of justifications) {
      const derivedFacts =
        supportEdges.factsByJustification.get(justificationKey) ?? [];
      for (const factKey of derivedFacts) {
        if (!roles.facts.has(factKey)) continue;
        affected.add(factKey);
        if (seen.has(factKey)) continue;
        seen.add(factKey);
        frontier.push(factKey);
      }
    }
  }

  return affected;
}

function buildReport<
  G extends GraphDef,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  before: SupportSnapshot,
  after: SupportSnapshot,
  sources: readonly ProvenanceNodeRef<G>[],
): RetractionReport<G, FactKind, JustificationKind> {
  const affected = affectedFactKeysForSources(after, sources);
  const believedBefore = [...before.believedFactKeys];
  const died = sortedReferences<G, FactKind>(
    believedBefore.filter((key) => !after.supportedFactKeys.has(key)),
  );
  const unaffected = sortedReferences<G, FactKind>(
    believedBefore.filter((key) => !affected.has(key)),
  );
  const survivedVia = [...affected]
    .filter((key) => after.supportedFactKeys.has(key))
    .toSorted((left, right) => left.localeCompare(right))
    .map((key) => ({
      fact: keyToRef<G, FactKind>(key),
      via: sortedReferences<G, JustificationKind>(
        after.firingJustificationKeysByFact.get(key) ?? [],
      ),
    }));
  return { died, survivedVia, unaffected };
}

function affectedFactKeysForSources(
  snapshot: SupportSnapshot,
  sources: readonly ProvenanceNodeRef[],
): ReadonlySet<string> {
  const affected = new Set<string>();
  for (const source of sources) {
    for (const factKey of snapshot.affectedFactKeys(source)) {
      affected.add(factKey);
    }
  }
  return affected;
}

async function synchronizeFactCurrency<G extends GraphDef>(
  backend: HistorySafeTransactionBackend,
  store: HistoryStore<G>,
  graphId: string,
  config: NormalizedConfig,
  snapshot: SupportSnapshot,
): Promise<void> {
  for (const [key, row] of snapshot.facts) {
    if (snapshot.supportedFactKeys.has(key)) {
      if (row.deleted_at === undefined) continue;
      await reopenFactCurrency(backend, store, graphId, row);
      continue;
    }
    if (row.deleted_at !== undefined) continue;
    await closeFactCurrency(backend, store, graphId, config, row);
  }
}

function getFactRegistration<G extends GraphDef>(
  store: HistoryStore<G>,
  row: NodeRow,
): NodeRegistration {
  const registration = store.graph.nodes[row.kind];
  if (registration !== undefined) return registration;
  throw new ConfigurationError(
    `Provenance fact kind "${row.kind}" is not a node kind in this graph.`,
    { kind: row.kind, graphId: store.graphId },
  );
}

async function closeFactCurrency<G extends GraphDef>(
  backend: HistorySafeTransactionBackend,
  store: HistoryStore<G>,
  graphId: string,
  config: NormalizedConfig,
  row: NodeRow,
): Promise<void> {
  await store.runNodeOperationHooks("delete", row.kind, row.id, async () => {
    const registration = getFactRegistration(store, row);
    // The canonical soft-delete cascade (delete-behavior enforcement, tombstone,
    // uniqueness/embedding/fulltext cleanup), told to treat this fact's own
    // provenance edges as non-structural so they survive for a later reopen.
    await applyNodeSoftDelete(
      { graphId, registry: store.registry },
      {
        kind: row.kind,
        id: row.id,
        schema: registration.type.schema,
        existingProps: parseNodeProps(row),
        uniqueConstraints: registration.unique ?? [],
        onDelete: registration.onDelete,
      },
      backend,
      {
        isNonStructuralEdge: (edge) =>
          isFactCurrencyProvenanceEdge(config, row, edge),
      },
    );
  });
}

async function reopenFactCurrency<G extends GraphDef>(
  backend: HistorySafeTransactionBackend,
  store: HistoryStore<G>,
  graphId: string,
  row: NodeRow,
): Promise<void> {
  await store.runNodeOperationHooks("update", row.kind, row.id, async () => {
    const registration = getFactRegistration(store, row);
    // The delete removed this fact's uniqueness entries, so reopen re-checks and
    // re-inserts them (rather than the diff-based update path) before clearing
    // the tombstone and re-syncing embeddings/fulltext.
    await applyNodeResurrect(
      { graphId, registry: store.registry },
      {
        kind: row.kind,
        id: row.id,
        schema: registration.type.schema,
        props: parseNodeProps(row),
        uniqueConstraints: registration.unique ?? [],
      },
      backend,
    );
  });
}

function isFactCurrencyProvenanceEdge(
  config: NormalizedConfig,
  row: NodeRow,
  edge: EdgeRow,
): boolean {
  if (
    edge.kind === config.derivesKind &&
    edge.from_kind === config.justificationKind &&
    edge.to_kind === row.kind &&
    edge.to_id === row.id
  ) {
    return true;
  }

  return (
    edge.kind === config.premiseOfKind &&
    edge.from_kind === row.kind &&
    edge.from_id === row.id &&
    edge.to_kind === config.justificationKind
  );
}

function getTransactionNodeCollection<G extends GraphDef>(
  tx: HistoryTransactionContext<G>,
  kind: string,
): DynamicNodeCollection {
  const collections = tx.nodes as unknown as Readonly<
    Record<string, DynamicNodeCollection | undefined>
  >;
  const collection = collections[kind];
  if (collection !== undefined) return collection;
  throw new ConfigurationError(
    `Provenance source kind "${kind}" is not available on this transaction.`,
    { kind },
  );
}

async function setSourceRetractionState<G extends GraphDef>(
  tx: HistoryTransactionContext<G>,
  config: NormalizedConfig,
  source: ProvenanceNodeRef,
  retracted: boolean,
): Promise<void> {
  const collection = getTransactionNodeCollection(tx, source.kind);
  await collection.update(source.id, { [config.retractedField]: retracted });
}

async function runTransition<
  G extends GraphDef,
  SourceKind extends NodeKind<G>,
  FactKind extends NodeKind<G>,
  JustificationKind extends NodeKind<G>,
>(
  store: HistoryStore<G>,
  config: NormalizedConfig,
  sources: readonly ProvenanceNodeRef<G, SourceKind>[],
  retracted: boolean,
): Promise<RetractionReport<G, FactKind, JustificationKind>> {
  const uniqueSources = uniqueNodeReferences(sources);
  for (const source of uniqueSources) {
    if (config.sourceKinds.includes(source.kind)) continue;
    throw new ConfigurationError(
      `Provenance retraction source must be one of: ${config.sourceKinds.join(", ")}.`,
      { expectedKinds: config.sourceKinds, actualKind: source.kind },
    );
  }

  return store.transaction(async (tx) => {
    await lockRecordedGraphWrite(tx.backend, store.graphId);
    const rows = await Promise.all(
      uniqueSources.map((source) =>
        tx.backend.getNode(store.graphId, source.kind, source.id),
      ),
    );
    const sourceRows = uniqueSources.map((source, index): SourceRow<G> => {
      const sourceRow = rows[index];
      if (sourceRow === undefined || sourceRow.deleted_at !== undefined) {
        throw new NodeNotFoundError(source.kind, source.id);
      }
      return { source, row: sourceRow };
    });

    // Load the provenance graph once. Its structure (justifications, facts,
    // premise/derive edges) is identical before and after the transition — only
    // source availability changes — so the pre- and post-flip snapshots share
    // this read instead of scanning the whole graph twice per retraction.
    const supportGraph = await loadSupportGraph(
      tx.backend,
      store.graphId,
      config,
    );
    const availableBefore = availableSourceKeys(
      supportGraph.sourceRows,
      config.retractedField,
    );
    const before = computeSupportSnapshot(supportGraph, availableBefore);

    const nextState: SourceRetractedState =
      retracted ? "retracted" : "available";
    const availableAfter = new Set(availableBefore);
    for (const { source, row } of sourceRows) {
      const currentState = sourceRetractedState(row, config.retractedField);
      if (currentState === nextState) continue;
      await setSourceRetractionState(tx, config, source, retracted);
      // Mirror the flip in the in-memory availability so `after` matches the
      // source rows now persisted, without re-reading the whole graph.
      if (nextState === "available") {
        availableAfter.add(refKey(source));
      } else {
        availableAfter.delete(refKey(source));
      }
    }
    const after = computeSupportSnapshot(supportGraph, availableAfter);
    await synchronizeFactCurrency(
      tx.backend,
      store,
      store.graphId,
      config,
      after,
    );
    return buildReport<G, FactKind, JustificationKind>(
      before,
      after,
      uniqueSources,
    );
  });
}

function uniqueNodeReferences<
  G extends GraphDef,
  K extends NodeKind<G> = NodeKind<G>,
>(references: readonly ProvenanceNodeRef<G, K>[]): ProvenanceNodeRef<G, K>[] {
  const byKey = new Map<string, ProvenanceNodeRef<G, K>>();
  for (const reference of references) {
    byKey.set(refKey(reference), reference);
  }
  return [...byKey.values()];
}

export function createRetractionCapability<
  G extends GraphDef,
  const C extends ProvenanceRetractionConfig<G>,
>(
  store: HistoryStore<G>,
  config: C,
): RetractionCapability<
  G,
  SourceKindsFromConfig<G, C>,
  FactKindsFromConfig<G, C>,
  JustificationKindFromConfig<G, C>
> {
  const historyEnabled = (store as Readonly<{ historyEnabled: boolean }>)
    .historyEnabled;
  if (!historyEnabled) {
    throw new ConfigurationError(
      "createRetractionCapability requires a store created with { history: true }.",
      { graphId: store.graphId },
      {
        suggestion:
          "Use createStoreWithSchema(graph, backend, { history: true }) so retraction mutations are captured and queryable with asOfRecorded().",
      },
    );
  }
  const normalized = normalizeConfig(store.graph, config);

  return {
    retract(source) {
      return runTransition<
        G,
        SourceKindsFromConfig<G, C>,
        FactKindsFromConfig<G, C>,
        JustificationKindFromConfig<G, C>
      >(store, normalized, [source], true);
    },

    retractMany(sources) {
      return runTransition<
        G,
        SourceKindsFromConfig<G, C>,
        FactKindsFromConfig<G, C>,
        JustificationKindFromConfig<G, C>
      >(store, normalized, sources, true);
    },

    unRetract(source) {
      return runTransition<
        G,
        SourceKindsFromConfig<G, C>,
        FactKindsFromConfig<G, C>,
        JustificationKindFromConfig<G, C>
      >(store, normalized, [source], false);
    },

    unRetractMany(sources) {
      return runTransition<
        G,
        SourceKindsFromConfig<G, C>,
        FactKindsFromConfig<G, C>,
        JustificationKindFromConfig<G, C>
      >(store, normalized, sources, false);
    },

    async holding() {
      return store.transaction(async (tx) => {
        await lockRecordedGraphWrite(tx.backend, store.graphId);
        const snapshot = await computeSupport(
          tx.backend,
          store.graphId,
          normalized,
        );
        return sortedReferences<G, FactKindsFromConfig<G, C>>(
          snapshot.believedFactKeys,
        );
      });
    },
  };
}
