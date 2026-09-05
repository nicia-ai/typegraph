/**
 * The engine profile's opaque operation assembly.
 *
 * `SqlEngineProfile.assembly` (`./profile`) carries a dialect's
 * `buildOperations`/`lateMembers` pair without exposing either closure's
 * type on the profile itself: {@link assembleEngine} wraps the pair into one
 * {@link EngineAssembly} value, storing the pair in a module-private
 * `WeakMap` keyed by the assembly object rather than on the object as an
 * inspectable property, and {@link resolveEngineAssembly} is the only way
 * `createSqlBackend` (`./create-sql-backend`) reads them back out. A profile
 * assembled by hand — including one that copies every other field off a
 * bundled builder's result but builds its own `assembly` value — resolves to
 * nothing, because nothing outside this module can add an entry to the map.
 *
 * This is what keeps `EngineOperationsContext`, `EngineAssemblyContext`,
 * `EngineLateMembers`, and everything reachable only through them
 * (`InternalOperationBackend`, `ContributionMaterializer`, `WriteFenceTarget`,
 * …) off `SqlEngineProfile`'s public shape: those types describe the
 * closures this module hides, not the field a consumer reads.
 * `deriveEngineProfile` (`./derive-profile`) treats `assembly` as
 * non-derivable and carries the base profile's assembly object forward by
 * reference, so a derived profile resolves to the SAME wrapped pair the base
 * builder closed over.
 */
import { ConfigurationError } from "../../../errors";
import type { InternalOperationBackend } from "../operation-backend-core";
import type {
  EngineAssemblyContext,
  EngineLateMembers,
  EngineOperationsContext,
} from "./profile";

// A `unique symbol` brand key, declared but never assigned a runtime value —
// the property it names is never actually present on an assembly object, so
// nothing structurally shaped like `{ [ENGINE_ASSEMBLY_BRAND]: ... }` can
// exist by accident. Not exported: like `RECORDED_INSTANT_BRAND`
// (`../../../core/temporal.ts`), a brand used only as a computed property
// key on an otherwise-exported type does not need its own export for
// api-extractor to resolve the type it brands.
declare const ENGINE_ASSEMBLY_BRAND: unique symbol;

/**
 * An opaque handle for one dialect's `buildOperations`/`lateMembers` pair.
 * {@link assembleEngine} is the only constructor, called once by each
 * bundled builder (`buildSqliteEngineProfile`, `buildPostgresEngineProfile`)
 * on its own closures; {@link resolveEngineAssembly} is the only way to read
 * one back out. No other operation on this type is public — an author
 * deriving a profile carries the base's `assembly` forward by reference
 * (`deriveEngineProfile`) rather than constructing a new one.
 */
export type EngineAssembly<TTx> = Readonly<{
  readonly [ENGINE_ASSEMBLY_BRAND]: (transaction: TTx) => TTx;
}>;

/** The pair {@link assembleEngine} wraps and {@link resolveEngineAssembly} returns. */
type EngineAssemblyParts<TTx> = Readonly<{
  buildOperations: (ctx: EngineOperationsContext) => InternalOperationBackend;
  lateMembers: (ctx: EngineAssemblyContext<TTx>) => EngineLateMembers<TTx>;
}>;

/**
 * Every {@link EngineAssembly} {@link assembleEngine} has ever minted, keyed
 * by object identity. Module-private for the same reason the write-fence
 * first-party registry (`../../capabilities/write-fence`) is: an assembly
 * built anywhere else — or a plain object cast to the type — is a key this
 * map has never seen, so it resolves to nothing.
 *
 * The stored value type parameter is fixed at `never` because a `WeakMap`
 * cannot itself be generic per entry; `assembleEngine` and
 * `resolveEngineAssembly` are each responsible for the one cast at their own
 * boundary that recovers the caller's actual `TTx`.
 */
const ENGINE_ASSEMBLIES = new WeakMap<object, EngineAssemblyParts<never>>();

/**
 * The only constructor for {@link EngineAssembly}. Exported from this module
 * for the two bundled builders and from no entrypoint — building one is
 * authoring a new engine, not deriving a variant of an existing profile.
 */
export function assembleEngine<TTx>(
  parts: EngineAssemblyParts<TTx>,
): EngineAssembly<TTx> {
  const assembly = {} as unknown as EngineAssembly<TTx>;
  ENGINE_ASSEMBLIES.set(assembly, parts as unknown as EngineAssemblyParts<never>);
  return assembly;
}

/**
 * Resolves `assembly` back to the `buildOperations`/`lateMembers` pair
 * {@link assembleEngine} wrapped it into. `createSqlBackend` calls this
 * exactly once per assembly.
 *
 * @throws {ConfigurationError} with code `ENGINE_ASSEMBLY_UNRECOGNIZED` when
 * `assembly` is not a value this module has minted — a profile built by hand
 * rather than obtained from a bundled builder (and, when adapted, through
 * `deriveEngineProfile`).
 */
export function resolveEngineAssembly<TTx>(
  assembly: EngineAssembly<TTx>,
): EngineAssemblyParts<TTx> {
  const parts = ENGINE_ASSEMBLIES.get(assembly);
  if (parts === undefined) {
    throw new ConfigurationError(
      "This engine profile's assembly was not produced by a bundled " +
        "builder: a profile is obtained from buildPostgresEngineProfile / " +
        "buildSqliteEngineProfile and adapted with deriveEngineProfile.",
      { code: "ENGINE_ASSEMBLY_UNRECOGNIZED" },
      {
        suggestion:
          "Build this profile with buildSqliteEngineProfile or " +
          "buildPostgresEngineProfile, optionally adapted with " +
          "deriveEngineProfile, rather than constructing its assembly field " +
          "directly.",
      },
    );
  }
  return parts as unknown as EngineAssemblyParts<TTx>;
}
