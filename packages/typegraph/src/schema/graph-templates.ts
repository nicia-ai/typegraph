import type { GraphBackend, SchemaVersionRow } from "../backend/types";
import { type GraphDef } from "../core/define-graph";
import { resolveGraphVectorSlots } from "../core/embedding";
import { ConfigurationError } from "../errors";
import { type ReconciledSchema } from "../store/store";
import { computeSchemaHash, serializeSchema } from "./serializer";

/** A locally held handle for a durable server-side graph template. */
export type GraphTemplate<G extends GraphDef> = Readonly<{
  id: string;
  reconciled: ReconciledSchema<G>;
  schemaHash: string;
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
  const { reconciled } = params;
  if (reconciled.version === undefined || reconciled.hash === undefined) {
    throw new ConfigurationError(
      "A graph template requires a reconciled schema from a managed or verified Store.",
      { code: "GRAPH_TEMPLATE_REQUIRES_RECONCILED_SCHEMA" },
    );
  }
  if (resolveGraphVectorSlots(reconciled.graph).length > 0) {
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
  await register({
    templateId: params.templateId,
    schemaHash,
    schemaDoc: schemaDocument,
  });
  return Object.freeze({
    id: params.templateId,
    reconciled,
    schemaHash,
  });
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
  const targetGraph: G = Object.freeze({
    ...params.template.reconciled.graph,
    id: params.graphId,
  });
  const targetHash = await computeSchemaHash(serializeSchema(targetGraph, 1));
  const result = await instantiate({
    templateId: params.template.id,
    templateSchemaHash: params.template.schemaHash,
    graphId: params.graphId,
    schemaHash: targetHash,
  });
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
    result.row.schema_hash !== targetHash
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
      hash: result.row.schema_hash,
    }),
    schema: result.row,
  });
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
