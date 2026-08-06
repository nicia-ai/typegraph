import { type GraphBackend } from "./types";

const SERIALIZED_TRANSACTION_RESOURCES = new WeakMap<object, object>();

/** Marks backends whose distinct wrappers still serialize on one connection. */
export function markSerializedTransactionResource(
  backend: GraphBackend,
  resource: object,
): void {
  SERIALIZED_TRANSACTION_RESOURCES.set(backend, resource);
}

/** Preserves serialized-resource ownership when decorating a backend. */
export function inheritSerializedTransactionResource(
  target: object,
  source: object,
): void {
  const resource = SERIALIZED_TRANSACTION_RESOURCES.get(source);
  if (resource !== undefined) {
    SERIALIZED_TRANSACTION_RESOURCES.set(target, resource);
  }
}

/** Whether two backend wrappers cannot make snapshot reads and writes concurrently. */
export function sharesSerializedTransactionResource(
  left: GraphBackend,
  right: GraphBackend,
): boolean {
  const leftResource = SERIALIZED_TRANSACTION_RESOURCES.get(left);
  return (
    leftResource !== undefined &&
    leftResource === SERIALIZED_TRANSACTION_RESOURCES.get(right)
  );
}
