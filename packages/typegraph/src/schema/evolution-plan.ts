/** Pure preparation for a schema evolution; database-dependent guards run at apply time. */
import type { GraphDef } from "../core/define-graph";
import { resolveGraphVectorSlots } from "../core/embedding";
import { classifyModifications } from "../graph-extension/classify";
import { IncompatibleChangeError } from "../graph-extension/errors";
import type { GraphExtension } from "../graph-extension/extension-types";
import { mergeGraphExtension } from "../graph-extension/merge";
import type { VectorSlot } from "../query/dialect/vector-strategy";
import { freezeDeep } from "../utils/object";
import { canonicalEqual } from "./canonical";
import { prepareNewSchemaVersion } from "./new-schema-version";
import type { SchemaHash, SerializedSchema } from "./types";

export type EvolutionRequirements = Readonly<{
  requireEmpty: readonly Readonly<{
    entity: "node" | "edge";
    kindName: string;
  }>[];
  /** Newly introduced node/edge kinds must be checked for pending cleanup. */
  readdedKindCandidates: readonly Readonly<{
    entity: "node" | "edge";
    kindName: string;
  }>[];
  /** New embedding slots require transactional vector provisioning. */
  vectorSlots: readonly Readonly<{ kindName: string; fieldName: string }>[];
  /** Ontology changes require revalidating and rebuilding identity relations. */
  identityAffectedKinds: readonly string[];
}>;

type EvolutionPlanBase = Readonly<{
  graphId: string;
  baselineVersion: number;
  baselineHash: SchemaHash;
  resultingHash: SchemaHash;
}>;

export type EvolutionPlan =
  | (EvolutionPlanBase & Readonly<{ status: "noop" }>)
  | (EvolutionPlanBase &
      Readonly<{
        status: "change";
        resultingVersion: number;
        requirements: EvolutionRequirements;
      }>);

export type EvolutionPlanPayload<G extends GraphDef> = Readonly<{
  mergedGraph: G;
  classification?: ReturnType<typeof classifyModifications>;
  schemaDocument?: SerializedSchema;
  vectorSlots?: readonly VectorSlot[];
}>;

const PLAN_PAYLOADS = new WeakMap<
  EvolutionPlan,
  EvolutionPlanPayload<GraphDef>
>();

function newlyAddedKinds(
  existing: GraphExtension,
  next: GraphExtension,
): EvolutionRequirements["readdedKindCandidates"] {
  const nodes = Object.keys(next.nodes ?? {})
    .filter((kindName) => !Object.hasOwn(existing.nodes ?? {}, kindName))
    .map((kindName) => Object.freeze({ entity: "node" as const, kindName }));
  const edges = Object.keys(next.edges ?? {})
    .filter((kindName) => !Object.hasOwn(existing.edges ?? {}, kindName))
    .map((kindName) => Object.freeze({ entity: "edge" as const, kindName }));
  return Object.freeze([...nodes, ...edges]);
}

function newlyAddedVectorSlots(
  existing: GraphExtension,
  next: GraphExtension,
): EvolutionRequirements["vectorSlots"] {
  const slots: { kindName: string; fieldName: string }[] = [];
  for (const [kindName, node] of Object.entries(next.nodes ?? {})) {
    const previous =
      Object.hasOwn(existing.nodes ?? {}, kindName) ?
        existing.nodes?.[kindName]
      : undefined;
    for (const [fieldName, property] of Object.entries(node.properties)) {
      if (
        property.embedding !== undefined &&
        previous?.properties[fieldName]?.embedding === undefined
      ) {
        slots.push(Object.freeze({ kindName, fieldName }));
      }
    }
  }
  return Object.freeze(slots);
}

function identityKindsRequiringPreflight<G extends GraphDef>(
  baselineGraph: G,
  mergedGraph: G,
): readonly string[] {
  if (baselineGraph.identity === undefined) return [];
  if (
    !canonicalEqual(
      baselineGraph.extension?.ontology,
      mergedGraph.extension?.ontology,
    )
  ) {
    return Object.keys(mergedGraph.nodes);
  }
  // New kinds have no existing identity members. Kind removal cascades its
  // assertions, and the apply-time pending-removal guard protects re-addition.
  // An unrelated kind or scalar field therefore owes no identity scan.
  return [];
}

/**
 * Prepare the semantic evolution once, against a named schema snapshot.
 * The caller owns snapshot freshness; this function performs no database I/O.
 */
export async function prepareEvolutionPlan<G extends GraphDef>(
  params: Readonly<{
    baselineGraph: G;
    baselineVersion: number;
    baselineHash: SchemaHash;
    storedSchema: SerializedSchema;
    extension: GraphExtension;
  }>,
): Promise<EvolutionPlan> {
  const {
    baselineGraph,
    baselineVersion,
    baselineHash,
    storedSchema,
    extension: callerExtension,
  } = params;
  const extension = freezeDeep(structuredClone(callerExtension));
  const mergedGraph = mergeGraphExtension(baselineGraph, extension);
  if (mergedGraph === baselineGraph) {
    const plan: EvolutionPlan = Object.freeze({
      status: "noop",
      graphId: baselineGraph.id,
      baselineVersion,
      baselineHash,
      resultingHash: baselineHash,
    });
    PLAN_PAYLOADS.set(plan, Object.freeze({ mergedGraph: baselineGraph }));
    return plan;
  }

  const existingExtension = baselineGraph.extension ?? Object.freeze({});
  const classification = classifyModifications(existingExtension, extension);
  if (classification.incompatible.length > 0) {
    throw new IncompatibleChangeError(
      classification.incompatible,
      baselineGraph.id,
    );
  }
  const prepared = await prepareNewSchemaVersion(
    mergedGraph,
    baselineVersion,
    storedSchema,
  );
  const resultingVersion = prepared.version;
  const schemaDocument = freezeDeep(prepared.schemaDocument);
  const resultingHash = prepared.schemaHash;
  const addedKinds = newlyAddedKinds(existingExtension, extension);
  const requirements: EvolutionRequirements = Object.freeze({
    requireEmpty: Object.freeze(
      classification.requireEmpty.map((entry) =>
        Object.freeze({ entity: entry.entity, kindName: entry.kindName }),
      ),
    ),
    readdedKindCandidates: addedKinds,
    vectorSlots: newlyAddedVectorSlots(existingExtension, extension),
    identityAffectedKinds: Object.freeze(
      identityKindsRequiringPreflight(baselineGraph, mergedGraph),
    ),
  });
  const plan: EvolutionPlan = Object.freeze({
    status: "change",
    graphId: baselineGraph.id,
    baselineVersion,
    baselineHash,
    resultingHash,
    resultingVersion,
    requirements,
  });
  PLAN_PAYLOADS.set(
    plan,
    Object.freeze({
      mergedGraph,
      classification,
      schemaDocument,
      vectorSlots: freezeDeep(
        resolveGraphVectorSlots(mergedGraph).filter((slot) =>
          requirements.vectorSlots.some(
            (required) =>
              required.kindName === slot.nodeKind &&
              required.fieldName === slot.fieldPath,
          ),
        ),
      ),
    }),
  );
  return plan;
}

/** Refuse forged or modified objects before using private execution instructions. */
export function getEvolutionPlanPayload<G extends GraphDef>(
  plan: EvolutionPlan,
): EvolutionPlanPayload<G> | undefined {
  return PLAN_PAYLOADS.get(plan) as EvolutionPlanPayload<G> | undefined;
}
