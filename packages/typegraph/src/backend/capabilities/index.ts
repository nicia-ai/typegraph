/**
 * Barrel over the pilot capability-bundle model: the registry (data), the
 * verdict resolver, and the member binder. Re-exported from
 * `src/backend/index.ts` for external consumers; internal callers may still
 * import the three modules directly.
 *
 * ## Seams the next workstreams consume
 *
 * Named here, precedent `bundle-registry.ts`'s own WS5b callouts, because no
 * separate backend-authoring doc exists to hold this instead.
 *
 * **WS6 (conformance kit).** `CAPABILITY_BUNDLES` is the one source its
 * refusal-conformance rows are generated from: a `refuse` row asserts the
 * disposition's code, a `fallback` row asserts the degradation, and a
 * per-extra row reads that extra's own `disposition` — never a bare
 * `fallback` string, so the kit cannot acquire a second vocabulary for the
 * same decision. Three of the six pilot bundles (`claims`,
 * `statementExecution`, `recordedRevisionOrigins`) are `gated`, so "bundle
 * absent" is not representable for them — the kit must not synthesize an
 * absent-bundle row for a gated bundle. Certification requires an explicit
 * `recursiveTraversal` declaration (OQ2's bar: "absent = supported" is a
 * shipped default that protects existing backends inside a minor, not a
 * certification pass). Three obligations WS6 owns at launch:
 *
 * 1. Its declaration-truthfulness probes must cover the
 *    declaration-contradiction shape struck from `createStore` (the B5
 *    ruling) — an uncertified custom backend owns its declarations, and the
 *    kit is what polices a certified one.
 * 2. Its generator must stay registry-driven, so a WS5b bundle landing in
 *    `CAPABILITY_BUNDLES` grows the kit's coverage with zero kit changes —
 *    the same one-owner property the registry already gives the runtime.
 * 3. The value-type-body blind spot the api-surface checker's module doc
 *    now names (a required-ification inside a member's value type, e.g.
 *    `DeleteLegacyRecordedAnchorMapOptions.backend`, produces zero
 *    checker findings) needs a WS6-time decision: close it in the kit's own
 *    certification checks, or extend the checker's inventory into
 *    value-type bodies.
 *
 * **WS7 (engine profiles + pushdown).** `recursiveTraversal` is a *backend*
 * capability, not a dialect one, so an engine profile that varies it needs no
 * re-modeling — `resolveRecursiveTraversal` (`recursive-traversal.ts`) is
 * where a profile-derived verdict enters. The `primitive` field is
 * deliberately absent until WS7 adds it with its consumer. `capabilities.pushdown`
 * (WS7's own future capability field) is a named WS5b bundle input, not a
 * bundle shape WS7 should pre-guess.
 *
 * **WS8 (port surface).** The registry's two definition kinds (`gated` /
 * `graduated`) are the extension point for a new bundle (e.g. an
 * `optimisticConcurrency` bundle for the read-modify-write fence a
 * no-RETURNING / batch-atomic engine needs) — WS8 does not invent a parallel
 * flag set. `resolveWriteFencePlan`'s `unfenced` arm is the CAS-only posture;
 * a future `cas-serialized` arm is OQ3's named seam behind the exhaustive
 * `WriteFencePlan` union switch, not pre-built here.
 *
 * **WS9 (engine-native recorded time).** `capabilities.recordedTimeOwnership:
 * "engine-native"` passes the fence gate (it is orthogonal to locking) and
 * today hits `refuseEngineNativeRecordedTimeNotYetImplemented`'s interim
 * refusal at construction whenever `history` / `revisionTracking` allocates
 * the TypeGraph-owned clock; WS9 lifts that interim refusal with its read
 * path.
 */
export {
  batchPointReadMembers,
  bindCore,
  bindExtra,
  bindExtraIfReachable,
  type BundleBinding,
  claimsMembers,
  contributionHealthMembers,
  type PartialBundleBinding,
  recordedRevisionOriginsMembers,
  statementExecutionMembers,
  uniqueSidecarBatchMembers,
} from "./bind";
export {
  BATCH_POINT_READ,
  CAPABILITY_BUNDLES,
  type CapabilityBundleDefinition,
  type CapabilityBundleDisposition,
  type CapabilityBundleExtra,
  type CapabilityBundleId,
  type CapabilityBundleOperation,
  type CapabilityBundleOperationSite,
  type CapabilityCrossCheck,
  CLAIMS,
  CONTRIBUTION_HEALTH,
  type DeferredUnbundledMember,
  type GatedBundleDefinition,
  type GraduatedBundleDefinition,
  type OptionalGraphBackendMember,
  type OptionalKeys,
  type ReasonedUnbundledMember,
  RECORDED_REVISION_ORIGINS,
  STATEMENT_EXECUTION,
  UNBUNDLED_OPTIONAL_MEMBERS,
  type UnbundledOptionalMember,
  UNIQUE_SIDECAR_BATCH,
  WS5B_SEED_BUNDLES,
  type Ws5bBundleId,
} from "./bundle-registry";
export {
  batchPointReadVerdict,
  type BundleVerdictOf,
  type CapabilityExtraSpec,
  claimsVerdict,
  type ClaimsVerdictThunk,
  contributionHealthVerdict,
  createClaimsVerdictThunk,
  type ExtraMember,
  type ExtrasOf,
  type ExtraVerdict,
  type ExtraVerdicts,
  type GatedBundleVerdict,
  type GraduatedBundleVerdict,
  missingRequiredExtras,
  type OperationNames,
  recordedRevisionOriginsVerdict,
  type RequiredExtrasOf,
  requireExtras,
  resolveBundle,
  type SpecOf,
  statementExecutionVerdict,
  uniqueSidecarBatchVerdict,
} from "./resolve";
export {
  type PessimisticLockCapabilities,
  requireWriteFence,
  resolveWriteFencePlan,
  type WriteFencePlan,
} from "./write-fence";
