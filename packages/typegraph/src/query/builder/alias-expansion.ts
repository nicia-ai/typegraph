/**
 * The one owner of "which expansion axis does this alias use" (Q3, C.3).
 *
 * An alias carries EXACTLY ONE expansion axis, and states it as one option
 * value rather than as a set of booleans a caller could combine into a
 * contradiction:
 *
 * - `"exact"` — only the named kind.
 * - `"subclasses"` — the kind and every `subClassOf`/`equivalentTo`
 *   descendant (`registry.expandSubClasses`). The store-wide default
 *   (roadmap Q3): a supertype query is polymorphic unless narrowed.
 * - `"narrower"` — the kind and every `broader`/`narrower` descendant
 *   (`registry.expandNarrower`, C.3). No schema relationship is claimed, so
 *   the alias type is untyped.
 *
 * `from()` / `to()` / `fromDynamic()` / `toDynamic()` all resolve their
 * expansion through this one function and nothing else re-derives it.
 */
import { ConfigurationError } from "../../errors";
import { type KindRegistry } from "../../registry/kind-registry";

export type AliasExpansionAxis = "exact" | "subclasses" | "narrower";

/**
 * Every axis a STORE-WIDE default may name. `"narrower"` is excluded on
 * purpose: an alias declared with no options is typed as its declared kind
 * (or the polymorphic widening of it), and a `broader`/`narrower` expansion
 * claims no schema relationship at all — defaulting a whole store onto that
 * axis would hand every untyped-by-default alias rows of kinds its type
 * never promised.
 */
export type DefaultAliasExpansionAxis = Exclude<AliasExpansionAxis, "narrower">;

/**
 * The axis an alias takes when neither the call nor the store states one
 * (roadmap Q3). Named here because both places that resolve a store-wide
 * default — `createQueryBuilder` and `Store`'s `queryDefaults` — must agree
 * on it; two spellings of the same literal would let a store-issued builder
 * and a standalone one drift apart.
 */
export const DEFAULT_ALIAS_EXPANSION_AXIS: DefaultAliasExpansionAxis =
  "subclasses";

export type AliasExpansionOptions = Readonly<{
  /**
   * The alias's expansion axis. Omitted (or `undefined`) takes the store
   * default — `"subclasses"` unless the store overrides it through
   * `queryDefaults.expansion`.
   */
  expansion?: AliasExpansionAxis | undefined;
}>;

const ALIAS_EXPANSION_AXES: readonly AliasExpansionAxis[] = [
  "exact",
  "subclasses",
  "narrower",
];

/**
 * The one refusal for an `expansion` value a surface cannot honor.
 *
 * `permittedAxes` is the subset the CALLING surface offers: every axis for an
 * alias, the `"narrower"`-less pair for the `store.search()` facade. Both
 * decisions — "is this a known axis" and "does this surface offer it" — are
 * made here, so a second surface cannot re-spell either, and a value this
 * surface cannot honor is refused by name instead of being coerced to the
 * surface's default. A stated option is applied or refused, never ignored.
 *
 * Unreachable through the typed options; reachable from JavaScript, and from
 * a typed caller that casts.
 *
 * @throws ConfigurationError (`QUERY_ALIAS_EXPANSION_INVALID`) when
 *   `expansion` is not one of `permittedAxes`.
 */
export function assertPermittedExpansionAxis(
  expansion: AliasExpansionAxis,
  permittedAxes: readonly AliasExpansionAxis[],
  surface: string,
): void {
  if (permittedAxes.includes(expansion)) return;
  throw new ConfigurationError(
    ALIAS_EXPANSION_AXES.includes(expansion) ?
      `${surface} does not support expansion: "${expansion}".`
    : `Unknown ${surface} expansion "${expansion}".`,
    { code: "QUERY_ALIAS_EXPANSION_INVALID", expansion, surface },
    {
      suggestion: `Pass one of ${permittedAxes.map((axis) => `"${axis}"`).join(", ")}.`,
    },
  );
}

/**
 * Resolves the expansion axis for one alias: the stated `expansion`, or the
 * store default when the option is absent or explicitly `undefined` (an
 * unstated option, not a stated one — ordinary option forwarding).
 *
 * @throws ConfigurationError (`QUERY_ALIAS_EXPANSION_INVALID`) when
 *   `expansion` names something outside the axis set — an alias offers all
 *   three, so only an out-of-domain value can fail here.
 */
export function resolveAliasExpansion(
  options: AliasExpansionOptions | undefined,
  storeDefaultExpansion: DefaultAliasExpansionAxis,
): AliasExpansionAxis {
  const expansion = options?.expansion;
  if (expansion === undefined) return storeDefaultExpansion;
  assertPermittedExpansionAxis(expansion, ALIAS_EXPANSION_AXES, "alias");
  return expansion;
}

/**
 * The concrete kind list an alias resolves to under `axis` — the one place
 * `from`/`fromDynamic`/`to`/`toDynamic` turn an axis into `QueryStart.kinds`
 * / `Traversal.kinds`.
 *
 * The `"narrower"` axis additionally REFUSES (never silently narrows) when
 * the expansion names a kind this registry does not recognize as a node
 * kind — `broader`/`narrower` accept any `NodeType`, registered or not, so
 * this is reachable. `to()`/`toDynamic()` layer an additional
 * endpoint-admission check on top of this list; see
 * `TraversalBuilder`'s own narrower handling.
 *
 * @throws ConfigurationError (`ONTOLOGY_NARROWER_KIND_NOT_REGISTERED`) when
 *   `axis === "narrower"` and the expansion names an unregistered kind.
 */
export function expandKindsForAxis(
  axis: AliasExpansionAxis,
  kind: string,
  registry: Pick<
    KindRegistry,
    "expandSubClasses" | "expandNarrower" | "hasNodeType"
  >,
): readonly string[] {
  switch (axis) {
    case "exact": {
      return [kind];
    }
    case "subclasses": {
      return registry.expandSubClasses(kind);
    }
    case "narrower": {
      const kinds = registry.expandNarrower(kind);
      for (const narrowerKind of kinds) {
        if (registry.hasNodeType(narrowerKind)) continue;
        throw new ConfigurationError(
          `expansion: "narrower" on "${kind}" includes "${narrowerKind}", which is not a registered node kind.`,
          {
            code: "ONTOLOGY_NARROWER_KIND_NOT_REGISTERED",
            rootKind: kind,
            narrowerKind,
          },
          {
            suggestion: `Register "${narrowerKind}" as a node kind, or remove its broader/narrower relation to "${kind}".`,
          },
        );
      }
      return kinds;
    }
  }
}
