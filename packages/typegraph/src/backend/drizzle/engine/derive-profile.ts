/**
 * `deriveEngineProfile`: the one way to build a variant of a bundled
 * {@link SqlEngineProfile} by overriding a bounded set of fields, instead of
 * spreading the profile into a plain object literal by hand.
 *
 * A profile's HEAD carries two kinds of fields. Some — `declaredCapabilities`,
 * `fenceSql`, `resourceAudit`, `autocommit`, the six `*Runtime` bags, and
 * `close` — are read exactly once, either directly off the `profile` argument
 * `createSqlBackend` receives or off the `EngineOperationsContext` /
 * `EngineAssemblyContext` it derives from that argument; nothing else in the
 * assembled backend closes over a builder-local copy of them, with one
 * carved-out exception on the bundled PostgreSQL builder: it reads
 * `declaredCapabilities.maxBindParameters`,
 * `declaredCapabilities.execution.interactiveTransactions`, and
 * `resourceAudit.kind` to compute `createPostgresExecutionAdapter`'s own
 * options (`maxBindParameters`, `interactiveAtomicBatch`) before the profile
 * object exists, baking a copy of exactly those three sub-values into
 * `profile.execution` — a field that is NOT itself derivable. Changing any of
 * the three through an override would therefore split the derived profile:
 * `declaredCapabilities` / `resourceAudit` on the returned object would
 * report the change, while the adapter backing `profile.execution` kept
 * enforcing the base builder's value. `assertAdapterBackedCapabilitiesUnchanged`
 * below refuses exactly those three sub-values when they would change;
 * every other sub-field on `declaredCapabilities` and `resourceAudit`
 * (`pessimisticLocks`, `windowFunctions`, `clearValidTo`, `returning`,
 * `claims`, `graphAnalytics`, `resourceAudit`'s `resource` /
 * `identityLeaseResource`, …) stays freely derivable, because none of those
 * reach the adapter's construction. Every other field — `dialect`,
 * `tableNames`, `execution`, `strategy`, `fulltext`, `vector`,
 * `provisioning`, `buildOperations`, `lateMembers` — is also captured by one
 * or more of the builder's own closures (`buildOperations`, `lateMembers`,
 * and the member groups they build), so overriding only the head field would
 * leave those closures reading the value the builder closed over instead.
 * `DERIVABLE_ENGINE_PROFILE_KEYS` is the exact set for which that split is
 * safe (net of the carve-out above); `tests/engine-profile-derivable-keys.test.ts`
 * ratchets it against every field `SqlEngineProfile` declares, and
 * `tests/engine-profile-derivation.test.ts` pins the carve-out itself.
 *
 * What derivation grants: an author can swap the write-fence lock spelling,
 * loosen or tighten declared capabilities, replace the resource-audit
 * verdict, flip the autocommit durability claim, or replace any of the six
 * `*Runtime` dependency bags or `close`, without hand-copying every other
 * field off a bundled builder's result.
 *
 * What derivation costs: a derived profile is a new object, so it is never
 * first-party (`isFirstPartyProfile`, `../../capabilities/write-fence`) even
 * when every field is copied from a first-party one unchanged. That standing
 * carries two effects, and a derived profile gets neither: `resolveWriteFencePlan`'s
 * dialect-derivation fallback (sound only for the two bundled dialects, so it
 * never applies to a derived profile regardless — irrelevant in practice as
 * long as `declaredCapabilities` is kept, since both bundled declarations
 * already carry `pessimisticLocks` explicitly), and the lazy per-transaction
 * schema-fence lease `store/operations/write-transaction.ts` takes out under
 * `isFirstPartyFactory` (a derived profile's backend takes its own fence on
 * every managed write instead). Every gate `createSqlBackend` runs — the
 * `pessimisticLocks` refusal, the `advisoryLocks: true` without `fenceSql`
 * refusal, the schema-fenced-insert and autocommit marks — still applies to
 * a derived profile exactly as it does to a bundled one.
 */
import { ConfigurationError } from "../../../errors";
import type { FenceSql } from "../../capabilities/write-fence";
import type { SqlEngineProfile } from "./profile";

/**
 * The `SqlEngineProfile` fields `deriveEngineProfile` can override. Pinned
 * against the full set of profile keys, both directions, by
 * `tests/engine-profile-derivable-keys.test.ts`.
 */
export const DERIVABLE_ENGINE_PROFILE_KEYS = [
  "declaredCapabilities",
  "fenceSql",
  "resourceAudit",
  "autocommit",
  "contributionRuntime",
  "identityRuntime",
  "graphTemplateRuntime",
  "baseSchemaRuntime",
  "indexMaterializationRuntime",
  "kindRemovalRuntime",
  "close",
] as const satisfies readonly (keyof SqlEngineProfile<unknown>)[];

/** One of {@link DERIVABLE_ENGINE_PROFILE_KEYS}. */
export type DerivableEngineProfileKey =
  (typeof DERIVABLE_ENGINE_PROFILE_KEYS)[number];

const DERIVABLE_ENGINE_PROFILE_KEY_SET: ReadonlySet<string> = new Set(
  DERIVABLE_ENGINE_PROFILE_KEYS,
);

/**
 * The overrides `deriveEngineProfile` accepts. Every field is optional, so a
 * caller only spells the ones it changes.
 *
 * `fenceSql` is spelled separately from the rest so it alone permits an
 * explicit `undefined` — under `exactOptionalPropertyTypes`, a bare
 * `Partial<Pick<...>>` would forbid `undefined` for `fenceSql` exactly as it
 * does for every required field, but `fenceSql` is the one field on
 * `SqlEngineProfile` an author can legitimately want to REMOVE: a derived
 * profile whose engine has no advisory-lock spelling passes
 * `fenceSql: undefined` to drop it rather than leaving the base profile's
 * spelling in place. No other key in the union can be set to `undefined`:
 * each of them is a required field on `SqlEngineProfile`, and clearing one
 * would leave `createSqlBackend` with no value to read at all.
 *
 * Dropping `fenceSql` alone is not enough to reach a working profile:
 * `createSqlBackend` still resolves a write-fence plan eagerly, and a
 * profile whose `declaredCapabilities.pessimisticLocks.advisoryLocks` is
 * still `true` with no `fenceSql` to spell the lock refuses with
 * `WRITE_FENCE_SQL_UNAVAILABLE`. Pairing `fenceSql: undefined` with a
 * `declaredCapabilities` override that also stops claiming `advisoryLocks`
 * (for example `serializedWriters: true`, resolving `engine-serialized`) is
 * what actually removes the spelling successfully; see
 * `tests/engine-profile-derivation.test.ts`.
 */
export type DerivableEngineProfileOverrides<TTx> = Partial<
  Omit<Pick<SqlEngineProfile<TTx>, DerivableEngineProfileKey>, "fenceSql">
> &
  Readonly<{ fenceSql?: FenceSql | undefined }>;

/**
 * Builds a fresh {@link SqlEngineProfile} from `base` with `overrides`
 * applied — `{...base, ...overrides}`, never a mutation of `base`. `base` is
 * meant to be the return value of `buildSqliteEngineProfile` or
 * `buildPostgresEngineProfile`, but this function does not check that: it
 * only enforces that every key `overrides` supplies is one of
 * {@link DERIVABLE_ENGINE_PROFILE_KEYS}.
 *
 * A key outside that set throws `ConfigurationError` with code
 * `ENGINE_PROFILE_OVERRIDE_UNSUPPORTED` naming the key, because the bundled
 * builders bind that field into more than one closure when the profile is
 * built (see the module doc comment): applying the override to the head
 * field alone would leave `buildOperations`, `lateMembers`, or a member
 * group they build reading the value `base` closed over, so some parts of
 * the assembled backend would see the override and others would silently
 * ignore it. The check reads the overrides object's OWN keys (including
 * symbol keys, since `{...base, ...overrides}` below copies those too) at
 * runtime, not only its declared type, so a caller that bypasses the type
 * (e.g. an `as never` cast) is refused exactly the same way.
 *
 * A key inside the derivable set can still be refused: overriding
 * `declaredCapabilities.maxBindParameters`,
 * `declaredCapabilities.execution.interactiveTransactions`, or
 * `resourceAudit.kind` away from `base`'s own value throws the same code,
 * naming the sub-field, for the reason the module doc comment states.
 *
 * The result goes through every `createSqlBackend` gate unchanged, and is
 * never first-party — see the module doc comment for what that costs.
 */
export function deriveEngineProfile<TTx>(
  base: SqlEngineProfile<TTx>,
  overrides: DerivableEngineProfileOverrides<TTx>,
): SqlEngineProfile<TTx> {
  for (const key of Reflect.ownKeys(overrides)) {
    const keyName = String(key);
    if (!DERIVABLE_ENGINE_PROFILE_KEY_SET.has(keyName)) {
      throw new ConfigurationError(
        `deriveEngineProfile cannot override "${keyName}": the bundled builders ` +
          "bind this field into more than one closure when the profile is " +
          "built (buildOperations, lateMembers, or a member group they " +
          "build), so overriding only the profile's head field would leave " +
          "some assembled members applying the override and others reading " +
          "the value the builder closed over. Only " +
          `${DERIVABLE_ENGINE_PROFILE_KEYS.join(", ")} can be derived; ` +
          `build a new profile with the builder itself to change "${keyName}".`,
        { code: "ENGINE_PROFILE_OVERRIDE_UNSUPPORTED", key: keyName },
        {
          suggestion:
            "Remove this key from the overrides passed to deriveEngineProfile, " +
            "or construct a profile directly with buildSqliteEngineProfile / " +
            "buildPostgresEngineProfile to change it.",
        },
      );
    }
  }

  assertAdapterBackedCapabilitiesUnchanged(base, overrides);

  // A cast, not a widening: every consumer of `SqlEngineProfile.fenceSql`
  // (`createSqlBackend`, `resolveWriteFencePlan`) already tests it with
  // `=== undefined`, so a returned object whose `fenceSql` key is PRESENT
  // with value `undefined` (what `{...base, ...overrides}` produces when
  // `overrides.fenceSql` is explicitly `undefined`) behaves identically to
  // one where the key is absent. `exactOptionalPropertyTypes` only refuses
  // to infer that equivalence structurally for an optional field whose
  // override type includes `undefined`; it does not describe a real
  // divergence in the value this function returns.
  return { ...base, ...overrides } as SqlEngineProfile<TTx>;
}

/**
 * The one carve-out inside the otherwise-safe derivable set: see this
 * module's doc comment for why `buildPostgresEngineProfile` bakes these
 * three sub-values into `profile.execution` before the profile object
 * exists. Refuses an override that would change any of them from `base`'s
 * own value, leaving every other sub-field on `declaredCapabilities` and
 * `resourceAudit` freely derivable.
 */
function assertAdapterBackedCapabilitiesUnchanged<TTx>(
  base: SqlEngineProfile<TTx>,
  overrides: DerivableEngineProfileOverrides<TTx>,
): void {
  if (overrides.declaredCapabilities !== undefined) {
    refuseIfAdapterBackedValueDiffers(
      "declaredCapabilities.maxBindParameters",
      base.declaredCapabilities.maxBindParameters,
      overrides.declaredCapabilities.maxBindParameters,
    );
    refuseIfAdapterBackedValueDiffers(
      "declaredCapabilities.execution.interactiveTransactions",
      base.declaredCapabilities.execution.interactiveTransactions,
      overrides.declaredCapabilities.execution.interactiveTransactions,
    );
  }
  if (overrides.resourceAudit !== undefined) {
    refuseIfAdapterBackedValueDiffers(
      "resourceAudit.kind",
      base.resourceAudit.kind,
      overrides.resourceAudit.kind,
    );
  }
}

/**
 * @throws {ConfigurationError} with code `ENGINE_PROFILE_OVERRIDE_UNSUPPORTED`
 * when `overrideValue` differs from `baseValue`.
 */
function refuseIfAdapterBackedValueDiffers(
  fieldPath: string,
  baseValue: unknown,
  overrideValue: unknown,
): void {
  if (overrideValue === baseValue) return;
  throw new ConfigurationError(
    `deriveEngineProfile cannot override "${fieldPath}": the bundled ` +
      "PostgreSQL builder reads this exact sub-value to compute the " +
      "execution adapter's own options (maxBindParameters, " +
      "interactiveAtomicBatch) before the profile object exists, baking a " +
      "copy of it into `profile.execution` — a field that is not itself " +
      "derivable. Changing it here would leave the returned profile's " +
      "declaredCapabilities/resourceAudit reporting the override while the " +
      "adapter kept enforcing the base builder's value: some parts of the " +
      "assembled backend would apply the override and others would " +
      "silently ignore it.",
    { code: "ENGINE_PROFILE_OVERRIDE_UNSUPPORTED", key: fieldPath },
    {
      suggestion:
        `Keep "${fieldPath}" equal to the base profile's own value, or ` +
        "construct a profile directly with buildPostgresEngineProfile to " +
        "change it.",
    },
  );
}
