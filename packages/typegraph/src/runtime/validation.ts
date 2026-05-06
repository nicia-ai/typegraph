/**
 * Pure structural validation for `RuntimeGraphDocument`.
 *
 * Walks the document and accumulates every issue (no fail-fast) so a
 * caller showing the document to a human reviewer can surface all
 * problems in one round. Cross-document references — edge endpoints,
 * ontology endpoints — resolve only against this document; resolution
 * against an existing compile-time graph happens later, when the
 * document is merged into a host `GraphDef`.
 */
import { assertJsonValue } from "../core/json-value";
import { type KindAnnotations } from "../core/types";
import { ConfigurationError } from "../errors";
import { computeTransitiveClosure } from "../ontology/closures";
import { ALL_META_EDGE_NAMES, type MetaEdgeName } from "../ontology/constants";
import { RESERVED_EDGE_KEYS, RESERVED_NODE_KEYS } from "../store/reserved-keys";
import { err, ok, type Result } from "../utils/result";
import {
  type RuntimeArrayProperty,
  type RuntimeBooleanProperty,
  type RuntimeEdgeDocument,
  type RuntimeEnumProperty,
  type RuntimeGraphDocument,
  type RuntimeNodeDocument,
  type RuntimeNumberProperty,
  type RuntimeObjectFieldProperty,
  type RuntimeObjectProperty,
  type RuntimeOntologyRelation,
  type RuntimePropertyType,
  type RuntimeStringProperty,
  type RuntimeUniqueConstraint,
} from "./document-types";
import {
  type RuntimeExtensionIssue,
  type RuntimeExtensionIssueCode,
  RuntimeExtensionValidationError,
} from "./errors";
import { compactUndefined } from "./internal";

const META_EDGE_NAME_SET: ReadonlySet<string> = new Set(ALL_META_EDGE_NAMES);

const SUPPORTED_PROPERTY_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "enum",
  "array",
  "object",
]);

const STRING_REFINEMENT_KEYS = new Set([
  "type",
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "optional",
  "searchable",
  "embedding",
  "description",
]);

const NUMBER_REFINEMENT_KEYS = new Set([
  "type",
  "min",
  "max",
  "int",
  "optional",
  "searchable",
  "embedding",
  "description",
]);

const BOOLEAN_REFINEMENT_KEYS = new Set([
  "type",
  "optional",
  "searchable",
  "embedding",
  "description",
]);

const ENUM_REFINEMENT_KEYS = new Set([
  "type",
  "values",
  "optional",
  "searchable",
  "embedding",
  "description",
]);

const ARRAY_REFINEMENT_KEYS = new Set([
  "type",
  "items",
  "optional",
  "searchable",
  "embedding",
  "description",
]);

const OBJECT_REFINEMENT_KEYS = new Set([
  "type",
  "properties",
  "optional",
  "searchable",
  "embedding",
  "description",
]);

const SUPPORTED_STRING_FORMATS = new Set(["datetime", "uri"]);

/**
 * Validates a runtime extension document.
 *
 * Returns the (frozen, deeply normalized) document on success, or a
 * `RuntimeExtensionValidationError` carrying every issue on failure. The
 * function never throws — callers that prefer exceptions wrap with
 * `unwrap()`.
 */
export function validateRuntimeExtension(
  input: unknown,
): Result<RuntimeGraphDocument, RuntimeExtensionValidationError> {
  const issues: RuntimeExtensionIssue[] = [];

  if (!isPlainObject(input)) {
    issues.push({
      path: "",
      message: "Document must be a plain object.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return err(new RuntimeExtensionValidationError(issues));
  }

  const documentRecord = input;

  const allowedTopLevelKeys = new Set(["nodes", "edges", "ontology"]);
  for (const key of Object.keys(documentRecord)) {
    if (!allowedTopLevelKeys.has(key)) {
      issues.push({
        path: `/${escapePointerSegment(key)}`,
        message: `Unknown top-level key "${key}". Allowed keys: nodes, edges, ontology.`,
        code: "INVALID_DOCUMENT_SHAPE",
      });
    }
  }

  const nodes = validateNodesSection(documentRecord.nodes, issues);
  const edges = validateEdgesSection(documentRecord.edges, issues);

  // Edge endpoints can reference (a) kinds declared in this same document,
  // (b) compile-time host kinds resolved at merge time, or (c) external
  // IRIs. The cross-graph resolution check happens at merge time, not
  // here.

  const ontology = validateOntologySection(documentRecord.ontology, issues);
  if (ontology !== undefined) {
    validateOntology(ontology, nodes, issues);
  }

  if (issues.length > 0) {
    return err(new RuntimeExtensionValidationError(issues));
  }

  return ok(freezeDocument({ nodes, edges, ontology }));
}

// ============================================================
// Section: nodes
// ============================================================

function validateNodesSection(
  rawNodes: unknown,
  issues: RuntimeExtensionIssue[],
): Record<string, RuntimeNodeDocument> | undefined {
  if (rawNodes === undefined) return undefined;

  if (!isPlainObject(rawNodes)) {
    issues.push({
      path: "/nodes",
      message: "`nodes` must be a plain object keyed by node-kind name.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: Record<string, RuntimeNodeDocument> = {};
  const recorded = new Set<string>();

  for (const [kindName, rawNode] of Object.entries(rawNodes)) {
    const path = `/nodes/${escapePointerSegment(kindName)}`;

    if (!isValidKindName(kindName)) {
      issues.push({
        path,
        message: `Node kind name "${kindName}" must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
        code: "INVALID_KIND_NAME",
      });
      continue;
    }

    if (recorded.has(kindName)) {
      issues.push({
        path,
        message: `Duplicate node kind name "${kindName}".`,
        code: "DUPLICATE_KIND_NAME",
      });
      continue;
    }

    const node = validateNodeDocument(kindName, rawNode, path, issues);
    if (node === undefined) continue;
    result[kindName] = node;
    recorded.add(kindName);
  }

  return result;
}

function validateNodeDocument(
  kindName: string,
  raw: unknown,
  path: string,
  issues: RuntimeExtensionIssue[],
): RuntimeNodeDocument | undefined {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: `Node "${kindName}" must be a plain object.`,
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const allowed = new Set([
    "description",
    "annotations",
    "properties",
    "unique",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      issues.push({
        path: `${path}/${escapePointerSegment(key)}`,
        message: `Unknown node-level key "${key}". Allowed: description, annotations, properties, unique.`,
        code: "INVALID_DOCUMENT_SHAPE",
      });
    }
  }

  const description = validateOptionalString(
    raw.description,
    `${path}/description`,
    issues,
  );

  const annotations = validateAnnotations(
    raw.annotations,
    `${path}/annotations`,
    `Node "${kindName}"`,
    issues,
  );

  const propertiesRaw = raw.properties;
  const properties = validatePropertiesMap(
    propertiesRaw,
    `${path}/properties`,
    "node",
    kindName,
    issues,
  );
  if (properties === undefined) return undefined;

  const uniqueRaw = raw.unique;
  const unique = validateUniqueConstraints(
    uniqueRaw,
    `${path}/unique`,
    properties,
    issues,
  );

  return compactUndefined<RuntimeNodeDocument>({
    description,
    annotations,
    properties,
    unique,
  });
}

// ============================================================
// Section: edges
// ============================================================

function validateEdgesSection(
  rawEdges: unknown,
  issues: RuntimeExtensionIssue[],
): Record<string, RuntimeEdgeDocument> | undefined {
  if (rawEdges === undefined) return undefined;

  if (!isPlainObject(rawEdges)) {
    issues.push({
      path: "/edges",
      message: "`edges` must be a plain object keyed by edge-kind name.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: Record<string, RuntimeEdgeDocument> = {};
  const recorded = new Set<string>();

  for (const [kindName, rawEdge] of Object.entries(rawEdges)) {
    const path = `/edges/${escapePointerSegment(kindName)}`;

    if (!isValidKindName(kindName)) {
      issues.push({
        path,
        message: `Edge kind name "${kindName}" must match /^[A-Za-z_][A-Za-z0-9_]*$/.`,
        code: "INVALID_KIND_NAME",
      });
      continue;
    }

    if (recorded.has(kindName)) {
      issues.push({
        path,
        message: `Duplicate edge kind name "${kindName}".`,
        code: "DUPLICATE_KIND_NAME",
      });
      continue;
    }

    const edge = validateEdgeDocument(kindName, rawEdge, path, issues);
    if (edge === undefined) continue;
    result[kindName] = edge;
    recorded.add(kindName);
  }

  return result;
}

function validateEdgeDocument(
  kindName: string,
  raw: unknown,
  path: string,
  issues: RuntimeExtensionIssue[],
): RuntimeEdgeDocument | undefined {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: `Edge "${kindName}" must be a plain object.`,
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const allowed = new Set([
    "description",
    "annotations",
    "from",
    "to",
    "properties",
  ]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      issues.push({
        path: `${path}/${escapePointerSegment(key)}`,
        message: `Unknown edge-level key "${key}". Allowed: description, annotations, from, to, properties.`,
        code: "INVALID_DOCUMENT_SHAPE",
      });
    }
  }

  const description = validateOptionalString(
    raw.description,
    `${path}/description`,
    issues,
  );

  const annotations = validateAnnotations(
    raw.annotations,
    `${path}/annotations`,
    `Edge "${kindName}"`,
    issues,
  );

  const from = validateEndpointList(raw.from, `${path}/from`, issues);
  const to = validateEndpointList(raw.to, `${path}/to`, issues);
  if (from === undefined || to === undefined) return undefined;

  const propertiesRaw = raw.properties;
  const properties =
    propertiesRaw === undefined ?
      {}
    : validatePropertiesMap(
        propertiesRaw,
        `${path}/properties`,
        "edge",
        kindName,
        issues,
      );
  if (properties === undefined) return undefined;

  return compactUndefined<RuntimeEdgeDocument>({
    description,
    annotations,
    from,
    to,
    properties,
  });
}

function validateEndpointList(
  raw: unknown,
  path: string,
  issues: RuntimeExtensionIssue[],
): readonly string[] | undefined {
  if (!Array.isArray(raw)) {
    issues.push({
      path,
      message: "Edge endpoint list must be an array of node-kind names.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }
  if (raw.length === 0) {
    issues.push({
      path,
      message: "Edge endpoint list must contain at least one node-kind name.",
      code: "EMPTY_FROM_OR_TO",
    });
    return undefined;
  }
  const names: string[] = [];
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({
        path: `${path}/${index}`,
        message: "Edge endpoint must be a non-empty string node-kind name.",
        code: "INVALID_DOCUMENT_SHAPE",
      });
      return undefined;
    }
    names.push(value);
  }
  return names;
}

// ============================================================
// Section: ontology
// ============================================================

function validateOntologySection(
  raw: unknown,
  issues: RuntimeExtensionIssue[],
): RuntimeOntologyRelation[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({
      path: "/ontology",
      message: "`ontology` must be an array of relation objects.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: RuntimeOntologyRelation[] = [];
  for (const [index, entry] of raw.entries()) {
    const path = `/ontology/${index}`;
    if (!isPlainObject(entry)) {
      issues.push({
        path,
        message: "Ontology entry must be a plain object.",
        code: "INVALID_DOCUMENT_SHAPE",
      });
      continue;
    }
    const allowed = new Set(["metaEdge", "from", "to"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        issues.push({
          path: `${path}/${escapePointerSegment(key)}`,
          message: `Unknown ontology-entry key "${key}". Allowed: metaEdge, from, to.`,
          code: "INVALID_DOCUMENT_SHAPE",
        });
      }
    }

    const metaEdge = entry.metaEdge;
    const from = entry.from;
    const to = entry.to;

    if (typeof metaEdge !== "string" || !META_EDGE_NAME_SET.has(metaEdge)) {
      issues.push({
        path: `${path}/metaEdge`,
        message: `Unknown meta-edge ${describeUnknownValue(metaEdge)}. Allowed: ${[...ALL_META_EDGE_NAMES].join(", ")}.`,
        code: "UNKNOWN_META_EDGE",
      });
      continue;
    }
    if (typeof from !== "string" || from.length === 0) {
      issues.push({
        path: `${path}/from`,
        message: "Ontology relation `from` must be a non-empty string.",
        code: "INVALID_DOCUMENT_SHAPE",
      });
      continue;
    }
    if (typeof to !== "string" || to.length === 0) {
      issues.push({
        path: `${path}/to`,
        message: "Ontology relation `to` must be a non-empty string.",
        code: "INVALID_DOCUMENT_SHAPE",
      });
      continue;
    }

    result.push({ metaEdge: metaEdge as MetaEdgeName, from, to });
  }
  return result;
}

function validateOntology(
  ontology: readonly RuntimeOntologyRelation[],
  _nodes: Record<string, RuntimeNodeDocument> | undefined,
  issues: RuntimeExtensionIssue[],
): void {
  const seenKey = new Set<string>();

  for (const [index, relation] of ontology.entries()) {
    const path = `/ontology/${index}`;

    if (
      relation.from === relation.to &&
      isStrictlyHierarchicalMetaEdge(relation.metaEdge)
    ) {
      issues.push({
        path,
        message: `Hierarchical meta-edge "${relation.metaEdge}" cannot be a self-loop ("${relation.from}" → "${relation.to}").`,
        code: "ONTOLOGY_SELF_LOOP",
      });
    }

    const key = `${relation.metaEdge}::${relation.from}->${relation.to}`;
    if (seenKey.has(key)) {
      issues.push({
        path,
        message: `Duplicate ontology relation "${relation.metaEdge}" (${relation.from} → ${relation.to}).`,
        code: "DUPLICATE_ONTOLOGY_RELATION",
      });
      continue;
    }
    seenKey.add(key);
  }

  // Cycle detection on transitive hierarchical relations declared *within*
  // this document. Cross-document cycles will be caught at evolve() time
  // when the runtime extension is merged with the existing graph.
  detectHierarchicalCycles(ontology, issues);
}

const STRICTLY_HIERARCHICAL: ReadonlySet<MetaEdgeName> = new Set([
  "subClassOf",
  "broader",
  "narrower",
  "partOf",
  "hasPart",
]);

function isStrictlyHierarchicalMetaEdge(name: MetaEdgeName): boolean {
  return STRICTLY_HIERARCHICAL.has(name);
}

/**
 * Maps each hierarchical meta-edge to the canonical group it normalizes
 * into, mirroring the registry's relation-table flattening
 * (`computeClosuresFromOntology`). `narrower A→B` is the inverse of
 * `broader A→B`; `hasPart A→B` is the inverse of `partOf A→B`. Cycle
 * detection must run on the same normalized set the registry will, or
 * mixed-direction cycles like `broader A→B` + `narrower A→B` slip
 * through validation and surface only at runtime.
 */
const HIERARCHICAL_NORMALIZATION: ReadonlyMap<
  MetaEdgeName,
  Readonly<{ canonical: MetaEdgeName; flip: boolean }>
> = new Map([
  ["subClassOf", { canonical: "subClassOf", flip: false }],
  ["broader", { canonical: "broader", flip: false }],
  ["narrower", { canonical: "broader", flip: true }],
  ["partOf", { canonical: "partOf", flip: false }],
  ["hasPart", { canonical: "partOf", flip: true }],
]);

function detectHierarchicalCycles(
  ontology: readonly RuntimeOntologyRelation[],
  issues: RuntimeExtensionIssue[],
): void {
  type NormalizedEdge = Readonly<{
    from: string;
    to: string;
    originalIndex: number;
  }>;

  const groups = new Map<MetaEdgeName, NormalizedEdge[]>();
  for (const [index, relation] of ontology.entries()) {
    const normalization = HIERARCHICAL_NORMALIZATION.get(relation.metaEdge);
    if (normalization === undefined) continue;
    if (relation.from === relation.to) continue; // already reported as self-loop

    const from = normalization.flip ? relation.to : relation.from;
    const to = normalization.flip ? relation.from : relation.to;

    const list = groups.get(normalization.canonical) ?? [];
    list.push({ from, to, originalIndex: index });
    groups.set(normalization.canonical, list);
  }

  for (const [name, edges] of groups) {
    const closure = computeTransitiveClosure(
      edges.map((edge) => [edge.from, edge.to] as const),
    );
    const reportedNodes = new Set<string>();
    for (const [from, reachable] of closure) {
      if (!reachable.has(from) || reportedNodes.has(from)) continue;
      reportedNodes.add(from);
      const offendingEdge = edges.find((edge) => edge.from === from);
      const path =
        offendingEdge === undefined ? "/ontology" : (
          `/ontology/${offendingEdge.originalIndex}`
        );
      issues.push({
        path,
        message: `Cycle detected in "${name}" relations involving "${from}".`,
        code: "ONTOLOGY_CYCLE",
      });
    }
  }
}

// ============================================================
// Properties and refinements
// ============================================================

function validatePropertiesMap(
  raw: unknown,
  path: string,
  ownerType: "node" | "edge",
  ownerName: string,
  issues: RuntimeExtensionIssue[],
): Record<string, RuntimePropertyType> | undefined {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: `\`properties\` must be a plain object.`,
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const reserved =
    ownerType === "node" ? RESERVED_NODE_KEYS : RESERVED_EDGE_KEYS;
  const result: Record<string, RuntimePropertyType> = {};
  for (const [propertyName, propertyValue] of Object.entries(raw)) {
    const propertyPath = `${path}/${escapePointerSegment(propertyName)}`;
    if (reserved.has(propertyName)) {
      issues.push({
        path: propertyPath,
        message: `Property name "${propertyName}" is reserved for ${ownerType} "${ownerName}".`,
        code: "RESERVED_PROPERTY_NAME",
      });
      continue;
    }
    if (propertyName.startsWith("$")) {
      issues.push({
        path: propertyPath,
        message: `Property name "${propertyName}" uses the reserved "$" prefix.`,
        code: "RESERVED_PROPERTY_NAME",
      });
      continue;
    }
    const validated = validateProperty(propertyValue, propertyPath, 0, issues);
    if (validated === undefined) continue;
    result[propertyName] = validated;
  }

  return result;
}

function validateProperty(
  raw: unknown,
  path: string,
  depth: number,
  issues: RuntimeExtensionIssue[],
): RuntimePropertyType | undefined {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message:
        "Property descriptor must be a plain object with a `type` field.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }
  const property = raw;
  const type = property.type;
  if (typeof type !== "string" || !SUPPORTED_PROPERTY_TYPES.has(type)) {
    issues.push({
      path: `${path}/type`,
      message: `Unsupported property type ${describeUnknownValue(type)}. Supported: ${[...SUPPORTED_PROPERTY_TYPES].join(", ")}.`,
      code: "UNSUPPORTED_PROPERTY_TYPE",
    });
    return undefined;
  }

  switch (type) {
    case "string": {
      return validateStringProperty(property, path, issues);
    }
    case "number": {
      return validateNumberProperty(property, path, issues);
    }
    case "boolean": {
      return validateBooleanProperty(property, path, issues);
    }
    case "enum": {
      return validateEnumProperty(property, path, issues);
    }
    case "array": {
      return validateArrayProperty(property, path, depth, issues);
    }
    case "object": {
      return validateObjectProperty(property, path, depth, issues);
    }
  }
  return undefined;
}

function validateStringProperty(
  raw: Record<string, unknown>,
  path: string,
  issues: RuntimeExtensionIssue[],
): RuntimeStringProperty | undefined {
  rejectUnknownRefinements(raw, STRING_REFINEMENT_KEYS, path, "string", issues);

  const minLength = validateNonNegativeInteger(
    raw.minLength,
    `${path}/minLength`,
    "string.minLength",
    "INVALID_LENGTH_BOUNDS",
    issues,
  );
  const maxLength = validateNonNegativeInteger(
    raw.maxLength,
    `${path}/maxLength`,
    "string.maxLength",
    "INVALID_LENGTH_BOUNDS",
    issues,
  );
  if (
    minLength !== undefined &&
    maxLength !== undefined &&
    minLength > maxLength
  ) {
    issues.push({
      path,
      message: `string.minLength (${minLength}) cannot exceed string.maxLength (${maxLength}).`,
      code: "INVALID_LENGTH_BOUNDS",
    });
  }

  let pattern: string | undefined;
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern === "string") {
      try {
        new RegExp(raw.pattern);
        pattern = raw.pattern;
      } catch (error) {
        issues.push({
          path: `${path}/pattern`,
          message: `Pattern is not a valid regular expression: ${
            error instanceof Error ? error.message : String(error)
          }`,
          code: "INVALID_PATTERN",
        });
      }
    } else {
      issues.push({
        path: `${path}/pattern`,
        message: "`pattern` must be a string regular expression.",
        code: "INVALID_PATTERN",
      });
    }
  }

  let format: "datetime" | "uri" | undefined;
  if (raw.format !== undefined) {
    if (
      typeof raw.format !== "string" ||
      !SUPPORTED_STRING_FORMATS.has(raw.format)
    ) {
      issues.push({
        path: `${path}/format`,
        message: `Unsupported string format ${describeUnknownValue(raw.format)}. Supported: ${[...SUPPORTED_STRING_FORMATS].join(", ")}.`,
        code: "INVALID_PROPERTY_REFINEMENT",
      });
    } else {
      format = raw.format as "datetime" | "uri";
    }
  }

  const modifiers = validatePropertyModifiers(raw, path, "string", issues);
  if (modifiers === undefined) return undefined;

  if (format !== undefined && modifiers.searchable !== undefined) {
    issues.push({
      path,
      message:
        "`searchable` cannot be combined with `format` on a string property — the format-specific schema cannot carry the searchable brand. Drop one, or split into two fields.",
      code: "INVALID_PROPERTY_REFINEMENT",
    });
    return undefined;
  }

  if (
    format !== undefined &&
    (minLength !== undefined ||
      maxLength !== undefined ||
      pattern !== undefined)
  ) {
    issues.push({
      path,
      message:
        "`format` cannot be combined with `minLength`, `maxLength`, or `pattern` on a string property — the format-routed schema (`z.iso.datetime` / `z.url`) is not a `z.ZodString` and cannot carry length or pattern refinements. Drop the refinement, or drop the format and validate the shape with `pattern`.",
      code: "INVALID_PROPERTY_REFINEMENT",
    });
    return undefined;
  }

  return compactUndefined<RuntimeStringProperty>({
    type: "string",
    minLength,
    maxLength,
    pattern,
    format,
    optional: modifiers.optional,
    searchable: modifiers.searchable,
    embedding: modifiers.embedding,
    description: modifiers.description,
  });
}

function validateNumberProperty(
  raw: Record<string, unknown>,
  path: string,
  issues: RuntimeExtensionIssue[],
): RuntimeNumberProperty | undefined {
  rejectUnknownRefinements(raw, NUMBER_REFINEMENT_KEYS, path, "number", issues);

  let min: number | undefined;
  let max: number | undefined;
  if (raw.min !== undefined) {
    if (typeof raw.min !== "number" || !Number.isFinite(raw.min)) {
      issues.push({
        path: `${path}/min`,
        message: "`min` must be a finite number.",
        code: "INVALID_NUMBER_BOUNDS",
      });
    } else {
      min = raw.min;
    }
  }
  if (raw.max !== undefined) {
    if (typeof raw.max !== "number" || !Number.isFinite(raw.max)) {
      issues.push({
        path: `${path}/max`,
        message: "`max` must be a finite number.",
        code: "INVALID_NUMBER_BOUNDS",
      });
    } else {
      max = raw.max;
    }
  }
  if (min !== undefined && max !== undefined && min > max) {
    issues.push({
      path,
      message: `number.min (${min}) cannot exceed number.max (${max}).`,
      code: "INVALID_NUMBER_BOUNDS",
    });
  }

  let int: boolean | undefined;
  if (raw.int !== undefined) {
    if (typeof raw.int === "boolean") {
      int = raw.int;
    } else {
      issues.push({
        path: `${path}/int`,
        message: "`int` must be a boolean.",
        code: "INVALID_PROPERTY_REFINEMENT",
      });
    }
  }

  // Integer + non-integer bounds: reject early so the compiled Zod schema
  // doesn't silently swallow values like `min: 1.5, int: true`.
  if (int === true) {
    if (min !== undefined && !Number.isInteger(min)) {
      issues.push({
        path: `${path}/min`,
        message: "`min` must be an integer when `int: true`.",
        code: "INVALID_NUMBER_BOUNDS",
      });
    }
    if (max !== undefined && !Number.isInteger(max)) {
      issues.push({
        path: `${path}/max`,
        message: "`max` must be an integer when `int: true`.",
        code: "INVALID_NUMBER_BOUNDS",
      });
    }
  }

  const modifiers = validatePropertyModifiers(raw, path, "number", issues);
  if (modifiers === undefined) return undefined;

  return compactUndefined<RuntimeNumberProperty>({
    type: "number",
    min,
    max,
    int,
    optional: modifiers.optional,
    searchable: modifiers.searchable,
    embedding: modifiers.embedding,
    description: modifiers.description,
  });
}

function validateBooleanProperty(
  raw: Record<string, unknown>,
  path: string,
  issues: RuntimeExtensionIssue[],
): RuntimeBooleanProperty | undefined {
  rejectUnknownRefinements(
    raw,
    BOOLEAN_REFINEMENT_KEYS,
    path,
    "boolean",
    issues,
  );
  const modifiers = validatePropertyModifiers(raw, path, "boolean", issues);
  if (modifiers === undefined) return undefined;
  return compactUndefined<RuntimeBooleanProperty>({
    type: "boolean",
    optional: modifiers.optional,
    searchable: modifiers.searchable,
    embedding: modifiers.embedding,
    description: modifiers.description,
  });
}

function validateEnumProperty(
  raw: Record<string, unknown>,
  path: string,
  issues: RuntimeExtensionIssue[],
): RuntimeEnumProperty | undefined {
  rejectUnknownRefinements(raw, ENUM_REFINEMENT_KEYS, path, "enum", issues);

  const valuesRaw = raw.values;
  if (!Array.isArray(valuesRaw) || valuesRaw.length === 0) {
    issues.push({
      path: `${path}/values`,
      message: "`enum.values` must be a non-empty array of strings.",
      code: "INVALID_ENUM_VALUES",
    });
    return undefined;
  }

  const values: string[] = [];
  const seen = new Set<string>();
  for (const [index, value] of valuesRaw.entries()) {
    if (typeof value !== "string") {
      issues.push({
        path: `${path}/values/${index}`,
        message: "`enum.values` entries must be strings.",
        code: "INVALID_ENUM_VALUES",
      });
      return undefined;
    }
    if (seen.has(value)) {
      issues.push({
        path: `${path}/values/${index}`,
        message: `Duplicate enum value "${value}".`,
        code: "INVALID_ENUM_VALUES",
      });
      return undefined;
    }
    seen.add(value);
    values.push(value);
  }

  const modifiers = validatePropertyModifiers(raw, path, "enum", issues);
  if (modifiers === undefined) return undefined;

  return compactUndefined<RuntimeEnumProperty>({
    type: "enum",
    values,
    optional: modifiers.optional,
    searchable: modifiers.searchable,
    embedding: modifiers.embedding,
    description: modifiers.description,
  });
}

function validateArrayProperty(
  raw: Record<string, unknown>,
  path: string,
  depth: number,
  issues: RuntimeExtensionIssue[],
): RuntimeArrayProperty | undefined {
  rejectUnknownRefinements(raw, ARRAY_REFINEMENT_KEYS, path, "array", issues);

  const itemsRaw = raw.items;
  if (itemsRaw === undefined) {
    issues.push({
      path: `${path}/items`,
      message: "`array.items` is required.",
      code: "INVALID_PROPERTY_REFINEMENT",
    });
    return undefined;
  }
  if (!isPlainObject(itemsRaw)) {
    issues.push({
      path: `${path}/items`,
      message: "`array.items` must be a plain property descriptor.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }
  const itemType = itemsRaw.type;
  if (itemType === "array") {
    issues.push({
      path: `${path}/items`,
      message: "Nested arrays are not supported in v1.",
      code: "NESTED_ARRAY",
    });
    return undefined;
  }
  const items = validateProperty(itemsRaw, `${path}/items`, depth + 1, issues);
  if (items === undefined) return undefined;
  if (items.type === "array") {
    // Defensive: shouldn't be reachable because we checked above, but keeps
    // the cast tight.
    return undefined;
  }

  const modifiers = validatePropertyModifiers(raw, path, "array", issues);
  if (modifiers === undefined) return undefined;

  return compactUndefined<RuntimeArrayProperty>({
    type: "array",
    items: items,
    optional: modifiers.optional,
    searchable: modifiers.searchable,
    embedding: modifiers.embedding,
    description: modifiers.description,
  });
}

function validateObjectProperty(
  raw: Record<string, unknown>,
  path: string,
  depth: number,
  issues: RuntimeExtensionIssue[],
): RuntimeObjectProperty | undefined {
  rejectUnknownRefinements(raw, OBJECT_REFINEMENT_KEYS, path, "object", issues);

  if (depth >= 1) {
    issues.push({
      path,
      message: "Nested objects are limited to a single level in v1.",
      code: "NESTED_OBJECT_TOO_DEEP",
    });
    return undefined;
  }

  const propertiesRaw = raw.properties;
  if (!isPlainObject(propertiesRaw)) {
    issues.push({
      path: `${path}/properties`,
      message: "`object.properties` must be a plain object.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const propertiesEntries = Object.entries(propertiesRaw);
  if (propertiesEntries.length === 0) {
    issues.push({
      path: `${path}/properties`,
      message: "`object.properties` must declare at least one field.",
      code: "EMPTY_PROPERTIES",
    });
    return undefined;
  }

  const fields: Record<string, RuntimeObjectFieldProperty> = {};
  for (const [name, value] of propertiesEntries) {
    const fieldPath = `${path}/properties/${escapePointerSegment(name)}`;
    if (!isPlainObject(value)) {
      issues.push({
        path: fieldPath,
        message: "Object field descriptor must be a plain object.",
        code: "INVALID_DOCUMENT_SHAPE",
      });
      continue;
    }
    const fieldType = value.type;
    if (fieldType === "object") {
      issues.push({
        path: fieldPath,
        message: "Nested objects are limited to a single level in v1.",
        code: "NESTED_OBJECT_TOO_DEEP",
      });
      continue;
    }
    const field = validateProperty(value, fieldPath, depth + 1, issues);
    if (field === undefined) continue;
    fields[name] = field as RuntimeObjectFieldProperty;
  }

  const modifiers = validatePropertyModifiers(raw, path, "object", issues);
  if (modifiers === undefined) return undefined;

  return compactUndefined<RuntimeObjectProperty>({
    type: "object",
    properties: fields,
    optional: modifiers.optional,
    searchable: modifiers.searchable,
    embedding: modifiers.embedding,
    description: modifiers.description,
  });
}

// ============================================================
// Modifiers
// ============================================================

type NormalizedModifiers = Readonly<{
  optional?: boolean;
  searchable?: { language?: string };
  embedding?: { dimensions: number };
  description?: string;
}>;

function validatePropertyModifiers(
  raw: Record<string, unknown>,
  path: string,
  propertyType: RuntimePropertyType["type"],
  issues: RuntimeExtensionIssue[],
): NormalizedModifiers | undefined {
  let valid = true;

  let optional: boolean | undefined;
  if (raw.optional !== undefined) {
    if (typeof raw.optional === "boolean") {
      optional = raw.optional;
    } else {
      issues.push({
        path: `${path}/optional`,
        message: "`optional` must be a boolean.",
        code: "INVALID_PROPERTY_REFINEMENT",
      });
      valid = false;
    }
  }

  let searchable: { language?: string } | undefined;
  if (raw.searchable !== undefined) {
    if (propertyType !== "string") {
      issues.push({
        path: `${path}/searchable`,
        message: `\`searchable\` is only valid on string properties (got "${propertyType}").`,
        code: "INVALID_MODIFIER_TARGET",
      });
      valid = false;
    } else if (isPlainObject(raw.searchable)) {
      const searchableRaw = raw.searchable;
      const language = searchableRaw.language;
      if (language === undefined) {
        searchable = {};
      } else {
        if (typeof language !== "string" || language.length === 0) {
          issues.push({
            path: `${path}/searchable/language`,
            message: "`searchable.language` must be a non-empty string.",
            code: "INVALID_SEARCHABLE_LANGUAGE",
          });
          valid = false;
        } else {
          searchable = { language };
        }
      }
    } else {
      issues.push({
        path: `${path}/searchable`,
        message: "`searchable` must be a plain object (use `{}` for defaults).",
        code: "INVALID_PROPERTY_REFINEMENT",
      });
      valid = false;
    }
  }

  let embedding: { dimensions: number } | undefined;
  if (raw.embedding !== undefined) {
    if (propertyType === "array") {
      const itemsRaw = raw.items;
      const itemType = isPlainObject(itemsRaw) ? itemsRaw.type : undefined;
      if (itemType !== "number") {
        issues.push({
          path: `${path}/embedding`,
          message: '`embedding` requires `array.items.type === "number"`.',
          code: "INVALID_MODIFIER_TARGET",
        });
        valid = false;
      } else if (isPlainObject(raw.embedding)) {
        const dim = raw.embedding.dimensions;
        if (typeof dim !== "number" || !Number.isInteger(dim) || dim <= 0) {
          issues.push({
            path: `${path}/embedding/dimensions`,
            message: "`embedding.dimensions` must be a positive integer.",
            code: "INVALID_EMBEDDING_DIMENSIONS",
          });
          valid = false;
        } else {
          // `embedding(dimensions)` replaces the array's item validator with a
          // length+finite-number check; any extra refinements on the items
          // (min, max, int) would silently disappear at compile time.
          const itemsObject = isPlainObject(itemsRaw) ? itemsRaw : {};
          const extraneous = Object.keys(itemsObject).filter(
            (key) => key !== "type",
          );
          if (extraneous.length > 0) {
            issues.push({
              path: `${path}/items`,
              message: `\`embedding\` arrays must declare items as \`{ type: "number" }\` only — additional refinements (${extraneous.join(", ")}) are silently dropped by the embedding schema. Drop the refinements, or drop \`embedding\` and use a plain array.`,
              code: "INVALID_PROPERTY_REFINEMENT",
            });
            valid = false;
          } else {
            embedding = { dimensions: dim };
          }
        }
      } else {
        issues.push({
          path: `${path}/embedding`,
          message:
            "`embedding` must be a plain object with a `dimensions` field.",
          code: "INVALID_PROPERTY_REFINEMENT",
        });
        valid = false;
      }
    } else {
      issues.push({
        path: `${path}/embedding`,
        message: `\`embedding\` is only valid on array-of-number properties (got "${propertyType}").`,
        code: "INVALID_MODIFIER_TARGET",
      });
      valid = false;
    }
  }

  let description: string | undefined;
  if (raw.description !== undefined) {
    if (typeof raw.description === "string") {
      description = raw.description;
    } else {
      issues.push({
        path: `${path}/description`,
        message: "`description` must be a string.",
        code: "INVALID_PROPERTY_REFINEMENT",
      });
      valid = false;
    }
  }

  if (!valid) return undefined;
  return compactUndefined<NormalizedModifiers>({
    optional,
    searchable,
    embedding,
    description,
  });
}

// ============================================================
// Unique constraints
// ============================================================

function validateUniqueConstraints(
  raw: unknown,
  path: string,
  properties: Record<string, RuntimePropertyType>,
  issues: RuntimeExtensionIssue[],
): readonly RuntimeUniqueConstraint[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({
      path,
      message: "`unique` must be an array of constraint declarations.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: RuntimeUniqueConstraint[] = [];
  const names = new Set<string>();
  for (const [index, entry] of raw.entries()) {
    const constraintPath = `${path}/${index}`;
    if (!isPlainObject(entry)) {
      issues.push({
        path: constraintPath,
        message: "Unique constraint must be a plain object.",
        code: "INVALID_DOCUMENT_SHAPE",
      });
      continue;
    }

    const allowed = new Set(["name", "fields", "scope", "collation", "where"]);
    for (const key of Object.keys(entry)) {
      if (!allowed.has(key)) {
        issues.push({
          path: `${constraintPath}/${escapePointerSegment(key)}`,
          message: `Unknown unique-constraint key "${key}". Allowed: name, fields, scope, collation, where.`,
          code: "INVALID_DOCUMENT_SHAPE",
        });
      }
    }

    const constraint = entry;
    const name = constraint.name;
    if (typeof name !== "string" || name.length === 0) {
      issues.push({
        path: `${constraintPath}/name`,
        message: "Unique constraint `name` must be a non-empty string.",
        code: "INVALID_DOCUMENT_SHAPE",
      });
      continue;
    }
    if (names.has(name)) {
      issues.push({
        path: `${constraintPath}/name`,
        message: `Duplicate unique constraint name "${name}".`,
        code: "DUPLICATE_UNIQUE_CONSTRAINT",
      });
      continue;
    }
    names.add(name);

    const fieldsRaw = constraint.fields;
    if (!Array.isArray(fieldsRaw) || fieldsRaw.length === 0) {
      issues.push({
        path: `${constraintPath}/fields`,
        message:
          "Unique constraint `fields` must be a non-empty array of property names.",
        code: "EMPTY_UNIQUE_FIELDS",
      });
      continue;
    }

    const fields: string[] = [];
    const seenFields = new Set<string>();
    let fieldsValid = true;
    for (const [fieldIndex, field] of fieldsRaw.entries()) {
      if (typeof field !== "string" || field.length === 0) {
        issues.push({
          path: `${constraintPath}/fields/${fieldIndex}`,
          message: "Unique constraint field must be a non-empty string.",
          code: "INVALID_DOCUMENT_SHAPE",
        });
        fieldsValid = false;
        break;
      }
      if (seenFields.has(field)) {
        issues.push({
          path: `${constraintPath}/fields/${fieldIndex}`,
          message: `Duplicate field "${field}" in unique constraint.`,
          code: "DUPLICATE_UNIQUE_FIELD",
        });
        fieldsValid = false;
        break;
      }
      if (!(field in properties)) {
        issues.push({
          path: `${constraintPath}/fields/${fieldIndex}`,
          message: `Unique constraint field "${field}" is not declared on this kind.`,
          code: "UNKNOWN_UNIQUE_FIELD",
        });
        fieldsValid = false;
        break;
      }
      seenFields.add(field);
      fields.push(field);
    }
    if (!fieldsValid) continue;

    let scope: "kind" | "kindWithSubClasses" | undefined;
    if (constraint.scope !== undefined) {
      if (
        constraint.scope !== "kind" &&
        constraint.scope !== "kindWithSubClasses"
      ) {
        issues.push({
          path: `${constraintPath}/scope`,
          message: `Unique constraint scope must be "kind" or "kindWithSubClasses".`,
          code: "INVALID_DOCUMENT_SHAPE",
        });
        continue;
      }
      scope = constraint.scope;
    }

    let collation: "binary" | "caseInsensitive" | undefined;
    if (constraint.collation !== undefined) {
      if (
        constraint.collation !== "binary" &&
        constraint.collation !== "caseInsensitive"
      ) {
        issues.push({
          path: `${constraintPath}/collation`,
          message: `Unique constraint collation must be "binary" or "caseInsensitive".`,
          code: "INVALID_DOCUMENT_SHAPE",
        });
        continue;
      }
      collation = constraint.collation;
    }

    let where: { field: string; op: "isNull" | "isNotNull" } | undefined;
    if (constraint.where !== undefined) {
      const whereResult = validateUniqueWhere(
        constraint.where,
        `${constraintPath}/where`,
        properties,
        issues,
      );
      if (whereResult === undefined) continue;
      where = whereResult;
    }

    result.push(
      compactUndefined<RuntimeUniqueConstraint>({
        name,
        fields,
        scope,
        collation,
        where,
      }),
    );
  }

  return result;
}

function validateUniqueWhere(
  raw: unknown,
  path: string,
  properties: Record<string, RuntimePropertyType>,
  issues: RuntimeExtensionIssue[],
): { field: string; op: "isNull" | "isNotNull" } | undefined {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: "Unique constraint `where` must be `{ field, op }`.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }
  const allowed = new Set(["field", "op"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      issues.push({
        path: `${path}/${escapePointerSegment(key)}`,
        message: `Unknown where-clause key "${key}". Allowed: field, op.`,
        code: "INVALID_DOCUMENT_SHAPE",
      });
    }
  }
  const field = raw.field;
  const op = raw.op;
  if (typeof field !== "string" || field.length === 0) {
    issues.push({
      path: `${path}/field`,
      message: "Unique `where.field` must be a non-empty string.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }
  if (!(field in properties)) {
    issues.push({
      path: `${path}/field`,
      message: `Unique \`where.field\` "${field}" is not declared on this kind.`,
      code: "UNKNOWN_UNIQUE_WHERE_FIELD",
    });
    return undefined;
  }
  if (op !== "isNull" && op !== "isNotNull") {
    issues.push({
      path: `${path}/op`,
      message: `Unique \`where.op\` must be "isNull" or "isNotNull" (got ${describeUnknownValue(op)}).`,
      code: "INVALID_UNIQUE_WHERE_OP",
    });
    return undefined;
  }
  return { field, op };
}

// ============================================================
// Annotations
// ============================================================

function validateAnnotations(
  raw: unknown,
  path: string,
  ownerLabel: string,
  issues: RuntimeExtensionIssue[],
): KindAnnotations | undefined {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: `Annotations must be a plain JSON object.`,
      code: "INVALID_ANNOTATION",
    });
    return undefined;
  }

  try {
    assertJsonValue(raw, "annotations", ownerLabel);
  } catch (error) {
    if (error instanceof ConfigurationError) {
      const detailPath = (error.details as Record<string, unknown>).path;
      const annotationPath =
        typeof detailPath === "string" ?
          `${path}/${detailPath
            .replace(/^annotations\.?/, "")
            .replaceAll(".", "/")}`
        : path;
      issues.push({
        path: annotationPath,
        message: error.message,
        code: "INVALID_ANNOTATION",
      });
      return undefined;
    }
    throw error;
  }

  return raw as KindAnnotations;
}

// ============================================================
// Helpers
// ============================================================

function rejectUnknownRefinements(
  raw: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  propertyType: RuntimePropertyType["type"],
  issues: RuntimeExtensionIssue[],
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      issues.push({
        path: `${path}/${escapePointerSegment(key)}`,
        message: `Refinement "${key}" is not supported on ${propertyType} properties.`,
        code: "INVALID_PROPERTY_REFINEMENT",
      });
    }
  }
}

function validateNonNegativeInteger(
  value: unknown,
  path: string,
  label: string,
  code: RuntimeExtensionIssueCode,
  issues: RuntimeExtensionIssue[],
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    issues.push({
      path,
      message: `${label} must be a non-negative integer.`,
      code,
    });
    return undefined;
  }
  return value;
}

function validateOptionalString(
  value: unknown,
  path: string,
  issues: RuntimeExtensionIssue[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    issues.push({
      path,
      message: "`description` must be a string.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }
  return value;
}

function isValidKindName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/**
 * Renders an unknown value for inclusion in an error message without
 * tripping `[object Object]` from a generic `String()` call. Strings
 * are quoted; numbers, booleans, and null pass through; other values
 * use `JSON.stringify` and fall back to `typeof` if that fails.
 */
function describeUnknownValue(value: unknown): string {
  if (typeof value === "string") return `"${value}"`;
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  try {
    return JSON.stringify(value);
  } catch {
    return `(${typeof value})`;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Escapes a JSON-pointer reference segment per RFC 6901. `~` becomes
 * `~0`, `/` becomes `~1`. The resulting segment is appended after the
 * leading `/` separator.
 */
function escapePointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

// ============================================================
// Freezing
// ============================================================

function freezeDocument(input: {
  nodes: Record<string, RuntimeNodeDocument> | undefined;
  edges: Record<string, RuntimeEdgeDocument> | undefined;
  ontology: readonly RuntimeOntologyRelation[] | undefined;
}): RuntimeGraphDocument {
  return Object.freeze(
    compactUndefined<{
      nodes?: Record<string, RuntimeNodeDocument>;
      edges?: Record<string, RuntimeEdgeDocument>;
      ontology?: readonly RuntimeOntologyRelation[];
    }>({
      nodes: input.nodes === undefined ? undefined : freezeDeep(input.nodes),
      edges: input.edges === undefined ? undefined : freezeDeep(input.edges),
      ontology:
        input.ontology === undefined ?
          undefined
        : Object.freeze(
            input.ontology.map((entry) => Object.freeze({ ...entry })),
          ),
    }),
  );
}

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeDeep(nested);
  }
  return Object.freeze(value);
}
