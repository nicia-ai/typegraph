/**
 * Validation + default-application for {@link MergeOptions}.
 *
 * The zod schema validates the scalar / enum surface (thresholds, ceilings,
 * enums) and applies the frozen P0 defaults. Function- and store-valued fields
 * (`canonical`, a function `onPropertyConflict`, `target`, per-kind `block` /
 * `custom.score`, `branchOrder`) are not meaningfully validatable by zod, so they
 * are threaded through unchanged after the scalar surface validates.
 *
 * `normalizeMergeOptions` is the single entry point: it returns a
 * {@link NormalizedMergeOptions} with every default resolved, so downstream
 * phases never branch on `undefined`.
 */

import { z } from "zod";

import { createDataKeyedBag } from "../utils/object";
import type { IdentityAssertionConflictPolicy } from "./identity-three-way";
import type { GraphDef } from "./typegraph-internal";
import type {
  BranchId,
  CandidateDiagnosticsOptions,
  ComparisonCeilingPolicy,
  DeleteModifyPolicy,
  Embedder,
  IdentityReconciliationOptions,
  MergeOptions,
  PropertyConflictPolicy,
  ReconcileTypesMode,
  ResolveConfig,
  ResolvedCluster,
  ResolveMap,
} from "./types";

/**
 * Frozen P0 defaults. Exported so tests and downstream phases assert against the
 * same constants rather than re-typing literals.
 */
export const MERGE_OPTION_DEFAULTS = {
  reconcileTypes: "off",
  onPropertyConflict: "flag",
  onBasePropertyConflict: "flag",
  onDeleteModifyConflict: "flag",
  onComparisonCeiling: "error",
  provenance: true,
  persistProvenance: false,
  identity: {
    pairing: "off",
    onAssertionConflict: "refuse",
    onEdgeConflict: "repoint",
    onUniquenessConflict: "refuse",
    onProvenanceConflict: "keepBoth",
  },
} as const satisfies Readonly<{
  reconcileTypes: ReconcileTypesMode;
  onPropertyConflict: "flag";
  onBasePropertyConflict: "flag";
  onDeleteModifyConflict: DeleteModifyPolicy;
  onComparisonCeiling: ComparisonCeilingPolicy;
  provenance: boolean;
  persistProvenance: boolean;
  identity: Readonly<{
    pairing: "off";
    onAssertionConflict: "refuse";
    onEdgeConflict: "repoint";
    onUniquenessConflict: "refuse";
    onProvenanceConflict: "keepBoth";
  }>;
}>;

/**
 * zod schema for the STRING arm of `onPropertyConflict`. The field is a union of
 * this enum and a function; the function arm is not validatable by zod, but the
 * string arm is — and validating it here keeps `onPropertyConflict` consistent with
 * every other enum option, so a bad string fails with a clean option error rather
 * than an opaque `TypeError` deep inside conflict resolution.
 */
const propertyConflictPolicySchema = z.enum([
  "flag",
  "lastWriteWins",
  "provenanceWeighted",
]);

/**
 * zod schema for the STRING arm of `identity.onAssertionConflict` (the
 * function arm is not validatable by zod, exactly the `onPropertyConflict`
 * precedent above).
 */
const identityAssertionConflictPolicySchema = z.enum([
  "refuse",
  "assertWins",
  "retractWins",
  "flag",
]);

/**
 * zod schema for `identity`'s scalar surface, EXCLUDING `onAssertionConflict`
 * (validated separately, like `onPropertyConflict`, since it admits a
 * function arm). `.strict()` so a mistyped sub-option is refused rather than
 * silently ignored.
 */
const identityOptionsScalarSchema = z
  .object({
    pairing: z
      .enum(["off", "candidate", "definitional"])
      .default(MERGE_OPTION_DEFAULTS.identity.pairing),
    onEdgeConflict: z
      .enum(["repoint", "flag"])
      .default(MERGE_OPTION_DEFAULTS.identity.onEdgeConflict),
    onUniquenessConflict: z
      .enum(["refuse", "flag"])
      .default(MERGE_OPTION_DEFAULTS.identity.onUniquenessConflict),
    onProvenanceConflict: z
      .enum(["keepBoth", "refuse"])
      .default(MERGE_OPTION_DEFAULTS.identity.onProvenanceConflict),
  })
  .strict();

/** zod schema for a single resolve config's scalar surface (the threshold). */
const resolveConfigScalarSchema = z.object({
  threshold: z
    .number()
    .min(0, { message: "threshold must be >= 0" })
    .max(1, { message: "threshold must be <= 1" }),
});

/**
 * zod schema for the scalar / enum surface of {@link MergeOptions}. Function- and
 * store-valued fields are deliberately omitted (validated structurally by the
 * type system, not at runtime) and re-attached after parsing.
 */
const mergeOptionsScalarSchema = z.object({
  reconcileTypes: z
    .enum(["ontology", "off"])
    .default(MERGE_OPTION_DEFAULTS.reconcileTypes),
  onDeleteModifyConflict: z
    .enum(["deleteWins", "modifyWins", "flag"])
    .default(MERGE_OPTION_DEFAULTS.onDeleteModifyConflict),
  onComparisonCeiling: z
    .enum(["error", "mergeByIdOnly"])
    .default(MERGE_OPTION_DEFAULTS.onComparisonCeiling),
  provenance: z.boolean().default(MERGE_OPTION_DEFAULTS.provenance),
  persistProvenance: z
    .boolean()
    .default(MERGE_OPTION_DEFAULTS.persistProvenance),
  maxComparisonsPerKind: z
    .number()
    .int({ message: "maxComparisonsPerKind must be an integer" })
    .min(0, { message: "maxComparisonsPerKind must be >= 0" })
    .optional(),
  clusterMaxDiameter: z
    .number()
    .positive({ message: "clusterMaxDiameter must be positive" })
    .optional(),
  candidateDiagnostics: z
    .object({
      limit: z
        .number()
        .int({ message: "candidateDiagnostics.limit must be an integer" })
        .min(0, { message: "candidateDiagnostics.limit must be >= 0" }),
    })
    .strict()
    .optional(),
});

/**
 * Fully-normalized merge options: every default resolved, the (validated)
 * pass-through fields attached. Downstream phases consume this, never the raw
 * {@link MergeOptions}.
 */
export type NormalizedMergeOptions<G extends GraphDef = GraphDef> = Readonly<{
  // Internal kind-agnostic view: the public {@link ResolveMap} is keyed per-kind,
  // but downstream phases index it by a runtime kind STRING, so the normalized
  // form widens to a plain record. Unknown keys were already validated away.
  resolve: Readonly<Record<string, ResolveConfig<G>>>;
  reconcileTypes: ReconcileTypesMode;
  onPropertyConflict: PropertyConflictPolicy<G>;
  onBasePropertyConflict: PropertyConflictPolicy<G>;
  onDeleteModifyConflict: DeleteModifyPolicy;
  onComparisonCeiling: ComparisonCeilingPolicy;
  provenance: boolean;
  persistProvenance: boolean;
  canonical?: (
    cluster: ResolvedCluster,
  ) => ReturnType<NonNullable<MergeOptions<G>["canonical"]>>;
  embedder?: Embedder;
  target?: MergeOptions<G>["target"];
  maxComparisonsPerKind?: number;
  clusterMaxDiameter?: number;
  candidateDiagnostics?: CandidateDiagnosticsOptions;
  branchOrder?: readonly BranchId[];
  provenanceWeights?: ReadonlyMap<BranchId, number>;
  /** Presence-preserving: absent unless the caller stated `identity`. */
  identity?: IdentityReconciliationOptions;
}>;

/**
 * Validates the STRING arm of a property-conflict policy (the function arm is not
 * validatable by zod), throwing a clean option error for an unknown enum value.
 * Shared by `onPropertyConflict` and the separate `onBasePropertyConflict`.
 */
function validatePropertyConflictPolicy<G extends GraphDef>(
  policy: PropertyConflictPolicy<G>,
  label: string,
): PropertyConflictPolicy<G> {
  if (
    typeof policy === "string" &&
    !propertyConflictPolicySchema.safeParse(policy).success
  ) {
    throw new Error(
      `Invalid ${label} "${policy}": expected "flag", "lastWriteWins", "provenanceWeighted", or a function.`,
    );
  }
  return policy;
}

/**
 * Validates the STRING arm of `identity.onAssertionConflict` (the function
 * arm is not validatable by zod).
 */
function validateIdentityAssertionConflictPolicy(
  policy: IdentityAssertionConflictPolicy,
): IdentityAssertionConflictPolicy {
  if (
    typeof policy === "string" &&
    !identityAssertionConflictPolicySchema.safeParse(policy).success
  ) {
    throw new Error(
      `Invalid identity.onAssertionConflict "${policy}": expected "refuse", "assertWins", "retractWins", "flag", or a function.`,
    );
  }
  return policy;
}

/**
 * Validates and fully resolves `identity`, PRESENCE-PRESERVING: `undefined`
 * in, `undefined` out — the compatibility hinge that keeps a review artifact
 * captured before this option existed revalidating `compatible`
 * (`reviewOptionEvidence` encodes only what `normalizeMergeOptions` emits).
 * `{}` in still resolves every default and comes back fully populated: the
 * caller STATED they want identity reconciliation, even with every field at
 * its default.
 */
function validateIdentityOptions(
  identity: IdentityReconciliationOptions | undefined,
): IdentityReconciliationOptions | undefined {
  if (identity === undefined) return undefined;
  const { onAssertionConflict, ...scalarInput } = identity;
  const scalar = identityOptionsScalarSchema.parse(scalarInput);
  // Accepted or refused, never ignored. Both `"flag"` arms mean "drop the
  // identity PAIRING and keep the data", which needs a plan rebuild with the
  // offending identity candidate edges removed — machinery this release does
  // not have. Refusing the value is the honest contract: a caller who states it
  // learns the merge cannot honor it, instead of receiving a plan that silently
  // applied the default.
  if (scalar.onEdgeConflict === "flag") {
    throw new Error(
      'identity.onEdgeConflict: "flag" is not implemented: dropping an identity pairing whose repoint collides requires rebuilding the plan without that pairing. Use "repoint" (the default), which applies the repoint and reports the property disagreement through onPropertyConflict.',
    );
  }
  if (scalar.onUniquenessConflict === "flag") {
    throw new Error(
      'identity.onUniquenessConflict: "flag" is not implemented: dropping an identity pairing whose fusion violates a unique constraint requires rebuilding the plan without that pairing. Use "refuse" (the default), which surfaces the violation through the existing constraint-conflict error.',
    );
  }
  return {
    pairing: scalar.pairing,
    onAssertionConflict: validateIdentityAssertionConflictPolicy(
      onAssertionConflict ?? MERGE_OPTION_DEFAULTS.identity.onAssertionConflict,
    ),
    onEdgeConflict: scalar.onEdgeConflict,
    onUniquenessConflict: scalar.onUniquenessConflict,
    onProvenanceConflict: scalar.onProvenanceConflict,
  };
}

/**
 * Validates each per-kind resolve config's threshold, leaving the strategy and
 * `block` function untouched. Returns the same map shape (resolve configs are
 * passed through; only their scalar surface is validated).
 */
function validateResolveMap<G extends GraphDef>(
  resolve: ResolveMap<G> | undefined,
): Readonly<Record<string, ResolveConfig<G>>> {
  if (resolve === undefined) {
    return {};
  }
  // The public ResolveMap binds each kind's config to that kind's NodeType;
  // validation only reads the kind-agnostic scalar surface, so widen to a plain
  // record (the per-kind block/similarity types are sound at every call site).
  const configs = resolve as unknown as Readonly<
    Record<string, ResolveConfig<G>>
  >;
  // Data-keyed: node kind names supplied by the caller's resolve map.
  const validated = createDataKeyedBag<ResolveConfig<G>>();
  for (const [kind, config] of Object.entries(configs)) {
    const parsed = resolveConfigScalarSchema.safeParse({
      threshold: config.threshold,
    });
    if (!parsed.success) {
      throw new Error(
        `Invalid resolve config for kind "${kind}": ${parsed.error.message}`,
      );
    }
    if (
      config.keyless !== undefined &&
      (!Number.isInteger(config.keyless.window) || config.keyless.window < 1)
    ) {
      throw new Error(
        `Invalid resolve config for kind "${kind}": keyless.window must be a positive integer, got ${config.keyless.window}.`,
      );
    }
    const strategy = config.similarity;
    if (strategy.kind === "hybrid") {
      for (const component of ["vector", "fulltext"] as const) {
        const weight = strategy.weights?.[component];
        if (weight !== undefined && (!Number.isFinite(weight) || weight < 0)) {
          throw new Error(
            `Invalid resolve config for kind "${kind}": similarity.weights.${component} must be a finite number >= 0, got ${String(weight)}.`,
          );
        }
      }
    }
    validated[kind] = config;
  }
  // Spread at the boundary: this becomes `NormalizedMergeOptions.resolve`,
  // returned from the exported `normalizeMergeOptions`.
  return { ...validated };
}

/**
 * Validates the optional `"provenanceWeighted"` trust weights: every weight must
 * be a finite number `>= 0`, since a NaN / negative weight would corrupt the
 * highest-weight pick. Returns the same map.
 */
function validateProvenanceWeights(
  weights: ReadonlyMap<BranchId, number>,
): ReadonlyMap<BranchId, number> {
  for (const [branchId, weight] of weights) {
    if (!Number.isFinite(weight) || weight < 0) {
      throw new Error(
        `Invalid provenanceWeights for branch "${branchId}": weight must be a finite number >= 0, got ${String(weight)}.`,
      );
    }
  }
  return weights;
}

/**
 * Validates and normalizes {@link MergeOptions}, applying every P0 default.
 *
 * Throws (not a `Result`) on invalid scalar input — option validation is a
 * caller-boundary concern, surfaced as a thrown error per project conventions;
 * `merge()` converts it back to a typed `MergeError` at its own boundary.
 *
 * @throws if a threshold is outside `[0, 1]`, `maxComparisonsPerKind` is
 *   negative/non-integer, or `clusterMaxDiameter` is non-positive.
 */
export function normalizeMergeOptions<G extends GraphDef>(
  options: MergeOptions<G> = {},
): NormalizedMergeOptions<G> {
  const scalar = mergeOptionsScalarSchema.parse({
    reconcileTypes: options.reconcileTypes,
    onDeleteModifyConflict: options.onDeleteModifyConflict,
    onComparisonCeiling: options.onComparisonCeiling,
    provenance: options.provenance,
    persistProvenance: options.persistProvenance,
    ...(options.maxComparisonsPerKind === undefined ?
      {}
    : { maxComparisonsPerKind: options.maxComparisonsPerKind }),
    ...(options.clusterMaxDiameter === undefined ?
      {}
    : { clusterMaxDiameter: options.clusterMaxDiameter }),
    ...(options.candidateDiagnostics === undefined ?
      {}
    : { candidateDiagnostics: options.candidateDiagnostics }),
  });

  const onPropertyConflict = validatePropertyConflictPolicy(
    options.onPropertyConflict ?? MERGE_OPTION_DEFAULTS.onPropertyConflict,
    "onPropertyConflict",
  );
  // DELIBERATELY does not fall back to `onPropertyConflict` — base↔branch conflicts
  // must not silently inherit a staged policy that could overwrite committed data.
  const onBasePropertyConflict = validatePropertyConflictPolicy(
    options.onBasePropertyConflict ??
      MERGE_OPTION_DEFAULTS.onBasePropertyConflict,
    "onBasePropertyConflict",
  );

  const provenanceWeights =
    options.provenanceWeights === undefined ?
      undefined
    : validateProvenanceWeights(options.provenanceWeights);

  const identity = validateIdentityOptions(options.identity);

  // "provenanceWeighted" without weights would silently degrade to a
  // stable-branch-order (lastWriteWins) resolution and quietly commit a
  // different graph. Fail loudly instead so the misconfiguration is visible.
  const usesProvenanceWeighting =
    onPropertyConflict === "provenanceWeighted" ||
    onBasePropertyConflict === "provenanceWeighted";
  if (
    usesProvenanceWeighting &&
    (provenanceWeights === undefined || provenanceWeights.size === 0)
  ) {
    throw new Error(
      'A "provenanceWeighted" property-conflict policy requires a non-empty provenanceWeights map.',
    );
  }

  return {
    resolve: validateResolveMap(options.resolve),
    reconcileTypes: scalar.reconcileTypes,
    onPropertyConflict,
    onBasePropertyConflict,
    onDeleteModifyConflict: scalar.onDeleteModifyConflict,
    onComparisonCeiling: scalar.onComparisonCeiling,
    provenance: scalar.provenance,
    persistProvenance: scalar.persistProvenance,
    ...(options.canonical === undefined ?
      {}
    : { canonical: options.canonical }),
    ...(options.embedder === undefined ? {} : { embedder: options.embedder }),
    ...(options.target === undefined ? {} : { target: options.target }),
    ...(scalar.maxComparisonsPerKind === undefined ?
      {}
    : { maxComparisonsPerKind: scalar.maxComparisonsPerKind }),
    ...(scalar.clusterMaxDiameter === undefined ?
      {}
    : { clusterMaxDiameter: scalar.clusterMaxDiameter }),
    ...(scalar.candidateDiagnostics === undefined ?
      {}
    : { candidateDiagnostics: scalar.candidateDiagnostics }),
    ...(options.branchOrder === undefined ?
      {}
    : { branchOrder: options.branchOrder }),
    ...(provenanceWeights === undefined ? {} : { provenanceWeights }),
    ...(identity === undefined ? {} : { identity }),
  };
}
