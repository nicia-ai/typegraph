/**
 * Rewrites a query AST (or a set operation or relation that embeds query ASTs)
 * so every node and edge alias it names starts with an uppercase letter:
 * `d` becomes `Dx`, `friend` becomes `Friend`. Every SQL name the compiler
 * derives from an alias (`cte_Friend`, `Friend_id`, `lm_Friend`, …) then
 * differs between PostgreSQL's folded spelling and its quoted one, which is
 * what the CTE-spelling gate (`cte-name-spelling-gate.ts`) needs to see a
 * reference spelled unlike its declaration.
 *
 * Aliases are found by the AST keys that carry them; a rename keeps the
 * alias's length unless it is one character long (so an alias at the
 * 63-character limit stays accepted). Returns `undefined` when there is
 * nothing to rename, or when the rename would make two aliases differ only by
 * case (the compiler refuses those, so the variant would test nothing).
 */
const ALIAS_KEYS = new Set([
  "alias",
  "edgeAlias",
  "nodeAlias",
  "joinFromAlias",
  "targetAlias",
]);
const CTE_ALIAS_KEY = "cteAlias";
const CTE_PREFIX = "cte_";

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function collectAliases(value: unknown, aliases: Set<string>): void {
  if (Array.isArray(value)) {
    for (const element of value) collectAliases(element, aliases);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (ALIAS_KEYS.has(key) && typeof child === "string") aliases.add(child);
    else collectAliases(child, aliases);
  }
}

/** The mixed-case spelling of one alias. */
function mixedCaseAlias(alias: string): string {
  const capitalized = `${alias.charAt(0).toUpperCase()}${alias.slice(1)}`;
  return alias.length === 1 ? `${capitalized}x` : capitalized;
}

function renamedString(
  key: string,
  value: string,
  renames: ReadonlyMap<string, string>,
): string {
  if (ALIAS_KEYS.has(key)) return renames.get(value) ?? value;
  if (key === CTE_ALIAS_KEY && value.startsWith(CTE_PREFIX)) {
    const renamedAlias = renames.get(value.slice(CTE_PREFIX.length));
    return renamedAlias === undefined ? value : `${CTE_PREFIX}${renamedAlias}`;
  }
  return value;
}

/**
 * `value` with its aliases renamed. A subtree that names no alias is returned
 * as the same object, so values the compiler checks by identity (a recorded
 * anchor, a read binding) survive the rewrite.
 */
function renameIn(
  value: unknown,
  renames: ReadonlyMap<string, string>,
): unknown {
  if (Array.isArray(value)) {
    const elements = value.map((element: unknown) =>
      renameIn(element, renames),
    );
    return elements.every((element, index) => element === value[index]) ? value
      : elements;
  }
  if (!isPlainObject(value)) return value;
  const entries = Reflect.ownKeys(value).map((key) => {
    const child = value[key];
    const renamed =
      typeof key === "string" && typeof child === "string" ?
        renamedString(key, child, renames)
      : renameIn(child, renames);
    return [key, renamed] as const;
  });
  if (entries.every(([key, renamed]) => renamed === value[key])) return value;
  return Object.fromEntries(entries);
}

/** `value` with every alias renamed to {@link mixedCaseAlias}, or `undefined`. */
export function mixedCaseAliasVariant<T>(value: T): T | undefined {
  const aliases = new Set<string>();
  collectAliases(value, aliases);
  const renames = new Map(
    [...aliases]
      .map((alias) => [alias, mixedCaseAlias(alias)] as const)
      .filter(([alias, renamed]) => alias !== renamed),
  );
  if (renames.size === 0) return undefined;
  const folded = new Set<string>();
  for (const alias of aliases) {
    const key = (renames.get(alias) ?? alias).toLowerCase();
    if (folded.has(key)) return undefined;
    folded.add(key);
  }
  return renameIn(value, renames) as T;
}
