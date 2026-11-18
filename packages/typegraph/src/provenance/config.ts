import type { GraphDef } from "../core/define-graph";
import { projectTargetKinds } from "../core/edge-endpoints";
import { ConfigurationError } from "../errors";
import type { KindRegistry } from "../registry";
import { requiredCompositionPairs } from "../store/operations/composition-create";
import { compareStrings, compareStringTuples } from "../utils/compare";
import { requireDefined } from "../utils/presence";
import {
  type ProvenanceRetractionConfig,
  type ProvenanceSourceConfig,
} from "./types";

const DEFAULT_RETRACTED_FIELD = "retracted";

export type NormalizedConfig = Readonly<{
  sourceKinds: readonly string[];
  retractedField: string;
  justificationKind: string;
  factKinds: readonly string[];
  premiseOfKind: string;
  derivesKind: string;
}>;

export function normalizeConfig<G extends GraphDef>(
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

  for (const kind of sourceKinds) {
    assertKind(graph.nodes, kind, "source", "node", graph.id);
  }
  assertKind(graph.nodes, justificationKind, "justification", "node", graph.id);
  for (const kind of factKinds) {
    assertKind(graph.nodes, kind, "fact", "node", graph.id);
  }
  for (const kind of sourceKinds)
    assertSourceField(graph, kind, retractedField);
  assertKind(graph.edges, premiseOfKind, "premiseOf", "edge", graph.id);
  assertKind(graph.edges, derivesKind, "derives", "edge", graph.id);

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
  return [...duplicates].toSorted((left, right) => compareStrings(left, right));
}

function assertKind(
  records: Readonly<Record<string, unknown>>,
  kind: string,
  role: string,
  noun: "node" | "edge",
  graphId: string,
): void {
  if (Object.hasOwn(records, kind)) return;
  throw new ConfigurationError(
    `Provenance ${role} kind "${kind}" is not a ${noun} kind in this graph.`,
    { role, kind, graphId },
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
  const toKinds = new Set(projectTargetKinds(registration.to));
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

export function isPremiseKind(config: NormalizedConfig, kind: string): boolean {
  return config.sourceKinds.includes(kind) || config.factKinds.includes(kind);
}

/**
 * Refuses a configuration whose fact kinds own required composition parts the
 * capability cannot reach.
 *
 * A required part's belief status follows its whole's, and the close that
 * enforces that runs over FACTS. So a fact kind that is the whole of a
 * required pair whose part kind is not itself a fact kind is a hole no
 * transition can fill: closing the whole would leave a live required part
 * hanging from a closed whole, exactly the state this capability exists to
 * prevent. Refused at configuration time, where the graph's author can fix it,
 * rather than at the first retraction that happens to reach such a whole.
 *
 * Both sides are read through the registry's composition readers and expanded
 * through subsumption: the whole side because a fact kind may be a SUBCLASS of
 * the kind a pair declared its whole against, the part side because a subclass
 * of a declared required part kind is exactly as required as the declared kind
 * (`requiredCompositionPartKinds` expands the same way).
 */
export function assertRequiredPartsOfFactWholesAreFacts(
  registry: KindRegistry,
  config: NormalizedConfig,
): void {
  const factKinds = new Set(config.factKinds);
  const offenders: Readonly<{ wholeKind: string; partKind: string }>[] = [];
  for (const pair of requiredCompositionPairs(registry)) {
    for (const wholeKind of config.factKinds) {
      if (!registry.isAssignableTo(wholeKind, pair.wholeKind)) continue;
      for (const partKind of pair.partKinds) {
        if (factKinds.has(partKind)) continue;
        offenders.push({ wholeKind, partKind });
      }
    }
  }
  if (offenders.length === 0) return;

  const ordered = offenders.toSorted((left, right) =>
    compareStringTuples(
      [left.wholeKind, left.partKind],
      [right.wholeKind, right.partKind],
    ),
  );
  const first = requireDefined(ordered[0], "a non-empty offender list");
  throw new ConfigurationError(
    `Provenance fact kind "${first.wholeKind}" is the whole of required composition part kind "${first.partKind}", which is not a fact kind.`,
    {
      code: "PROVENANCE_REQUIRED_PART_NOT_A_FACT",
      wholeKind: first.wholeKind,
      partKind: first.partKind,
      requiredParts: ordered,
    },
    {
      suggestion: `Add "${first.partKind}" to fact.kinds (and give it a \`derives\` endpoint), or declare that composition pair \`existence: "optional"\`.`,
    },
  );
}

export function assertRetractionHistoryEnabled(
  store: Readonly<{ historyEnabled: boolean; graphId: string }>,
): void {
  if (!store.historyEnabled) {
    throw new ConfigurationError(
      "createRetractionCapability requires a store created with { history: true }.",
      { graphId: store.graphId },
      {
        suggestion:
          "Use createStoreWithSchema(graph, backend, { history: true }) so retraction mutations are captured and queryable with asOfRecorded().",
      },
    );
  }
}
