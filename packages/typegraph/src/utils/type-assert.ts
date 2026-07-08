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
