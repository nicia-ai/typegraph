/**
 * Pure structural validation for `GraphExtension`.
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
import { isPlainObject } from "../utils/object";
import { err, ok, type Result } from "../utils/result";
import {
  type GraphExtensionIssue,
  type GraphExtensionIssueCode,
  GraphExtensionValidationError,
  GraphExtensionVersionUnsupportedError,
} from "./errors";
import {
  CURRENT_GRAPH_EXTENSION_VERSION,
  type ExtensionArrayProperty,
  type ExtensionBooleanProperty,
  type ExtensionEdgeDef,
  type ExtensionEnumProperty,
  type ExtensionIndex,
  type ExtensionNodeDef,
  type ExtensionNumberProperty,
  type ExtensionObjectFieldProperty,
  type ExtensionObjectProperty,
  type ExtensionOntologyRelation,
  type ExtensionPropertyType,
  type ExtensionStringProperty,
  type ExtensionUniqueConstraint,
  type GraphExtension,
  type GraphExtensionVersion,
  LEGACY_GRAPH_EXTENSION_VERSION,
} from "./extension-types";
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

// Per-property-type refinement-key sets were removed in the
// forward-compat pass — see the `rejectUnknownRefinements` removal
// docstring near the bottom of this file. Recognized refinements are
// still defined inline by the per-type validators that read them
// (e.g. `minLength` in `validateStringProperty`); unknown keys are
// silently passed through.

const SUPPORTED_STRING_FORMATS = new Set([
  "datetime",
  "uri",
  "email",
  "uuid",
  "date",
]);

/**
 * Recognized keys shared by every property-type descriptor. The strict
 * authoring path rejects unknown sibling keys against the union of this
 * set and the per-type allowlist below; the loose persistence-load path
 * passes them through untouched (a future v1.x.y writer may emit
 * additive keys an older v1 reader doesn't recognize).
 */
const COMMON_PROPERTY_KEYS: ReadonlySet<string> = new Set([
  "type",
  "optional",
  "description",
  "searchable",
  "embedding",
]);

const PROPERTY_TYPE_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  string: new Set(["minLength", "maxLength", "pattern", "format"]),
  number: new Set(["min", "max", "int"]),
  boolean: new Set(),
  enum: new Set(["values"]),
  array: new Set(["items"]),
  object: new Set(["properties"]),
};

/**
 * In strict mode, surface an `UNKNOWN_PROPERTY_KEY` issue for every
 * key on `raw` that's not in either allowlist. This is the LLM /
 * agent-trust-boundary check: a typo like `minLenght: 5` on a string
 * field, or a refinement key from a future v1.x that this library
 * doesn't recognize, would otherwise compile to a weaker schema with
 * no signal to the reviewer.
 */
function rejectUnknownPropertyKeys(
  raw: Record<string, unknown>,
  type: string,
  path: string,
  issues: GraphExtensionIssue[],
): void {
  const typeKeys = PROPERTY_TYPE_KEYS[type] ?? new Set<string>();
  const recognized = [...COMMON_PROPERTY_KEYS, ...typeKeys];
  for (const key of Object.keys(raw)) {
    if (COMMON_PROPERTY_KEYS.has(key) || typeKeys.has(key)) continue;
    issues.push({
      path: `${path}/${escapePointerSegment(key)}`,
      message: `Unknown property key "${key}" for type "${type}". Recognized keys: ${recognized.join(", ")}.`,
      code: "UNKNOWN_PROPERTY_KEY",
    });
  }
}

/**
 * Top-level keys recognized by the v1 graph-extension document. New additive
 * keys land here as the document format grows. Used by the strict
 * authoring path (`defineGraphExtension`) to surface typos like
 * `node` instead of `nodes`; the loose persistence-load path ignores
 * unknown keys for forward compatibility.
 */
const KNOWN_DOCUMENT_KEYS = new Set([
  "version",
  "nodes",
  "edges",
  "ontology",
  "indexes",
]);

type ValidateGraphExtensionOptions = Readonly<{
  /**
   * Reject unknown top-level keys and unsupported string formats.
   * Used by `defineGraphExtension`, where the document is being
   * authored fresh against the current library version — typos in
   * `nodes` / `format: "date-time"` etc. should fail loudly. The
   * persistence-load path leaves this off so a document committed by
   * a future v1.x writer with additive fields still parses on an
   * older v1 reader.
   */
  strict?: boolean;
}>;

/**
 * Validates a graph extension.
 *
 * Returns the (frozen, deeply normalized) extension on success, or a
 * `GraphExtensionValidationError` carrying every issue on authoring
 * failure. Unsupported future major versions throw
 * `GraphExtensionVersionUnsupportedError` immediately because the
 * current library cannot safely decode the rest of the document.
 * Callers that prefer exceptions for validation failures wrap the
 * returned `Result` with `unwrap()`.
 */
export function validateGraphExtension(
  input: unknown,
  options: ValidateGraphExtensionOptions = {},
): Result<GraphExtension, GraphExtensionValidationError> {
  const issues: GraphExtensionIssue[] = [];
  const strict = options.strict === true;

  if (!isPlainObject(input)) {
    issues.push({
      path: "",
      message: "Document must be a plain object.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return err(new GraphExtensionValidationError(issues));
  }

  const documentRecord = input;

  // Forward-compat: in non-strict (persistence-load) mode, unknown
  // top-level keys are intentionally NOT rejected. The persistence-
  // side zod schema is `.loose()` on every nested object, and the
  // documented format-versioning policy promises that additive minor
  // changes (a new top-level slice in a future v1.x.y) ride forward
  // without bumping the major. In strict (authoring) mode, unknown
  // keys surface as `UNKNOWN_DOCUMENT_KEY` so a typo like `node`
  // instead of `nodes` fails loudly instead of silently producing an
  // empty extension.
  if (strict) {
    for (const key of Object.keys(documentRecord)) {
      if (!KNOWN_DOCUMENT_KEYS.has(key)) {
        issues.push({
          path: `/${escapePointerSegment(key)}`,
          message: `Unknown top-level key "${key}". Did you mean one of: ${[...KNOWN_DOCUMENT_KEYS].join(", ")}?`,
          code: "UNKNOWN_DOCUMENT_KEY",
        });
      }
    }
  }

  const version = validateVersion(documentRecord.version, issues);

  const nodes = validateNodesSection(documentRecord.nodes, issues, strict);
  const edges = validateEdgesSection(documentRecord.edges, issues, strict);

  // Edge endpoints can reference (a) kinds declared in this same document,
  // (b) compile-time host kinds resolved at merge time, or (c) external
  // IRIs. The cross-graph resolution check happens at merge time, not
  // here.

  const ontology = validateOntologySection(documentRecord.ontology, issues);
  if (ontology !== undefined) {
    validateOntology(ontology, nodes, issues);
  }

  const indexes = validateIndexesSection(documentRecord.indexes, issues);

  if (issues.length > 0) {
    return err(new GraphExtensionValidationError(issues));
  }

  return ok(freezeDocument({ version, nodes, edges, ontology, indexes }));
}

/**
 * Validates the `version` field against the current supported major.
 *
 * Absent → resolved to `LEGACY_GRAPH_EXTENSION_VERSION` (a stable
 * `1`). The serializer omits `version` from the canonical persisted
 * form when it equals the legacy default, so the on-disk shape is
 * always version-less for v1 documents — the validator's absent →
 * legacy mapping closes that round-trip. Splitting `LEGACY` from
 * `CURRENT` is forward-looking design for future major bumps: when
 * v2 ships, `CURRENT` becomes `2` but `LEGACY` stays `1`, so a v1-era
 * stored document still parses as v1.
 *
 * Equal to current → accepted. Higher major → rejected with
 * `GRAPH_EXTENSION_VERSION_UNSUPPORTED`. Non-integer / non-positive
 * → rejected with `INVALID_DOCUMENT_SHAPE`.
 */
function validateVersion(
  raw: unknown,
  issues: GraphExtensionIssue[],
): GraphExtensionVersion {
  if (raw === undefined) return LEGACY_GRAPH_EXTENSION_VERSION;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 1) {
    issues.push({
      path: "/version",
      message: `Document version must be a positive integer; received ${JSON.stringify(raw)}.`,
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return LEGACY_GRAPH_EXTENSION_VERSION;
  }
  if (raw > CURRENT_GRAPH_EXTENSION_VERSION) {
    // Version mismatch is unrecoverable — the rest of the document
    // may use fields the current library can't decode. Throw the
    // typed class directly rather than batching into the issue list,
    // which is reserved for per-field validation problems a UI can
    // surface alongside others.
    throw new GraphExtensionVersionUnsupportedError(
      raw,
      CURRENT_GRAPH_EXTENSION_VERSION,
    );
  }
  return raw;
}

// ============================================================
// Section: nodes
// ============================================================

function validateNodesSection(
  rawNodes: unknown,
  issues: GraphExtensionIssue[],
  strict: boolean,
): Record<string, ExtensionNodeDef> | undefined {
  if (rawNodes === undefined) return undefined;

  if (!isPlainObject(rawNodes)) {
    issues.push({
      path: "/nodes",
      message: "`nodes` must be a plain object keyed by node-kind name.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: Record<string, ExtensionNodeDef> = {};
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

    const node = validateNodeDocument(kindName, rawNode, path, issues, strict);
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
  issues: GraphExtensionIssue[],
  strict: boolean,
): ExtensionNodeDef | undefined {
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
    strict,
  );
  if (properties === undefined) return undefined;

  const uniqueRaw = raw.unique;
  const unique = validateUniqueConstraints(
    uniqueRaw,
    `${path}/unique`,
    properties,
    issues,
  );

  return compactUndefined<ExtensionNodeDef>({
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
  issues: GraphExtensionIssue[],
  strict: boolean,
): Record<string, ExtensionEdgeDef> | undefined {
  if (rawEdges === undefined) return undefined;

  if (!isPlainObject(rawEdges)) {
    issues.push({
      path: "/edges",
      message: "`edges` must be a plain object keyed by edge-kind name.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: Record<string, ExtensionEdgeDef> = {};
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

    const edge = validateEdgeDocument(kindName, rawEdge, path, issues, strict);
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
  issues: GraphExtensionIssue[],
  strict: boolean,
): ExtensionEdgeDef | undefined {
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
        strict,
      );
  if (properties === undefined) return undefined;

  return compactUndefined<ExtensionEdgeDef>({
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
  issues: GraphExtensionIssue[],
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
  issues: GraphExtensionIssue[],
): ExtensionOntologyRelation[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({
      path: "/ontology",
      message: "`ontology` must be an array of relation objects.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: ExtensionOntologyRelation[] = [];
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
  ontology: readonly ExtensionOntologyRelation[],
  _nodes: Record<string, ExtensionNodeDef> | undefined,
  issues: GraphExtensionIssue[],
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
  // when the graph extension is merged with the existing graph.
  detectHierarchicalCycles(ontology, issues);

  // disjointWith ↔ subClassOf contradictions: declaring two kinds as
  // both subclass-related (subClassOf, broader, narrower) AND
  // disjointWith is incoherent — a subclass instance is also an
  // instance of its parent, so they can't be in disjoint sets.
  // Detect within the document; cross-document detection happens at
  // merge time when the registry's closures are rebuilt.
  detectDisjointHierarchyContradictions(ontology, issues);
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
  ontology: readonly ExtensionOntologyRelation[],
  issues: GraphExtensionIssue[],
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

/**
 * Detects `disjointWith` ↔ subClassOf-family contradictions: declaring
 * `(A, B) disjointWith` AND `(A, B) subClassOf` (or any subclass-
 * relating meta-edge) in the same document is incoherent — a subclass
 * instance is also an instance of its parent, so they can't be in
 * disjoint sets.
 *
 * Detection runs against the closure of the hierarchical relations
 * because `(A, B) subClassOf` plus `(B, C) subClassOf` makes A and C
 * disjoint-incompatible too. `narrower` / `hasPart` are flipped to
 * their canonical direction during normalization, mirroring how
 * `detectHierarchicalCycles` builds its groups.
 *
 * Cross-document contradictions (extension declares `disjointWith(A,B)`
 * while a previously-evolved extension declared `subClassOf(A,B)`) are
 * caught at merge time when the registry's closures are rebuilt.
 */
function detectDisjointHierarchyContradictions(
  ontology: readonly ExtensionOntologyRelation[],
  issues: GraphExtensionIssue[],
): void {
  const disjointPairs = new Set<string>();
  const disjointPath = new Map<string, string>();
  for (const [index, relation] of ontology.entries()) {
    if (relation.metaEdge !== "disjointWith") continue;
    // disjointWith is symmetric; record both orderings so the closure
    // check below catches the contradiction regardless of which side
    // the subclass relation orders by.
    disjointPairs.add(`${relation.from}|${relation.to}`);
    disjointPairs.add(`${relation.to}|${relation.from}`);
    disjointPath.set(`${relation.from}|${relation.to}`, `/ontology/${index}`);
    disjointPath.set(`${relation.to}|${relation.from}`, `/ontology/${index}`);
  }
  if (disjointPairs.size === 0) return;

  // Walk the closure of every hierarchical group; any (from, reachable)
  // pair that also appears in `disjointPairs` is a contradiction.
  type NormalizedEdge = Readonly<{
    from: string;
    to: string;
    originalIndex: number;
  }>;
  const groups = new Map<MetaEdgeName, NormalizedEdge[]>();
  for (const [index, relation] of ontology.entries()) {
    const normalization = HIERARCHICAL_NORMALIZATION.get(relation.metaEdge);
    if (normalization === undefined) continue;
    const from = normalization.flip ? relation.to : relation.from;
    const to = normalization.flip ? relation.from : relation.to;
    const list = groups.get(normalization.canonical) ?? [];
    list.push({ from, to, originalIndex: index });
    groups.set(normalization.canonical, list);
  }
  const reported = new Set<string>();
  for (const [name, edges] of groups) {
    const closure = computeTransitiveClosure(
      edges.map((edge) => [edge.from, edge.to] as const),
    );
    for (const [from, reachable] of closure) {
      for (const to of reachable) {
        const pairKey = `${from}|${to}`;
        if (!disjointPairs.has(pairKey)) continue;
        if (reported.has(pairKey)) continue;
        reported.add(pairKey);
        issues.push({
          path: disjointPath.get(pairKey) ?? "/ontology",
          message: `Contradiction: "${from}" and "${to}" are declared disjointWith but also related by "${name}" (directly or transitively).`,
          code: "ONTOLOGY_DISJOINT_CONFLICT",
        });
      }
    }
  }
}

// ============================================================
// Section: indexes
// ============================================================

const INDEX_SCOPE_VALUES: ReadonlySet<string> = new Set([
  "graphAndKind",
  "graph",
  "none",
]);

const EDGE_INDEX_DIRECTION_VALUES: ReadonlySet<string> = new Set([
  "out",
  "in",
  "none",
]);

const RUNTIME_INDEX_WHERE_OPS: ReadonlySet<string> = new Set([
  "isNull",
  "isNotNull",
]);

function validateIndexesSection(
  rawIndexes: unknown,
  issues: GraphExtensionIssue[],
): readonly ExtensionIndex[] | undefined {
  if (rawIndexes === undefined) return undefined;
  if (!Array.isArray(rawIndexes)) {
    issues.push({
      path: "/indexes",
      message: "`indexes` must be an array of index declarations.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: ExtensionIndex[] = [];
  const seenNames = new Set<string>();

  for (const [arrayIndex, entry] of rawIndexes.entries()) {
    const path = `/indexes/${arrayIndex}`;
    const validated = validateIndexEntry(entry, path, issues);
    if (validated === undefined) continue;

    if (validated.name !== undefined) {
      if (seenNames.has(validated.name)) {
        issues.push({
          path: `${path}/name`,
          message: `Duplicate index name "${validated.name}".`,
          code: "DUPLICATE_INDEX_NAME",
        });
        continue;
      }
      seenNames.add(validated.name);
    }
    result.push(validated);
  }

  return result;
}

function validateIndexEntry(
  raw: unknown,
  path: string,
  issues: GraphExtensionIssue[],
): ExtensionIndex | undefined {
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: "Index entry must be a plain object.",
      code: "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }

  const entity = raw.entity;
  if (entity !== "node" && entity !== "edge") {
    issues.push({
      path: `${path}/entity`,
      message: `Index \`entity\` must be "node" or "edge"; received ${describeUnknownValue(entity)}.`,
      code: "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }

  if (typeof raw.kind !== "string" || !isValidKindName(raw.kind)) {
    issues.push({
      path: `${path}/kind`,
      message:
        "Index `kind` must be a non-empty kind name matching /^[A-Za-z_][A-Za-z0-9_]*$/.",
      code: "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }

  const fields = validateStringList(raw.fields, `${path}/fields`, issues, {
    allowEmpty: false,
    label: "fields",
    emptyCode: "EMPTY_INDEX_FIELDS",
  });
  if (fields === undefined) return undefined;

  const coveringFields = validateStringList(
    raw.coveringFields,
    `${path}/coveringFields`,
    issues,
    { allowEmpty: true, label: "coveringFields" },
  );

  if (raw.unique !== undefined && typeof raw.unique !== "boolean") {
    issues.push({
      path: `${path}/unique`,
      message: "Index `unique` must be a boolean.",
      code: "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }

  let name: string | undefined;
  if (raw.name !== undefined) {
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      issues.push({
        path: `${path}/name`,
        message: "Index `name` must be a non-empty string.",
        code: "INVALID_INDEX_DECLARATION",
      });
      return undefined;
    }
    name = raw.name;
  }

  let scope: ExtensionIndex["scope"];
  if (raw.scope !== undefined) {
    if (typeof raw.scope !== "string" || !INDEX_SCOPE_VALUES.has(raw.scope)) {
      issues.push({
        path: `${path}/scope`,
        message: `Index \`scope\` must be one of: ${[...INDEX_SCOPE_VALUES].join(", ")}.`,
        code: "INVALID_INDEX_DECLARATION",
      });
      return undefined;
    }
    scope = raw.scope as ExtensionIndex["scope"];
  }

  const where = validateGraphExtensionIndexWhere(
    raw.where,
    `${path}/where`,
    issues,
  );

  if (entity === "node") {
    return compactUndefined<ExtensionIndex>({
      entity: "node",
      kind: raw.kind,
      name,
      fields,
      coveringFields,
      unique: raw.unique,
      scope,
      where,
    });
  }

  let direction: "out" | "in" | "none" | undefined;
  if (raw.direction !== undefined) {
    if (
      typeof raw.direction !== "string" ||
      !EDGE_INDEX_DIRECTION_VALUES.has(raw.direction)
    ) {
      issues.push({
        path: `${path}/direction`,
        message: `Edge index \`direction\` must be one of: ${[...EDGE_INDEX_DIRECTION_VALUES].join(", ")}.`,
        code: "INVALID_INDEX_DECLARATION",
      });
      return undefined;
    }
    direction = raw.direction as "out" | "in" | "none";
  }

  return compactUndefined<ExtensionIndex>({
    entity: "edge",
    kind: raw.kind,
    name,
    direction,
    fields,
    coveringFields,
    unique: raw.unique,
    scope,
    where,
  });
}

function validateStringList(
  raw: unknown,
  path: string,
  issues: GraphExtensionIssue[],
  options: Readonly<{
    allowEmpty: boolean;
    label: string;
    emptyCode?: GraphExtensionIssueCode;
  }>,
): readonly string[] | undefined {
  if (raw === undefined) {
    if (options.allowEmpty) return undefined;
    issues.push({
      path,
      message: `\`${options.label}\` is required and must contain at least one entry.`,
      code: options.emptyCode ?? "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }
  if (!Array.isArray(raw)) {
    issues.push({
      path,
      message: `\`${options.label}\` must be an array of strings.`,
      code: "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const [index, value] of raw.entries()) {
    if (typeof value !== "string" || value.length === 0) {
      issues.push({
        path: `${path}/${index}`,
        message: `\`${options.label}[${index}]\` must be a non-empty string.`,
        code: "INVALID_INDEX_DECLARATION",
      });
      return undefined;
    }
    if (seen.has(value)) {
      issues.push({
        path: `${path}/${index}`,
        message: `Duplicate ${options.label} entry "${value}".`,
        code: "INVALID_INDEX_DECLARATION",
      });
      return undefined;
    }
    seen.add(value);
    result.push(value);
  }
  if (!options.allowEmpty && result.length === 0) {
    issues.push({
      path,
      message: `\`${options.label}\` must contain at least one entry.`,
      code: options.emptyCode ?? "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }
  return result;
}

function validateGraphExtensionIndexWhere(
  raw: unknown,
  path: string,
  issues: GraphExtensionIssue[],
): ExtensionIndex["where"] {
  if (raw === undefined) return undefined;
  if (!isPlainObject(raw)) {
    issues.push({
      path,
      message: "Index `where` must be a plain object.",
      code: "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }
  if (typeof raw.field !== "string" || raw.field.length === 0) {
    issues.push({
      path: `${path}/field`,
      message: "`where.field` must be a non-empty string.",
      code: "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }
  if (typeof raw.op !== "string" || !RUNTIME_INDEX_WHERE_OPS.has(raw.op)) {
    issues.push({
      path: `${path}/op`,
      message: '`where.op` must be "isNull" or "isNotNull" in v1.',
      code: "INVALID_INDEX_DECLARATION",
    });
    return undefined;
  }
  return Object.freeze({
    field: raw.field,
    op: raw.op as "isNull" | "isNotNull",
  });
}

// ============================================================
// Properties and refinements
// ============================================================

function validatePropertiesMap(
  raw: unknown,
  path: string,
  ownerType: "node" | "edge",
  ownerName: string,
  issues: GraphExtensionIssue[],
  strict: boolean,
): Record<string, ExtensionPropertyType> | undefined {
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
  const result: Record<string, ExtensionPropertyType> = {};
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
    const validated = validateProperty(
      propertyValue,
      propertyPath,
      0,
      issues,
      strict,
    );
    if (validated === undefined) continue;
    result[propertyName] = validated;
  }

  return result;
}

function validateProperty(
  raw: unknown,
  path: string,
  depth: number,
  issues: GraphExtensionIssue[],
  strict: boolean,
): ExtensionPropertyType | undefined {
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

  // Strict authoring mode: reject unknown sibling keys against the
  // per-type allowlist BEFORE dispatch. A typo like `minLenght` on a
  // string property would otherwise compile to a `z.string()` with no
  // length constraint and ship through to ingest. Persistence-load
  // mode skips this so a future v1.x.y writer's additive keys ride
  // forward.
  if (strict) rejectUnknownPropertyKeys(property, type, path, issues);

  switch (type) {
    case "string": {
      return validateStringProperty(property, path, issues, strict);
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
      return validateArrayProperty(property, path, depth, issues, strict);
    }
    case "object": {
      return validateObjectProperty(property, path, depth, issues, strict);
    }
  }
  return undefined;
}

function validateStringProperty(
  raw: Record<string, unknown>,
  path: string,
  issues: GraphExtensionIssue[],
  strict: boolean,
): ExtensionStringProperty | undefined {
  // Forward-compat: unknown refinement keys are silently accepted.
  // See `rejectUnknownRefinements` removal docstring for details.
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

  let format: ExtensionStringProperty["format"];
  if (raw.format !== undefined) {
    if (typeof raw.format !== "string") {
      issues.push({
        path: `${path}/format`,
        message: `String format must be a string; received ${describeUnknownValue(raw.format)}.`,
        code: "INVALID_PROPERTY_REFINEMENT",
      });
    } else if (SUPPORTED_STRING_FORMATS.has(raw.format)) {
      format = raw.format as ExtensionStringProperty["format"];
    } else if (strict) {
      // Authoring-mode reject. A typo like `"date-time"` (no
      // hyphen) silently compiled to a plain `z.string()` in earlier
      // versions, so `safeParse("not-a-date")` succeeded — surfacing
      // the typo here is the contract.
      issues.push({
        path: `${path}/format`,
        message: `Unsupported string format "${raw.format}". Supported: ${[...SUPPORTED_STRING_FORMATS].join(", ")}.`,
        code: "UNSUPPORTED_STRING_FORMAT",
      });
    }
    // Non-strict (persistence-load) path: unknown format silently
    // drops to a plain `z.string()`. A future v1.x.y writer may
    // introduce a new format identifier; an older v1 reader still
    // parses the document, just without the new format's behaviour.
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

  return compactUndefined<ExtensionStringProperty>({
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
  issues: GraphExtensionIssue[],
): ExtensionNumberProperty | undefined {
  // Forward-compat: unknown refinement keys are silently accepted.
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

  return compactUndefined<ExtensionNumberProperty>({
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
  issues: GraphExtensionIssue[],
): ExtensionBooleanProperty | undefined {
  // Forward-compat: unknown refinement keys are silently accepted.
  const modifiers = validatePropertyModifiers(raw, path, "boolean", issues);
  if (modifiers === undefined) return undefined;
  return compactUndefined<ExtensionBooleanProperty>({
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
  issues: GraphExtensionIssue[],
): ExtensionEnumProperty | undefined {
  // Forward-compat: unknown refinement keys are silently accepted.
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

  return compactUndefined<ExtensionEnumProperty>({
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
  issues: GraphExtensionIssue[],
  strict: boolean,
): ExtensionArrayProperty | undefined {
  // Forward-compat: unknown refinement keys are silently accepted.
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
  const items = validateProperty(
    itemsRaw,
    `${path}/items`,
    depth + 1,
    issues,
    strict,
  );
  if (items === undefined) return undefined;
  if (items.type === "array") {
    // Defensive: shouldn't be reachable because we checked above, but keeps
    // the cast tight.
    return undefined;
  }

  const modifiers = validatePropertyModifiers(raw, path, "array", issues);
  if (modifiers === undefined) return undefined;

  return compactUndefined<ExtensionArrayProperty>({
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
  issues: GraphExtensionIssue[],
  strict: boolean,
): ExtensionObjectProperty | undefined {
  // Forward-compat: unknown refinement keys are silently accepted.
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

  const fields: Record<string, ExtensionObjectFieldProperty> = {};
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
    const field = validateProperty(value, fieldPath, depth + 1, issues, strict);
    if (field === undefined) continue;
    fields[name] = field as ExtensionObjectFieldProperty;
  }

  const modifiers = validatePropertyModifiers(raw, path, "object", issues);
  if (modifiers === undefined) return undefined;

  return compactUndefined<ExtensionObjectProperty>({
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
  propertyType: ExtensionPropertyType["type"],
  issues: GraphExtensionIssue[],
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
  properties: Record<string, ExtensionPropertyType>,
  issues: GraphExtensionIssue[],
): readonly ExtensionUniqueConstraint[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    issues.push({
      path,
      message: "`unique` must be an array of constraint declarations.",
      code: "INVALID_DOCUMENT_SHAPE",
    });
    return undefined;
  }

  const result: ExtensionUniqueConstraint[] = [];
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
      compactUndefined<ExtensionUniqueConstraint>({
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
  properties: Record<string, ExtensionPropertyType>,
  issues: GraphExtensionIssue[],
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
  issues: GraphExtensionIssue[],
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

// Two-mode unknown-key handling — see `rejectUnknownPropertyKeys`
// above. Strict authoring (`defineGraphExtension`,
// `validateGraphExtension(_, { strict: true })`) rejects unknown
// sibling keys at every property level so a `minLenght`-style typo
// from an LLM proposal surfaces with a JSON-pointer path instead of
// silently compiling to a weaker schema. Persistence load
// (`validateGraphExtension(_, { strict: false })`, used by the
// `createStoreWithSchema` reader) ignores unknown keys so a future
// v1.x.y writer with additive refinements still parses on an older
// v1 reader — the older compiler builds the Zod schema from the
// refinements it recognizes, and the new modifier's behavior simply
// isn't applied. `ExtensionPropertyType` is exported so consumers
// writing runtime-shape generators can add their own strict-key check
// if needed for additional validation slots beyond what this
// validator covers.

function validateNonNegativeInteger(
  value: unknown,
  path: string,
  label: string,
  code: GraphExtensionIssueCode,
  issues: GraphExtensionIssue[],
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
  issues: GraphExtensionIssue[],
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
  version: GraphExtensionVersion;
  nodes: Record<string, ExtensionNodeDef> | undefined;
  edges: Record<string, ExtensionEdgeDef> | undefined;
  ontology: readonly ExtensionOntologyRelation[] | undefined;
  indexes: readonly ExtensionIndex[] | undefined;
}): GraphExtension {
  return Object.freeze(
    compactUndefined<{
      version: GraphExtensionVersion;
      nodes?: Record<string, ExtensionNodeDef>;
      edges?: Record<string, ExtensionEdgeDef>;
      ontology?: readonly ExtensionOntologyRelation[];
      indexes?: readonly ExtensionIndex[];
    }>({
      version: input.version,
      nodes: input.nodes === undefined ? undefined : freezeDeep(input.nodes),
      edges: input.edges === undefined ? undefined : freezeDeep(input.edges),
      ontology:
        input.ontology === undefined ?
          undefined
        : Object.freeze(
            input.ontology.map((entry) => Object.freeze({ ...entry })),
          ),
      indexes:
        input.indexes === undefined ?
          undefined
        : Object.freeze(input.indexes.map((entry) => freezeDeep({ ...entry }))),
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
