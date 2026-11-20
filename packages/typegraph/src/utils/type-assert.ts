/**
 * Compile-time equality/assertion helpers for "this derived type must exactly
 * match that one" invariants — e.g. a literal method-name union that must
 * stay in sync with a mapped type's keys. A mismatch fails to compile instead
 * of silently drifting at runtime.
 */
export type Assert<T extends true> = T;

export type Equal<A, B> =
  [A] extends [B] ?
    [B] extends [A] ?
      true
    : false
  : false;

/**
 * Whether every member of `M` appears in `List` — the I13 containment check a
 * literal allowlist owes a bundle's core: a list that dropped one of the
 * bundle's members would silently narrow what the allowlist projects/permits
 * without `pnpm typecheck` ever noticing.
 */
export type ContainsAll<List extends readonly string[], M extends string> =
  [Exclude<M, List[number]>] extends [never] ? true : false;
