export const SELECTABLE_ALIAS_MARKER = Symbol("selectable_alias_marker");

export type SelectableAliasMarker = Readonly<{
  alias: string;
  kind: "node" | "edge";
}>;

function isSelectableAliasObject(
  value: unknown,
): value is SelectableAliasMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    SELECTABLE_ALIAS_MARKER in value
  );
}

export function containsSelectableAliasObject(value: unknown): boolean {
  const visited = new WeakSet<object>();

  function walk(current: unknown): boolean {
    if (isSelectableAliasObject(current)) return true;

    if (typeof current !== "object" || current === null) return false;
    if (visited.has(current)) return false;
    visited.add(current);

    if (Array.isArray(current)) {
      for (const item of current) {
        if (walk(item)) return true;
      }
      return false;
    }

    for (const value of Object.values(current)) {
      if (walk(value)) return true;
    }
    return false;
  }

  return walk(value);
}
