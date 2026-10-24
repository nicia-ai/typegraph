import { resolveGraphRelationNames } from "../../../src/backend/graph-relations";

/**
 * Every graph-scoped relation a per-test reset clears, taken from the graph
 * relation inventory so a relation added to the schema cannot silently leak
 * rows into the next test. The deployment-shared relations (the installation
 * marker, graph templates, fences) are outside the inventory and stay in place.
 */
const RESETTABLE_TABLE_NAMES: readonly string[] = Object.values(
  resolveGraphRelationNames(undefined),
);

/** A single TRUNCATE over every resettable graph-scoped relation. */
export const TRUNCATE_RESETTABLE_TABLES_SQL = `TRUNCATE ${RESETTABLE_TABLE_NAMES.map(
  (name) => `"${name}"`,
).join(", ")} CASCADE`;
