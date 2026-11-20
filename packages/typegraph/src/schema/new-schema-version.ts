/** Shared semantic preparation for managed and adopted schema-version writes. */
import type { GraphDef } from "../core/define-graph";
import { buildKindRegistry } from "../registry";
import {
  computeSchemaHash,
  serializeSchema,
  serializeSchemaPreservingUnknownFields,
} from "./serializer";
import type { SchemaHash, SerializedSchema } from "./types";

export type PreparedSchemaVersion = Readonly<{
  version: number;
  schemaDocument: SerializedSchema;
  schemaHash: SchemaHash;
}>;

export async function prepareNewSchemaVersion<G extends GraphDef>(
  graph: G,
  currentVersion: number,
  previous: SerializedSchema | undefined,
): Promise<PreparedSchemaVersion> {
  // Reject invalid graph relations before a schema row can be written.
  buildKindRegistry(graph);
  const version = currentVersion + 1;
  const schemaDocument =
    previous === undefined ?
      serializeSchema(graph, version)
    : serializeSchemaPreservingUnknownFields(graph, version, previous);
  const schemaHash = await computeSchemaHash(schemaDocument);
  return { version, schemaDocument, schemaHash };
}
