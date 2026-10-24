/**
 * The one owner of "which expansion axis does this alias use".
 *
 * An alias carries EXACTLY ONE expansion axis, and states it as one option
 * value rather than as a set of booleans a caller could combine into a
 * contradiction:
 *
 * - `"exact"` — only the named kind.
 * - `"subclasses"` — the kind and every `subClassOf`/`equivalentTo`
 *   descendant (`registry.expandSubClasses`). The store-wide default:
 *   a supertype query is polymorphic unless narrowed.
 * - `"narrower"` — the kind and every `broader`/`narrower` descendant
 *   (`registry.expandNarrower`). No schema relationship is claimed, so
 *   the alias type is untyped.
 *
 * The axis-unknown overload of `from()` / `to()` / `fromDynamic()` /
 * `toDynamic()` covers two call shapes with one rule: a `"narrower"`
 * expansion (no schema relationship is claimed, so no per-kind type can be
 * promised) and a forwarded options bag whose axis is not one literal — the
 * option type itself, or a wrapper's `{ expansion?: "exact" }`. Neither pins
 * the axis at compile time, so the alias takes the conservative untyped
 * form; state a literal axis at the call site to keep the precise alias type.
 *
 * `from()` (a single kind or a list) / `to()` / `fromDynamic()` /
 * `toDynamic()` and `store.search()` all resolve their expansion through
 * this module and nothing else re-derives it — including the refusal of an
 * expansion the alias's static type does not admit
 * (`expandKindsForAxis`).
 */
import { type GraphDef } from "../../core/define-graph";
import { ConfigurationError } from "../../errors";
import {
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_SAME_AS,
  META_EDGE_SUB_CLASS_OF,
} from "../../ontology/constants";
import { type OntologyRelation } from "../../ontology/types";
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
 * The axis an alias takes when neither the call nor the store states one.
 * Both places that accept a store-wide default — `createQueryBuilder` and
 * `Store`'s `queryDefaults` — resolve it through
 * {@link resolveDefaultAliasExpansion}, so a store-issued builder and a
 * standalone one cannot drift apart.
 */
export const DEFAULT_ALIAS_EXPANSION_AXIS: DefaultAliasExpansionAxis =
  "subclasses";

/**
 * {@link DefaultAliasExpansionAxis} as a runtime list: what a store-wide
 * default may name, and what the `store.search()` facade offers. One list for
 * both, because both exclude `"narrower"` for the reason that type states.
 */
export const DEFAULT_ALIAS_EXPANSION_AXES: readonly DefaultAliasExpansionAxis[] =
  ["exact", "subclasses"];

/**
 * `search()`'s default, distinct from {@link DEFAULT_ALIAS_EXPANSION_AXIS}.
 * The search facade is not polymorphic. `queryDefaults.expansion` does not
 * apply to it.
 */
export const SEARCH_EXPANSION_DEFAULT =
  "exact" as const satisfies DefaultAliasExpansionAxis;

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

const REMOVED_INCLUDE_SUBCLASSES_OPTION = "includeSubClasses";

/**
 * Refuses the removed `includeSubClasses` boolean, which `expansion` replaced.
 *
 * The option is gone from the types, so only JavaScript (or a cast) can still
 * state it, and without this check it would be read as no option at all: a
 * caller that wrote `{ includeSubClasses: false }` for an exact alias would
 * silently get the polymorphic default. A stated option is applied or
 * refused, never ignored.
 *
 * @throws ConfigurationError (`QUERY_ALIAS_EXPANSION_INVALID`) when `options`
 *   states `includeSubClasses`.
 */
export function assertNoRemovedExpansionOption(
  options: unknown,
  surface: string,
): void {
  if (typeof options !== "object" || options === null) return;
  if (
    (options as Readonly<Record<string, unknown>>)[
      REMOVED_INCLUDE_SUBCLASSES_OPTION
    ] === undefined
  )
    return;
  throw new ConfigurationError(
    `${surface} no longer accepts "${REMOVED_INCLUDE_SUBCLASSES_OPTION}"; the \`expansion\` option replaced it.`,
    {
      code: "QUERY_ALIAS_EXPANSION_INVALID",
      option: REMOVED_INCLUDE_SUBCLASSES_OPTION,
      surface,
    },
    {
      suggestion:
        'Pass expansion: "exact" where includeSubClasses was false, and expansion: "subclasses" where it was true.',
    },
  );
}

/**
 * Resolves the store-wide default a `Store` (`queryDefaults.expansion`) or a
 * standalone `createQueryBuilder` (`defaultExpansion`) was constructed with:
 * the stated axis, or {@link DEFAULT_ALIAS_EXPANSION_AXIS} when none is
 * stated.
 *
 * Called at construction, so a default no alias could resolve is refused
 * where it was stated instead of at the first `from()` that falls back to
 * it. `surface` names the option for the refusal.
 *
 * @throws ConfigurationError (`QUERY_ALIAS_EXPANSION_INVALID`) when the
 *   stated default is not one of {@link DEFAULT_ALIAS_EXPANSION_AXES} — an
 *   out-of-domain value, or `"narrower"`.
 */
export function resolveDefaultAliasExpansion(
  stated: DefaultAliasExpansionAxis | undefined,
  surface: string,
): DefaultAliasExpansionAxis {
  if (stated === undefined) return DEFAULT_ALIAS_EXPANSION_AXIS;
  assertPermittedExpansionAxis(stated, DEFAULT_ALIAS_EXPANSION_AXES, surface);
  return stated;
}

/**
 * Resolves the expansion axis for one alias: the stated `expansion`, or the
 * store default when the option is absent or explicitly `undefined` (an
 * unstated option, not a stated one — ordinary option forwarding).
 *
 * @throws ConfigurationError (`QUERY_ALIAS_EXPANSION_INVALID`) when
 *   `expansion` names something outside the axis set — an alias offers all
 *   three, so only an out-of-domain value can fail here — or when the removed
 *   `includeSubClasses` option is stated.
 */
export function resolveAliasExpansion(
  options: AliasExpansionOptions | undefined,
  storeDefaultExpansion: DefaultAliasExpansionAxis,
): AliasExpansionAxis {
  assertNoRemovedExpansionOption(options, "alias");
  const expansion = options?.expansion;
  if (expansion === undefined) return storeDefaultExpansion;
  assertPermittedExpansionAxis(expansion, ALIAS_EXPANSION_AXES, "alias");
  return expansion;
}

/**
 * What the calling surface computed its alias (or hit) type from:
 *
 * - `"compileTimeGraph"` — `AliasNodeType<G, K>`, which widens `kind` and
 *   `NodeId` only for a kind `G`'s ontology affects. The default overload of
 *   `from()` / `to()` (including list sources), and `store.search()` with
 *   `expansion: "subclasses"`.
 * - `"independent"` — a type that never consults `G`'s ontology: the exact
 *   kind, the unconditional `PolymorphicNodeType` of a stated
 *   `"subclasses"` alias, the untyped `NodeAlias`, or a runtime kind
 *   (`fromDynamic()` / `toDynamic()`).
 */
export type AliasStaticTyping = "compileTimeGraph" | "independent";

/**
 * The {@link AliasStaticTyping} the `from()` / `to()` overloads give an
 * alias for `options`: an alias that states no `expansion` takes the default
 * overload, typed from the compile-time graph; every stated axis selects an
 * overload whose type does not depend on it.
 */
export function aliasOverloadTyping(
  options: AliasExpansionOptions | undefined,
): AliasStaticTyping {
  return options?.expansion === undefined ? "compileTimeGraph" : "independent";
}

const SUBSUMPTION_TARGET_META_EDGES: ReadonlySet<string> = new Set([
  META_EDGE_SUB_CLASS_OF,
]);
const SUBSUMPTION_EITHER_SIDE_META_EDGES: ReadonlySet<string> = new Set([
  META_EDGE_EQUIVALENT_TO,
  META_EDGE_SAME_AS,
]);

function endpointKind(endpoint: OntologyRelation["from"]): string | undefined {
  return typeof endpoint === "string" ? undefined : endpoint.kind;
}

/**
 * The runtime reading of `SubsumptionAffected` (`./types.ts`) for the
 * decided arm: the kinds an ontology relation names as a `subClassOf` target
 * or as either side of an `equivalentTo` / `sameAs`. An IRI endpoint names
 * no kind. The type-level arms that widen because an annotation erased the
 * relation literals have no runtime counterpart: the values are identical,
 * so such a graph is read as if its literals were intact.
 */
function subsumptionAffectedKinds(
  ontology: readonly OntologyRelation[],
): ReadonlySet<string> {
  const affected = new Set<string>();
  for (const relation of ontology) {
    const name = relation.metaEdge.name;
    const named =
      SUBSUMPTION_TARGET_META_EDGES.has(name) ? [relation.to]
      : SUBSUMPTION_EITHER_SIDE_META_EDGES.has(name) ?
        [relation.from, relation.to]
      : [];
    for (const endpoint of named) {
      const kind = endpointKind(endpoint);
      if (kind !== undefined) affected.add(kind);
    }
  }
  return affected;
}

const compileTimeExactAliasKindsByRegistry = new WeakMap<
  object,
  ReadonlySet<string>
>();

/**
 * Records, for a store's live registry, the node kinds whose
 * `AliasNodeType` the compile-time graph keeps exact: every kind of
 * `compileTimeGraph` its ontology does not affect. The live registry may
 * have grown past that graph through a persisted extension (`store.evolve()`,
 * or `createStoreWithSchema` reloading one); {@link expandKindsForAxis}
 * reads this to tell when it has.
 *
 * A registry with no record — one built straight from a graph by a caller —
 * is its own compile-time graph, so no expansion of it can outgrow its type.
 */
export function bindCompileTimeAliasTyping(
  registry: KindRegistry,
  compileTimeGraph: GraphDef,
): void {
  const affected = subsumptionAffectedKinds(compileTimeGraph.ontology);
  compileTimeExactAliasKindsByRegistry.set(
    registry,
    new Set(
      Object.keys(compileTimeGraph.nodes).filter((kind) => !affected.has(kind)),
    ),
  );
}

/**
 * Refuses an expansion that returns rows its alias type does not admit: the
 * alias is typed from the compile-time graph, that graph keeps `kind` exact,
 * and the live registry expands it to further kinds a persisted extension
 * declared. Answering would hand the caller rows whose `kind` and `NodeId`
 * contradict their static type, and narrowing silently to the exact kind
 * would be a partial answer presented as complete.
 *
 * @throws ConfigurationError (`QUERY_ALIAS_EXPANSION_UNTYPED_SUBCLASSES`)
 */
function assertExpansionWithinStaticType(
  kind: string,
  kinds: readonly string[],
  typing: AliasStaticTyping,
  registry: object,
): void {
  if (typing !== "compileTimeGraph" || kinds.length <= 1) return;
  const exactKinds = compileTimeExactAliasKindsByRegistry.get(registry);
  if (exactKinds?.has(kind) !== true) return;
  const extraKinds = kinds.filter((expandedKind) => expandedKind !== kind);
  throw new ConfigurationError(
    `Expanding "${kind}" through its subclasses would return rows of ${extraKinds.map((extraKind) => `"${extraKind}"`).join(", ")}, which the live schema declares under "${kind}" but the compile-time graph does not, so the static type of these rows ("${kind}" exactly) would be wrong.`,
    {
      code: "QUERY_ALIAS_EXPANSION_UNTYPED_SUBCLASSES",
      kind,
      extraKinds,
    },
    {
      suggestion: `State the expansion explicitly: expansion: "subclasses" on from()/to() types the rows polymorphically, and expansion: "exact" returns "${kind}" rows only. Or use fromDynamic()/toDynamic().`,
    },
  );
}

/**
 * The concrete kind list an alias resolves to under `axis` — the one place
 * `from`/`fromDynamic`/`to`/`toDynamic` and `store.search()` turn an axis
 * into `QueryStart.kinds` / `Traversal.kinds` / searched kinds.
 *
 * The `"narrower"` axis additionally REFUSES (never silently narrows) when
 * the expansion names a kind this registry does not recognize as a node
 * kind — `broader`/`narrower` accept any `NodeType`, registered or not, so
 * this is reachable. `to()`/`toDynamic()` layer an additional
 * endpoint-admission check on top of this list; see
 * `TraversalBuilder`'s own narrower handling.
 *
 * `typing` states how the caller typed the alias, so an expansion past what
 * that type admits is refused here, for every surface alike.
 *
 * @throws ConfigurationError (`ONTOLOGY_NARROWER_KIND_NOT_REGISTERED`) when
 *   `axis === "narrower"` and the expansion names an unregistered kind.
 * @throws ConfigurationError (`QUERY_ALIAS_EXPANSION_UNTYPED_SUBCLASSES`)
 *   when `typing` is `"compileTimeGraph"`, the compile-time graph types
 *   `kind` exactly, and the live registry expands it to further kinds.
 */
export function expandKindsForAxis(
  axis: AliasExpansionAxis,
  kind: string,
  registry: Pick<
    KindRegistry,
    "expandSubClasses" | "expandNarrower" | "hasNodeType"
  >,
  typing: AliasStaticTyping,
): readonly string[] {
  const kinds = kindsForAxis(axis, kind, registry);
  assertExpansionWithinStaticType(kind, kinds, typing, registry);
  return kinds;
}

function kindsForAxis(
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
