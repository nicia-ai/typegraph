/** Pure preparation for a schema evolution; database-dependent guards run at apply time. */
import type { EdgeCardinalityDeclaration } from "../backend/types";
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
import type { OntologyChange } from "./ontology-change";
import {
  prepareSchemaTighteningPreflight,
  type SchemaTighteningPreflight,
} from "./tightening-preflight";
import type { SchemaHash, SchemaIdentity, SerializedSchema } from "./types";

/** A planned schema delta, database-dependent check, or provisioning requirement. */
export type EvolutionRequirement =
  | Readonly<{
      kind: "require-empty";
      entity: "node" | "edge";
      kindName: string;
    }>
  | Readonly<{
      /** A kind added by this delta; does not imply a pending removal or cleanup work. */
      kind: "new-kind";
      entity: "node" | "edge";
      kindName: string;
    }>
  | Readonly<{
      kind: "vector-slot";
      nodeKind: string;
      fieldPath: string;
    }>
  | Readonly<{
      /**
       * Existing rows must satisfy an ontology axiom or edge cardinality this
       * delta newly declares; apply refuses with the same `MigrationError`
       * `Store.evolve()` raises when they do not.
       */
      kind: "ontology-tightening";
      changes: readonly OntologyChange[];
      edgeCardinalityAxes: readonly EdgeCardinalityDeclaration[];
    }>
  | Readonly<{
      kind: "identity";
      nodeKinds: readonly string[];
    }>;

/** Ordered requirements exposed by a change plan. */
export type EvolutionRequirements = readonly EvolutionRequirement[];

/** Private instructions retained for the Store's apply-time checks. */
export type EvolutionPlanRequirements = Readonly<{
  requireEmpty: readonly Extract<
    EvolutionRequirement,
    { kind: "require-empty" }
  >[];
  addedKinds: readonly Extract<EvolutionRequirement, { kind: "new-kind" }>[];
  vectorSlots: readonly Extract<
    EvolutionRequirement,
    { kind: "vector-slot" }
  >[];
  identityAffectedKinds: readonly string[];
  /** The data preflight the delta's ontology or edge-cardinality tightening owes. */
  schemaTightening: SchemaTighteningPreflight | undefined;
}>;

declare const evolutionPlanBrand: unique symbol;

type EvolutionPlanBase = Readonly<{
  graphId: string;
  baseline: SchemaIdentity;
  result: SchemaIdentity;
  /** Only this module can mint a plan accepted by withEvolvedTransaction. */
  [evolutionPlanBrand]: true;
}>;

/**
 * A prepared schema change. Plans are module-bound, nonserializable values:
 * object spreads, clones, and reconstructed data cannot be applied.
 */
export type EvolutionPlan =
  | (EvolutionPlanBase & Readonly<{ status: "noop" }>)
  | (EvolutionPlanBase &
      Readonly<{
        status: "change";
        requirements: EvolutionRequirements;
      }>);

export type EvolutionPlanPayload<G extends GraphDef> = Readonly<{
  baselineGraph: G;
  mergedGraph: G;
  requirements?: EvolutionPlanRequirements;
  classification?: ReturnType<typeof classifyModifications>;
  schemaDocument?: SerializedSchema;
  vectorSlots?: readonly VectorSlot[];
}>;

const PLAN_PAYLOADS = new WeakMap<
  EvolutionPlan,
  EvolutionPlanPayload<GraphDef>
>();

function mintEvolutionPlan(
  fields:
    | (Omit<EvolutionPlanBase, typeof evolutionPlanBrand> &
        Readonly<{ status: "noop" }>)
    | (Omit<EvolutionPlanBase, typeof evolutionPlanBrand> &
        Readonly<{ status: "change"; requirements: EvolutionRequirements }>),
): EvolutionPlan {
  return Object.freeze(fields) as EvolutionPlan;
}

function newlyAddedKinds(
  existing: GraphExtension,
  next: GraphExtension,
): EvolutionPlanRequirements["addedKinds"] {
  const nodes = Object.keys(next.nodes ?? {})
    .filter((kindName) => !Object.hasOwn(existing.nodes ?? {}, kindName))
    .map((kindName) =>
      Object.freeze({
        kind: "new-kind" as const,
        entity: "node" as const,
        kindName,
      }),
    );
  const edges = Object.keys(next.edges ?? {})
    .filter((kindName) => !Object.hasOwn(existing.edges ?? {}, kindName))
    .map((kindName) =>
      Object.freeze({
        kind: "new-kind" as const,
        entity: "edge" as const,
        kindName,
      }),
    );
  return Object.freeze([...nodes, ...edges]);
}

function newlyAddedVectorSlots(
  existing: GraphExtension,
  next: GraphExtension,
): EvolutionPlanRequirements["vectorSlots"] {
  const slots: Extract<EvolutionRequirement, { kind: "vector-slot" }>[] = [];
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
        slots.push(
          Object.freeze({
            kind: "vector-slot",
            nodeKind: kindName,
            fieldPath: fieldName,
          }),
        );
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
    const baseline = Object.freeze({
      version: baselineVersion,
      hash: baselineHash,
    });
    const plan = mintEvolutionPlan({
      status: "noop",
      graphId: baselineGraph.id,
      baseline,
      result: baseline,
    });
    PLAN_PAYLOADS.set(
      plan,
      Object.freeze({ baselineGraph, mergedGraph: baselineGraph }),
    );
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
  // Derived from the exact before/after documents this plan commits, the
  // same pair `Store.evolve()` hands the same preflight.
  const schemaTightening = prepareSchemaTighteningPreflight({
    graphId: baselineGraph.id,
    fromVersion: baselineVersion,
    toVersion: resultingVersion,
    before: storedSchema,
    after: schemaDocument,
  });
  const groupedRequirements: EvolutionPlanRequirements = Object.freeze({
    requireEmpty: Object.freeze(
      classification.requireEmpty.map((entry) =>
        Object.freeze({
          kind: "require-empty" as const,
          entity: entry.entity,
          kindName: entry.kindName,
        }),
      ),
    ),
    addedKinds,
    vectorSlots: newlyAddedVectorSlots(existingExtension, extension),
    identityAffectedKinds: Object.freeze(
      identityKindsRequiringPreflight(baselineGraph, mergedGraph),
    ),
    schemaTightening,
  });
  const requirements: EvolutionRequirements = Object.freeze([
    ...groupedRequirements.requireEmpty,
    ...groupedRequirements.addedKinds,
    ...groupedRequirements.vectorSlots,
    ...(schemaTightening === undefined ?
      []
    : [
        freezeDeep({
          kind: "ontology-tightening" as const,
          changes: schemaTightening.probedChanges,
          edgeCardinalityAxes: schemaTightening.newlyConstrainedAxes,
        }),
      ]),
    ...(groupedRequirements.identityAffectedKinds.length > 0 ?
      [
        Object.freeze({
          kind: "identity" as const,
          nodeKinds: groupedRequirements.identityAffectedKinds,
        }),
      ]
    : []),
  ]);
  const plan = mintEvolutionPlan({
    status: "change",
    graphId: baselineGraph.id,
    baseline: Object.freeze({ version: baselineVersion, hash: baselineHash }),
    result: Object.freeze({ version: resultingVersion, hash: resultingHash }),
    requirements,
  });
  PLAN_PAYLOADS.set(
    plan,
    Object.freeze({
      baselineGraph,
      mergedGraph,
      requirements: groupedRequirements,
      classification,
      schemaDocument,
      vectorSlots: freezeDeep(
        resolveGraphVectorSlots(mergedGraph).filter((slot) =>
          groupedRequirements.vectorSlots.some(
            (required) =>
              required.nodeKind === slot.nodeKind &&
              required.fieldPath === slot.fieldPath,
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
