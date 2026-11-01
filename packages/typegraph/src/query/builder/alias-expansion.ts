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
 * The surface whose default overload types an alias from the compile-time
 * graph, named in a refusal's suggestion so it advises that call.
 */
export type CompileTimeTypedSurface = "from()" | "to()";

/**
 * What the calling surface computed its alias (or hit) type from:
 *
 * - `"compileTimeGraph"` — `AliasNodeType<G, K>`, which widens `kind` and
 *   `NodeId` only for a kind `G`'s ontology affects: the default overload of
 *   `from()` / `to()`, including list sources.
 * - `"independent"` — a type that never consults `G`'s ontology: the exact
 *   kind, the unconditional `PolymorphicNodeType` of a stated
 *   `"subclasses"` alias or search, the untyped `NodeAlias`, or a runtime
 *   kind (`fromDynamic()` / `toDynamic()`).
 */
export type AliasStaticTyping =
  | Readonly<{
      typedFrom: "compileTimeGraph";
      surface: CompileTimeTypedSurface;
    }>
  | Readonly<{ typedFrom: "independent" }>;

export const INDEPENDENT_ALIAS_TYPING: AliasStaticTyping = {
  typedFrom: "independent",
};

/**
 * The {@link AliasStaticTyping} the `from()` / `to()` overloads give an
 * alias for `options`: an alias that states no `expansion` takes the default
 * overload, typed from the compile-time graph; every stated axis selects an
 * overload whose type does not depend on it.
 */
export function aliasOverloadTyping(
  options: AliasExpansionOptions | undefined,
  surface: CompileTimeTypedSurface,
): AliasStaticTyping {
  return options?.expansion === undefined ?
      { typedFrom: "compileTimeGraph", surface }
    : INDEPENDENT_ALIAS_TYPING;
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

type KindExpansion = Readonly<{
  kind: string;
  kinds: readonly string[];
}>;

/**
 * Refuses an expansion that returns rows its alias type does not admit: the
 * alias is typed from the compile-time graph, that graph keeps a source
 * `kind` exact, and the live registry expands it to further kinds a
 * persisted extension declared. Answering would hand the caller rows whose
 * `kind` and `NodeId` contradict their static type, and narrowing silently
 * to the exact kind would be a partial answer presented as complete.
 *
 * For a list source, an extra kind another member of the list's static type
 * admits is not refused: a kind the list names itself (typed exactly), or one
 * in the expansion of a listed kind the compile-time graph already types
 * polymorphically.
 *
 * @throws ConfigurationError (`QUERY_ALIAS_EXPANSION_UNTYPED_SUBCLASSES`)
 */
function assertExpansionWithinStaticType(
  expansions: readonly KindExpansion[],
  typing: AliasStaticTyping,
  registry: object,
): void {
  if (typing.typedFrom !== "compileTimeGraph") return;
  const exactKinds = compileTimeExactAliasKindsByRegistry.get(registry);
  if (exactKinds === undefined) return;
  const admittedKinds = new Set(
    expansions.flatMap(({ kind, kinds }) =>
      exactKinds.has(kind) ? [kind] : kinds,
    ),
  );
  for (const { kind, kinds } of expansions) {
    if (!exactKinds.has(kind)) continue;
    const extraKinds = kinds.filter(
      (expandedKind) => !admittedKinds.has(expandedKind),
    );
    if (extraKinds.length === 0) continue;
    throw untypedSubclassesError(
      kind,
      extraKinds,
      typing.surface,
      expansions.length > 1,
    );
  }
}

function untypedSubclassesError(
  kind: string,
  extraKinds: readonly string[],
  surface: CompileTimeTypedSurface,
  isListSource: boolean,
): ConfigurationError {
  const extraKindList = extraKinds
    .map((extraKind) => `"${extraKind}"`)
    .join(", ");
  const staticType =
    isListSource ?
      `one of the listed kinds, with "${kind}" exactly`
    : `"${kind}" exactly`;
  const dynamicSurface = surface === "from()" ? "fromDynamic()" : "toDynamic()";
  const suggestion =
    isListSource ?
      `State the expansion explicitly: expansion: "subclasses" on ${surface} types every listed kind polymorphically, and expansion: "exact" returns rows of the listed kinds only.`
    : `State the expansion explicitly: expansion: "subclasses" on ${surface} types the rows polymorphically, and expansion: "exact" returns "${kind}" rows only. Or use ${dynamicSurface}.`;
  return new ConfigurationError(
    `Expanding "${kind}" through its subclasses would return rows of ${extraKindList}, which the live schema declares under "${kind}" but the compile-time graph does not, so the static type of these rows (${staticType}) would be wrong.`,
    {
      code: "QUERY_ALIAS_EXPANSION_UNTYPED_SUBCLASSES",
      kind,
      extraKinds,
    },
    { suggestion },
  );
}

type ExpansionRegistry = Pick<
  KindRegistry,
  "expandSubClasses" | "expandNarrower" | "hasNodeType"
>;

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
 *   when `typing.typedFrom` is `"compileTimeGraph"`, the compile-time graph
 *   types `kind` exactly, and the live registry expands it to further kinds.
 */
export function expandKindsForAxis(
  axis: AliasExpansionAxis,
  kind: string,
  registry: ExpansionRegistry,
  typing: AliasStaticTyping,
): readonly string[] {
  return expandKindListForAxis(axis, [kind], registry, typing);
}

/**
 * {@link expandKindsForAxis} for a list source: the deduplicated union of
 * every listed kind's expansion, refused only for an extra kind no member of
 * the list's static type admits.
 */
export function expandKindListForAxis(
  axis: AliasExpansionAxis,
  sourceKinds: readonly string[],
  registry: ExpansionRegistry,
  typing: AliasStaticTyping,
): readonly string[] {
  const expansions = sourceKinds.map((kind) => ({
    kind,
    kinds: kindsForAxis(axis, kind, registry),
  }));
  assertExpansionWithinStaticType(expansions, typing, registry);
  return [...new Set(expansions.flatMap(({ kinds }) => kinds))];
}

function kindsForAxis(
  axis: AliasExpansionAxis,
  kind: string,
  registry: ExpansionRegistry,
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
