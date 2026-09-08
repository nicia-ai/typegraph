/**
 * The one owner of "which expansion axis does this alias use" (Q3, C.3).
 *
 * An alias carries EXACTLY ONE expansion axis:
 *
 * - `"exact"` — only the named kind.
 * - `"subClasses"` — the kind and every `subClassOf`/`equivalentTo`
 *   descendant (`registry.expandSubClasses`). The store-wide default once
 *   C ships (roadmap Q3): a supertype query is polymorphic unless narrowed.
 * - `"narrower"` — the kind and every `broader`/`narrower` descendant
 *   (`registry.expandNarrower`, C.3). No schema relationship is claimed, so
 *   the alias type is untyped.
 *
 * `from()` / `to()` / `fromDynamic()` / `toDynamic()` all resolve their
 * expansion through this one function and nothing else re-derives it.
 */
import { ConfigurationError } from "../../errors";
import { type KindRegistry } from "../../registry/kind-registry";

export type AliasExpansionAxis = "exact" | "subClasses" | "narrower";

export type AliasExpansionOptions = Readonly<{
  includeSubClasses?: boolean;
  includeNarrower?: boolean;
}>;

/**
 * Resolves the expansion axis for one alias.
 *
 * | `includeSubClasses` | `includeNarrower` | axis |
 * | --- | --- | --- |
 * | absent | absent / `false` | store default (`true` ⇒ `"subClasses"`, `false` ⇒ `"exact"`) |
 * | `true` | absent / `false` | `"subClasses"` |
 * | `false` | absent / `false` | `"exact"` |
 * | absent / `false` | `true` | `"narrower"` |
 * | `true` | `true` | refused — `ConfigurationError`, `QUERY_ALIAS_EXPANSION_CONFLICT` |
 *
 * An explicit `includeNarrower: true` replaces the subclass DEFAULT — a
 * default is not a stated value — so only two explicit `true`s collide.
 *
 * @throws ConfigurationError when both `includeSubClasses: true` and
 *   `includeNarrower: true` are stated on the same alias.
 */
export function resolveAliasExpansion(
  options: AliasExpansionOptions | undefined,
  storeDefaultIncludeSubClasses: boolean,
): AliasExpansionAxis {
  const includeSubClasses = options?.includeSubClasses;
  const includeNarrower = options?.includeNarrower ?? false;

  if (includeSubClasses === true && includeNarrower) {
    throw new ConfigurationError(
      "includeSubClasses and includeNarrower cannot both be requested for the same alias.",
      {
        code: "QUERY_ALIAS_EXPANSION_CONFLICT",
        includeSubClasses,
        includeNarrower,
      },
      {
        suggestion:
          "Choose one expansion axis: includeSubClasses for a subtype hierarchy (subClassOf/equivalentTo), or includeNarrower for a broader/narrower kind taxonomy.",
      },
    );
  }

  if (includeNarrower) return "narrower";
  if (includeSubClasses === false) return "exact";
  if (includeSubClasses === true) return "subClasses";
  return storeDefaultIncludeSubClasses ? "subClasses" : "exact";
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
    case "subClasses": {
      return registry.expandSubClasses(kind);
    }
    case "narrower": {
      const kinds = registry.expandNarrower(kind);
      for (const narrowerKind of kinds) {
        if (registry.hasNodeType(narrowerKind)) continue;
        throw new ConfigurationError(
          `includeNarrower expansion of "${kind}" includes "${narrowerKind}", which is not a registered node kind.`,
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
