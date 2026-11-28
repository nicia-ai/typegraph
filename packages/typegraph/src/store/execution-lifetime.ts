// This overlay only guards existing operation members; it does not narrow the port.
// eslint-disable-next-line no-restricted-syntax -- preserves session/resource derivation for a callback-owned backend
import { deriveBackend } from "../backend/derive-backend";
import { GRAPH_BACKEND_PROJECTION_KEYS } from "../backend/graph-backend-keys";
import type { GraphBackend } from "../backend/types";
import { TransactionClosedError } from "../errors";
import { createDataKeyedBag } from "../utils/object";
import type {
  StoreTransactionBackend,
  TransactionSession,
} from "./operation-scope";
import { guardRecordedSessionLifetime } from "./recorded-capture";

/** A callback-owned backend whose operations refuse execution after sealing. */
export type ScopedExecutionBackend<
  T extends GraphBackend | StoreTransactionBackend,
> = Readonly<{
  backend: T;
  seal: () => void;
}>;

const NESTED_OPERATION_PORTS = new Set<PropertyKey>([
  "commands",
  "catalog",
  "lineage",
  "recordedTime",
]);

/**
 * Decorates an adopted session before any callback views are constructed.
 * A deferred operation keeps this backend, so its execution checks the scope
 * even if its query or collection was built while the callback was active.
 *
 * `session` is the session the decorated backend is the surface of: its
 * recorded binding takes the same lifetime, so a recorded control statement
 * or identity write one of its operations issues beneath the surface is
 * refused once the scope is sealed, as the surface's own members are.
 */
export function scopeBackendExecution<
  T extends GraphBackend | StoreTransactionBackend,
>(sourceBackend: T, session: TransactionSession): ScopedExecutionBackend<T> {
  let active = true;

  function assertActive(): void {
    if (!active) throw new TransactionClosedError();
  }

  function guardOperationPort(port: object): object {
    const members = createDataKeyedBag<unknown>() as Record<
      PropertyKey,
      unknown
    >;
    for (const key of Reflect.ownKeys(port)) {
      const value: unknown = Reflect.get(port, key, port);
      members[key] =
        typeof value === "function" ?
          (...args: readonly unknown[]) => {
            assertActive();
            return Reflect.apply(value, undefined, args) as unknown;
          }
        : value;
    }
    return members;
  }

  const guardedMembers = createDataKeyedBag<unknown>() as Record<
    PropertyKey,
    unknown
  >;
  for (const key of new Set<PropertyKey>([
    ...GRAPH_BACKEND_PROJECTION_KEYS,
    ...Reflect.ownKeys(sourceBackend),
  ])) {
    if (!Reflect.has(sourceBackend, key)) continue;
    const value: unknown = Reflect.get(sourceBackend, key, sourceBackend);
    if (typeof value === "function") {
      guardedMembers[key] = (...args: readonly unknown[]) => {
        assertActive();
        return Reflect.apply(value, undefined, args) as unknown;
      };
    } else if (
      NESTED_OPERATION_PORTS.has(key) &&
      typeof value === "object" &&
      value !== null
    ) {
      guardedMembers[key] = guardOperationPort(value);
    }
  }

  const backend = deriveBackend(sourceBackend, guardedMembers as T);
  guardRecordedSessionLifetime(session, assertActive);
  return {
    backend,
    seal: () => {
      active = false;
    },
  };
}
