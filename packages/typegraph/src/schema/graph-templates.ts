import type { GraphBackend, SchemaVersionRow } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { resolveGraphVectorSlots } from "../core/embedding";
import { ConfigurationError } from "../errors";
import { type ReconciledSchema } from "../store/store";
import { activeSchemaHash } from "./manager";
import { computeSchemaHash, serializeSchema } from "./serializer";

/** A locally held handle for a durable server-side graph template. */
export type GraphTemplate<G extends GraphDef> = Readonly<{
  id: string;
  reconciled: ReconciledSchema<G>;
  /** Content hash of the template's schema document, in this release's serialization. */
  schemaHash: string;
  /**
   * The hash the template registry keys this template under, which
   * instantiation binds. It equals `schemaHash` unless an earlier release
   * registered the template: the registry keeps the hash that release
   * computed, and the stored document is judged equal to `schemaHash`
   * through `activeSchemaHash` rather than rewritten. Absent means
   * `schemaHash`.
   */
  registryHash?: string;
}>;

export type InstantiateGraphTemplateResult<G extends GraphDef> = Readonly<{
  status: "ready";
  reconciled: ReconciledSchema<G>;
  schema: SchemaVersionRow;
}>;

/**
 * Registers the fully materialized shape of a verified store as a durable
 * template. The original schema version is retained only as snapshot
 * provenance: every instantiated graph starts at v1 with that final shape.
 */
export async function registerGraphTemplate<G extends GraphDef>(
  backend: GraphBackend,
  params: Readonly<{ templateId: string; reconciled: ReconciledSchema<G> }>,
): Promise<GraphTemplate<G>> {
  const register = backend.registerGraphTemplate;
  if (register === undefined) throw graphTemplatesUnsupportedError(backend);
  await backend.assertBaseSchemaCurrent?.();
  const { reconciled } = params;
  if (reconciled.version === undefined || reconciled.hash === undefined) {
    throw new ConfigurationError(
      "A graph template requires a reconciled schema from a managed or verified Store.",
      { code: "GRAPH_TEMPLATE_REQUIRES_RECONCILED_SCHEMA" },
    );
  }
  if (
    resolveGraphVectorSlots(reconciled.graph).length > 0 &&
    backend.capabilities.vector?.supported === true
  ) {
    throw new ConfigurationError(
      "Graph templates do not support embedding fields because vector storage is graph-scoped and cannot be instantiated schema-only.",
      {
        code: "GRAPH_TEMPLATE_VECTOR_UNSUPPORTED",
        graphId: reconciled.graph.id,
      },
      {
        suggestion:
          "Provision the graph through createStoreWithSchema until template instantiation can atomically materialize vector contributions.",
      },
    );
  }
  const schemaDocument = serializeSchema(reconciled.graph, reconciled.version);
  const schemaHash = await computeSchemaHash(schemaDocument);
  if (schemaHash !== reconciled.hash) {
    throw new ConfigurationError(
      "Reconciled schema hash does not match its graph snapshot.",
      { code: "GRAPH_TEMPLATE_RECONCILED_HASH_MISMATCH" },
    );
  }
  const stored = await register({
    templateId: params.templateId,
    schemaHash,
    schemaDoc: schemaDocument,
  });
  if (!(await storedSchemaMatches(stored, schemaHash))) {
    throw new ConfigurationError(
      `Graph template "${params.templateId}" already exists with different schema content.`,
      {
        code: "GRAPH_TEMPLATE_CONTENT_CONFLICT",
        templateId: params.templateId,
      },
    );
  }
  return Object.freeze({
    id: params.templateId,
    reconciled,
    schemaHash,
    registryHash: stored.schema_hash,
  });
}

/**
 * Whether a stored template or schema row holds the schema `schemaHash`
 * names. The column is checked first because it is equal whenever this
 * release wrote the row; a row an earlier release wrote is judged by its
 * document, through the one owner every stored-version comparison reads.
 */
async function storedSchemaMatches(
  row: Readonly<{ schema_hash: string; schema_doc: string }>,
  schemaHash: string,
): Promise<boolean> {
  return (
    row.schema_hash === schemaHash ||
    (await activeSchemaHash(row)) === schemaHash
  );
}

/**
 * Instantiates the template's final graph shape as target schema v1. Only the
 * target hash crosses the wire; the durable source document stays in the
 * backend template registry and is rebound to `graphId` by one SQL statement.
 */
export async function instantiateGraphTemplate<G extends GraphDef>(
  backend: GraphBackend,
  params: Readonly<{ template: GraphTemplate<G>; graphId: string }>,
): Promise<InstantiateGraphTemplateResult<G>> {
  const instantiate = backend.instantiateGraphTemplate;
  if (instantiate === undefined) throw graphTemplatesUnsupportedError(backend);
  await backend.assertBaseSchemaCurrent?.();
  const sourceVersion = params.template.reconciled.version;
  const reconciledHash = params.template.reconciled.hash;
  if (sourceVersion === undefined || reconciledHash === undefined) {
    throw graphTemplateHandleMismatchError(params.template.id);
  }
  const sourceHash = await computeSchemaHash(
    serializeSchema(params.template.reconciled.graph, sourceVersion),
  );
  if (
    sourceHash !== params.template.schemaHash ||
    reconciledHash !== params.template.schemaHash
  ) {
    throw graphTemplateHandleMismatchError(params.template.id);
  }
  const targetGraph: G = Object.freeze({
    ...params.template.reconciled.graph,
    id: params.graphId,
  });
  const targetHash = await computeSchemaHash(serializeSchema(targetGraph, 1));
  const instantiateUnder = (schemaHash: string) =>
    instantiate({
      templateId: params.template.id,
      templateSchemaHash:
        params.template.registryHash ?? params.template.schemaHash,
      graphId: params.graphId,
      schemaHash,
    });
  const firstResult = await instantiateUnder(targetHash);
  // An idempotent retry against a target an earlier release instantiated is
  // refused by the hash key alone: that target's v1 row carries the hash the
  // earlier release computed. Judge its document, and retry under its own
  // stored key when it holds this target's schema.
  const earlierReleaseTargetHash =
    firstResult.status === "refused" ?
      await earlierReleaseTargetSchemaHash(backend, params.graphId, targetHash)
    : undefined;
  const boundTargetHash = earlierReleaseTargetHash ?? targetHash;
  const result =
    earlierReleaseTargetHash === undefined ? firstResult : (
      await instantiateUnder(earlierReleaseTargetHash)
    );
  if (result.status === "refused") {
    throw new ConfigurationError(
      `Graph template instantiation was refused for graph "${params.graphId}". The template may be absent, or the graph already has a different schema.`,
      {
        code: "GRAPH_TEMPLATE_INSTANTIATION_REFUSED",
        graphId: params.graphId,
        templateId: params.template.id,
      },
    );
  }
  if (
    result.row.graph_id !== params.graphId ||
    result.row.version !== 1 ||
    result.row.schema_hash !== boundTargetHash
  ) {
    throw new ConfigurationError(
      "Graph template backend returned a schema row that does not match the requested target.",
      { code: "GRAPH_TEMPLATE_INVALID_RESULT", graphId: params.graphId },
    );
  }
  return Object.freeze({
    status: "ready",
    reconciled: Object.freeze({
      graph: targetGraph,
      version: result.row.version,
      hash: targetHash,
    }),
    schema: result.row,
  });
}

/**
 * The stored hash column of the target's active v1 row when an earlier
 * release wrote it for exactly this target schema, otherwise `undefined`.
 */
async function earlierReleaseTargetSchemaHash(
  backend: GraphBackend,
  graphId: string,
  targetHash: string,
): Promise<string | undefined> {
  const active = await backend.getActiveSchema(graphId);
  if (
    active?.version !== 1 ||
    active.schema_hash === targetHash ||
    !(await storedSchemaMatches(active, targetHash))
  ) {
    return undefined;
  }
  return active.schema_hash;
}

function graphTemplateHandleMismatchError(
  templateId: string,
): ConfigurationError {
  return new ConfigurationError(
    `Graph template handle "${templateId}" does not match its reconciled schema snapshot.`,
    { code: "GRAPH_TEMPLATE_HANDLE_MISMATCH", templateId },
  );
}

/** Short public name for {@link instantiateGraphTemplate}. */
export function instantiateGraph<G extends GraphDef>(
  backend: GraphBackend,
  params: Readonly<{ template: GraphTemplate<G>; graphId: string }>,
): Promise<InstantiateGraphTemplateResult<G>> {
  return instantiateGraphTemplate(backend, params);
}

function graphTemplatesUnsupportedError(
  backend: GraphBackend,
): ConfigurationError {
  return new ConfigurationError(
    `The ${backend.dialect} backend does not support durable graph templates.`,
    { code: "GRAPH_TEMPLATES_UNSUPPORTED", dialect: backend.dialect },
  );
}
