/**
 * Schema migration utilities.
 *
 * Provides diff detection between schema versions to identify
 * what has changed and what migrations might be needed.
 */
import {
  type SerializedEdgeDef,
  type SerializedNodeDef,
  type SerializedOntology,
  type SerializedSchema,
} from "./types";

// ============================================================
// Change Types
// ============================================================

/**
 * Types of changes that can occur in a schema.
 */
export type ChangeType = "added" | "removed" | "modified" | "renamed";

/**
 * Severity of a change for migration purposes.
 */
export type ChangeSeverity =
  | "safe" // No data migration needed
  | "warning" // Might need attention
  | "breaking"; // Requires data migration

// ============================================================
// Node Changes
// ============================================================

/**
 * A change to a node definition.
 */
export type NodeChange = Readonly<{
  type: ChangeType;
  name: string;
  severity: ChangeSeverity;
  details: string;
  before?: SerializedNodeDef | undefined;
  after?: SerializedNodeDef | undefined;
}>;

// ============================================================
// Edge Changes
// ============================================================

/**
 * A change to an edge definition.
 */
export type EdgeChange = Readonly<{
  type: ChangeType;
  name: string;
  severity: ChangeSeverity;
  details: string;
  before?: SerializedEdgeDef | undefined;
  after?: SerializedEdgeDef | undefined;
}>;

// ============================================================
// Ontology Changes
// ============================================================

/**
 * A change to the ontology.
 */
export type OntologyChange = Readonly<{
  type: ChangeType;
  entity: "metaEdge" | "relation";
  name: string;
  severity: ChangeSeverity;
  details: string;
}>;

// ============================================================
// Schema Diff
// ============================================================

/**
 * A complete diff between two schema versions.
 */
export type SchemaDiff = Readonly<{
  fromVersion: number;
  toVersion: number;

  /** Changes to node definitions */
  nodes: readonly NodeChange[];

  /** Changes to edge definitions */
  edges: readonly EdgeChange[];

  /** Changes to ontology */
  ontology: readonly OntologyChange[];

  /** Whether any breaking changes exist */
  hasBreakingChanges: boolean;

  /** Whether any changes exist at all */
  hasChanges: boolean;

  /** Summary of changes */
  summary: string;
}>;

// ============================================================
// Diff Computation
// ============================================================

/**
 * Computes the diff between two schema versions.
 *
 * @param before - The previous schema version
 * @param after - The new schema version
 * @returns A diff describing all changes
 */
export function computeSchemaDiff(
  before: SerializedSchema,
  after: SerializedSchema,
): SchemaDiff {
  const nodeChanges = diffNodes(before.nodes, after.nodes);
  const edgeChanges = diffEdges(before.edges, after.edges);
  const ontologyChanges = diffOntology(before.ontology, after.ontology);

  const allChanges = [...nodeChanges, ...edgeChanges, ...ontologyChanges];
  const hasBreakingChanges = allChanges.some(
    (change) => change.severity === "breaking",
  );
  const hasChanges = allChanges.length > 0;

  const summary = generateSummary(nodeChanges, edgeChanges, ontologyChanges);

  return {
    fromVersion: before.version,
    toVersion: after.version,
    nodes: nodeChanges,
    edges: edgeChanges,
    ontology: ontologyChanges,
    hasBreakingChanges,
    hasChanges,
    summary,
  };
}

// ============================================================
// Node Diff
// ============================================================

/**
 * Computes changes between node definitions.
 */
function diffNodes(
  before: Record<string, SerializedNodeDef>,
  after: Record<string, SerializedNodeDef>,
): readonly NodeChange[] {
  const changes: NodeChange[] = [];
  const beforeNames = new Set(Object.keys(before));
  const afterNames = new Set(Object.keys(after));

  // Find removed nodes
  for (const name of beforeNames) {
    if (!afterNames.has(name)) {
      changes.push({
        type: "removed",
        name,
        severity: "breaking",
        details: `Node kind "${name}" was removed`,
        before: before[name],
      });
    }
  }

  // Find added nodes
  for (const name of afterNames) {
    if (!beforeNames.has(name)) {
      changes.push({
        type: "added",
        name,
        severity: "safe",
        details: `Node kind "${name}" was added`,
        after: after[name],
      });
    }
  }

  // Find modified nodes
  for (const name of beforeNames) {
    if (afterNames.has(name)) {
      const nodeBefore = before[name]!;
      const nodeAfter = after[name]!;
      const nodeChanges = diffNodeDef(name, nodeBefore, nodeAfter);
      changes.push(...nodeChanges);
    }
  }

  return changes;
}

/**
 * Computes changes to a single node definition.
 */
function diffNodeDef(
  name: string,
  before: SerializedNodeDef,
  after: SerializedNodeDef,
): readonly NodeChange[] {
  const changes: NodeChange[] = [];

  // Check property schema changes
  const propsBefore = JSON.stringify(before.properties);
  const propsAfter = JSON.stringify(after.properties);
  if (propsBefore !== propsAfter) {
    // Determine if properties were added or removed
    const beforeProps = before.properties.properties ?? {};
    const afterProps = after.properties.properties ?? {};
    const beforeRequired = new Set(before.properties.required);
    const afterRequired = new Set(after.properties.required);

    const addedProps = Object.keys(afterProps).filter(
      (p) => !(p in beforeProps),
    );
    const removedProps = Object.keys(beforeProps).filter(
      (p) => !(p in afterProps),
    );
    const newRequired = [...afterRequired].filter(
      (p) => !beforeRequired.has(p),
    );

    const { severity, details } = computePropertyChangeSeverity(
      name,
      removedProps,
      addedProps,
      newRequired,
    );

    changes.push({
      type: "modified",
      name,
      severity,
      details,
      before,
      after,
    });
  }

  // Check onDelete behavior
  if (before.onDelete !== after.onDelete) {
    changes.push({
      type: "modified",
      name,
      severity: "warning",
      details: `onDelete changed from "${before.onDelete}" to "${after.onDelete}" for "${name}"`,
      before,
      after,
    });
  }

  // Check unique constraints
  const constraintsBefore = JSON.stringify(before.uniqueConstraints);
  const constraintsAfter = JSON.stringify(after.uniqueConstraints);
  if (constraintsBefore !== constraintsAfter) {
    changes.push({
      type: "modified",
      name,
      severity: "warning",
      details: `Unique constraints changed for "${name}"`,
      before,
      after,
    });
  }

  return changes;
}

/**
 * Computes the severity and details message for property changes.
 */
function computePropertyChangeSeverity(
  name: string,
  removedProps: readonly string[],
  addedProps: readonly string[],
  newRequired: readonly string[],
): { severity: ChangeSeverity; details: string } {
  if (removedProps.length > 0) {
    return {
      severity: "breaking",
      details: `Properties removed from "${name}": ${removedProps.join(", ")}`,
    };
  }
  if (newRequired.length > 0) {
    return {
      severity: "breaking",
      details: `New required properties in "${name}": ${newRequired.join(", ")}`,
    };
  }
  if (addedProps.length > 0) {
    return {
      severity: "safe",
      details: `Properties added to "${name}": ${addedProps.join(", ")}`,
    };
  }
  return {
    severity: "safe",
    details: `Properties changed in "${name}"`,
  };
}

// ============================================================
// Edge Diff
// ============================================================

/**
 * Computes changes between edge definitions.
 */
function diffEdges(
  before: Record<string, SerializedEdgeDef>,
  after: Record<string, SerializedEdgeDef>,
): readonly EdgeChange[] {
  const changes: EdgeChange[] = [];
  const beforeNames = new Set(Object.keys(before));
  const afterNames = new Set(Object.keys(after));

  // Find removed edges
  for (const name of beforeNames) {
    if (!afterNames.has(name)) {
      changes.push({
        type: "removed",
        name,
        severity: "breaking",
        details: `Edge kind "${name}" was removed`,
        before: before[name],
      });
    }
  }

  // Find added edges
  for (const name of afterNames) {
    if (!beforeNames.has(name)) {
      changes.push({
        type: "added",
        name,
        severity: "safe",
        details: `Edge kind "${name}" was added`,
        after: after[name],
      });
    }
  }

  // Find modified edges
  for (const name of beforeNames) {
    if (afterNames.has(name)) {
      const edgeBefore = before[name]!;
      const edgeAfter = after[name]!;
      const edgeChanges = diffEdgeDef(name, edgeBefore, edgeAfter);
      changes.push(...edgeChanges);
    }
  }

  return changes;
}

/**
 * Computes changes to a single edge definition.
 */
function diffEdgeDef(
  name: string,
  before: SerializedEdgeDef,
  after: SerializedEdgeDef,
): readonly EdgeChange[] {
  const changes: EdgeChange[] = [];

  // Check endpoint kinds
  const fromBefore = JSON.stringify(before.fromKinds);
  const fromAfter = JSON.stringify(after.fromKinds);
  if (fromBefore !== fromAfter) {
    changes.push({
      type: "modified",
      name,
      severity: "warning",
      details: `fromKinds changed for "${name}"`,
      before,
      after,
    });
  }

  const toBefore = JSON.stringify(before.toKinds);
  const toAfter = JSON.stringify(after.toKinds);
  if (toBefore !== toAfter) {
    changes.push({
      type: "modified",
      name,
      severity: "warning",
      details: `toKinds changed for "${name}"`,
      before,
      after,
    });
  }

  // Check cardinality
  if (before.cardinality !== after.cardinality) {
    changes.push({
      type: "modified",
      name,
      severity: "warning",
      details: `Cardinality changed from "${before.cardinality}" to "${after.cardinality}" for "${name}"`,
      before,
      after,
    });
  }

  // Check properties
  const propsBefore = JSON.stringify(before.properties);
  const propsAfter = JSON.stringify(after.properties);
  if (propsBefore !== propsAfter) {
    changes.push({
      type: "modified",
      name,
      severity: "safe",
      details: `Properties changed for "${name}"`,
      before,
      after,
    });
  }

  return changes;
}

// ============================================================
// Ontology Diff
// ============================================================

/**
 * Computes changes to the ontology.
 */
function diffOntology(
  before: SerializedOntology,
  after: SerializedOntology,
): readonly OntologyChange[] {
  const changes: OntologyChange[] = [];

  // Diff meta-edges
  const metaEdgesBefore = new Set(Object.keys(before.metaEdges));
  const metaEdgesAfter = new Set(Object.keys(after.metaEdges));

  for (const name of metaEdgesBefore) {
    if (!metaEdgesAfter.has(name)) {
      changes.push({
        type: "removed",
        entity: "metaEdge",
        name,
        severity: "breaking",
        details: `Meta-edge "${name}" was removed`,
      });
    }
  }

  for (const name of metaEdgesAfter) {
    if (!metaEdgesBefore.has(name)) {
      changes.push({
        type: "added",
        entity: "metaEdge",
        name,
        severity: "safe",
        details: `Meta-edge "${name}" was added`,
      });
    }
  }

  // Diff relations (simplified - just detect additions/removals)
  const relationsBefore = new Set(
    before.relations.map((r) => `${r.metaEdge}:${r.from}:${r.to}`),
  );
  const relationsAfter = new Set(
    after.relations.map((r) => `${r.metaEdge}:${r.from}:${r.to}`),
  );

  for (const relationKey of relationsBefore) {
    if (!relationsAfter.has(relationKey)) {
      const [metaEdge, from, to] = relationKey.split(":");
      changes.push({
        type: "removed",
        entity: "relation",
        name: relationKey,
        severity: "warning",
        details: `Relation ${metaEdge}(${from}, ${to}) was removed`,
      });
    }
  }

  for (const relationKey of relationsAfter) {
    if (!relationsBefore.has(relationKey)) {
      const [metaEdge, from, to] = relationKey.split(":");
      changes.push({
        type: "added",
        entity: "relation",
        name: relationKey,
        severity: "safe",
        details: `Relation ${metaEdge}(${from}, ${to}) was added`,
      });
    }
  }

  return changes;
}

// ============================================================
// Summary Generation
// ============================================================

/**
 * Generates a human-readable summary of changes.
 */
function generateSummary(
  nodeChanges: readonly NodeChange[],
  edgeChanges: readonly EdgeChange[],
  ontologyChanges: readonly OntologyChange[],
): string {
  const parts: string[] = [];

  const nodeAdded = nodeChanges.filter((c) => c.type === "added").length;
  const nodeRemoved = nodeChanges.filter((c) => c.type === "removed").length;
  const nodeModified = nodeChanges.filter((c) => c.type === "modified").length;

  if (nodeAdded > 0 || nodeRemoved > 0 || nodeModified > 0) {
    parts.push(
      `Nodes: ${nodeAdded} added, ${nodeRemoved} removed, ${nodeModified} modified`,
    );
  }

  const edgeAdded = edgeChanges.filter((c) => c.type === "added").length;
  const edgeRemoved = edgeChanges.filter((c) => c.type === "removed").length;
  const edgeModified = edgeChanges.filter((c) => c.type === "modified").length;

  if (edgeAdded > 0 || edgeRemoved > 0 || edgeModified > 0) {
    parts.push(
      `Edges: ${edgeAdded} added, ${edgeRemoved} removed, ${edgeModified} modified`,
    );
  }

  const ontologyAdded = ontologyChanges.filter(
    (c) => c.type === "added",
  ).length;
  const ontologyRemoved = ontologyChanges.filter(
    (c) => c.type === "removed",
  ).length;

  if (ontologyAdded > 0 || ontologyRemoved > 0) {
    parts.push(`Ontology: ${ontologyAdded} added, ${ontologyRemoved} removed`);
  }

  if (parts.length === 0) {
    return "No changes";
  }

  return parts.join("; ");
}

// ============================================================
// Migration Helpers
// ============================================================

/**
 * Checks if a schema change is backwards compatible.
 *
 * A change is backwards compatible if:
 * - No nodes or edges were removed
 * - No required properties were added
 * - No existing properties were removed
 */
export function isBackwardsCompatible(diff: SchemaDiff): boolean {
  return !diff.hasBreakingChanges;
}

/**
 * Gets a list of actions needed for migration.
 */
export function getMigrationActions(diff: SchemaDiff): readonly string[] {
  const actions: string[] = [];

  for (const change of diff.nodes) {
    if (change.type === "removed") {
      actions.push(`DELETE data for removed node kind "${change.name}"`);
    }
    if (change.severity === "breaking" && change.type === "modified") {
      actions.push(
        `MIGRATE data for node kind "${change.name}": ${change.details}`,
      );
    }
  }

  for (const change of diff.edges) {
    if (change.type === "removed") {
      actions.push(`DELETE data for removed edge kind "${change.name}"`);
    }
  }

  return actions;
}
