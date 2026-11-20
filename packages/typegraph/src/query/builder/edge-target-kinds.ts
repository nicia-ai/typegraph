/**
 * Reads node kinds without an inferred conditional that stays deferred for
 * arrays of generic node types. Non-array values contribute never.
 */
export type ArrayNodeKinds<T> = T[number & keyof T]["kind" &
  keyof T[number & keyof T]] &
  string;

/** Projects each declaration separately so mixed arrays/maps retain all kinds. */
export type EdgeTargetKinds<T> =
  T extends unknown ? ArrayNodeKinds<T> | ArrayNodeKinds<T[keyof T]> : never;
