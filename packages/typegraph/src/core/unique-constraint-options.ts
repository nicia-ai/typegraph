/**
 * The values a unique constraint's `scope` and `collation` may take, what an
 * omitted one means, and the one place a compile-time declaration is checked
 * against them and given them.
 *
 * Every reader of a declaration — the claim axis (`scope === "kind"`), the
 * stored-schema parser, the graph-extension compiler, the schema-commit
 * comparisons — must agree on what an omitted member means. So `defineGraph`
 * writes the defaults into the registration and refuses a stated value
 * outside the domain: the store would otherwise read a typo as "not `kind`"
 * and the loader's own enum would reject the stored schema. The typed API
 * requires both members; this is the runtime half, for untyped callers.
 *
 * The two document shapes have different defaults, each fixed by what the
 * store has always enforced for it (see {@link NODE_UNIQUE_CONSTRAINT_DEFAULTS}
 * and {@link EXTENSION_UNIQUE_CONSTRAINT_DEFAULTS}).
 *
 * The value lists live here because several layers validate against them:
 * `defineGraph`, the stored-schema parser (`src/schema/types.ts`) and the
 * runtime graph-extension validator (`src/graph-extension/validation.ts`).
 */
import { ConfigurationError } from "../errors/index";
import { type Collation, type UniquenessScope } from "./types";

export const UNIQUENESS_SCOPE_VALUES = [
  "kind",
  "kindWithSubClasses",
] as const satisfies readonly UniquenessScope[];

export const COLLATION_VALUES = [
  "binary",
  "caseInsensitive",
] as const satisfies readonly Collation[];

/** What a unique constraint's omitted `scope` and `collation` mean. */
export type UniqueConstraintDefaults = Readonly<{
  scope: UniquenessScope;
  collation: Collation;
}>;

/**
 * What an omitted member of a node registration's unique constraint — and of
 * the stored node document it serializes to — means.
 *
 * The claim axis reads every scope but `"kind"` as subclass-wide, so the
 * store has always enforced a declaration without a `scope` across the
 * kind's subclass component, and its claims sit at that component's axis.
 * Reading the omission any other way would move the axis under rows that
 * already hold claims.
 */
export const NODE_UNIQUE_CONSTRAINT_DEFAULTS = {
  scope: "kindWithSubClasses",
  collation: "binary",
} as const satisfies UniqueConstraintDefaults;

/**
 * What an omitted member of a graph-extension document's unique constraint
 * means: the extension compiler has always written `scope: "kind"`.
 */
export const EXTENSION_UNIQUE_CONSTRAINT_DEFAULTS = {
  scope: "kind",
  collation: "binary",
} as const satisfies UniqueConstraintDefaults;

/**
 * A unique constraint's enforcement options as a graph-extension document, a
 * stored document or an untyped caller may state them.
 */
export type StatedUniqueConstraintOptions = Readonly<{
  scope?: UniquenessScope | undefined;
  collation?: Collation | undefined;
}>;

/**
 * `constraint` with the `scope` and `collation` it is enforced under written
 * out, reading an omitted member as `defaults` says.
 */
export function withUniqueConstraintDefaults<
  C extends StatedUniqueConstraintOptions,
>(
  constraint: C,
  defaults: UniqueConstraintDefaults,
): C & UniqueConstraintDefaults {
  return {
    ...constraint,
    scope: constraint.scope ?? defaults.scope,
    collation: constraint.collation ?? defaults.collation,
  };
}

/**
 * THE reading of a unique constraint's `scope`: whether it spans the kind's
 * subclass component. The claim axis, the fence audit and the schema-commit
 * gates all ask through here, with an omitted scope read as
 * {@link NODE_UNIQUE_CONSTRAINT_DEFAULTS} says, so no consumer can hold a
 * registration that skipped `defineGraph` to a different meaning than the
 * store enforces.
 */
export function uniquenessScopeSpansSubclasses(
  scope: UniquenessScope | undefined,
): boolean {
  return (
    (scope ?? NODE_UNIQUE_CONSTRAINT_DEFAULTS.scope) === "kindWithSubClasses"
  );
}

/**
 * THE reading of a unique constraint's `collation`: whether its keys fold
 * case, with an omitted collation read as
 * {@link NODE_UNIQUE_CONSTRAINT_DEFAULTS} says.
 */
export function uniqueCollationFoldsCase(
  collation: Collation | undefined,
): boolean {
  return (
    (collation ?? NODE_UNIQUE_CONSTRAINT_DEFAULTS.collation) ===
    "caseInsensitive"
  );
}

function assertStatedLiteral(
  kind: string,
  constraintName: string,
  option: "scope" | "collation",
  value: unknown,
  allowed: readonly string[],
): void {
  if (value === undefined) return;
  if (typeof value === "string" && allowed.includes(value)) return;
  const list = allowed.map((entry) => `"${entry}"`).join(", ");
  throw new ConfigurationError(
    `Unique constraint "${constraintName}" on node kind "${kind}" declares \`${option}\` with a value that is not one of: ${list}.`,
    {
      code: "UNIQUE_CONSTRAINT_OPTION_INVALID",
      kind,
      constraintName,
      option,
      value,
    },
    { suggestion: `Declare \`${option}\` as one of ${list}, or omit it.` },
  );
}

/**
 * Refuses a compile-time unique constraint whose `scope` or `collation` is
 * stated outside its domain.
 *
 * @throws ConfigurationError (`UNIQUE_CONSTRAINT_OPTION_INVALID`)
 */
export function assertUniqueConstraintOptions(
  kind: string,
  constraint: Readonly<{ name: string; scope?: unknown; collation?: unknown }>,
): void {
  assertStatedLiteral(
    kind,
    constraint.name,
    "scope",
    constraint.scope,
    UNIQUENESS_SCOPE_VALUES,
  );
  assertStatedLiteral(
    kind,
    constraint.name,
    "collation",
    constraint.collation,
    COLLATION_VALUES,
  );
}
