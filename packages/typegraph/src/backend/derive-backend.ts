/**
 * The one construction seam for derived backends.
 *
 * Every backend the library builds FROM another backend — an overlay, an
 * allowlist projection, a narrowing-by-omission, a managed-close wrapper — is
 * built here, and every constructor in this module carries the source's
 * serialized-resource audit onto the object it returns. Raw `{ ...backend }`,
 * `Object.assign` and rest-omission construction build a NEW object the audit
 * does not follow, which is the defect this module exists to make unreachable:
 * a derived backend that lost its mark reads as unowned, and the import/clone
 * guards then let a read-and-write-through-one-connection stream proceed into a
 * deadlock.
 *
 * This is the only module that imports {@link carryBackendResourceAudit}.
 *
 * Naming convention this module's ratchet depends on: an identifier ending in
 * `Backend` denotes a whole backend object; a members fragment is named
 * `*Members`.
 */
import {
  GRAPH_BACKEND_PROJECTION_KEYS,
  type ProjectedGraphBackendKey,
} from "./graph-backend-keys";
import { carryBackendResourceAudit } from "./transaction-resource";
import {
  type AdapterBackend,
  type GraphBackend,
  type TransactionBackend,
} from "./types";

/**
 * Rejects overlay members that are not members of the decorated backend, so a
 * misspelled override cannot silently add a property nothing forwards to.
 *
 * @internal
 */
export type ExactBackendOverlay<T extends object, O extends Partial<T>> = O &
  Readonly<Record<Exclude<keyof O, keyof T>, never>>;

/**
 * Decorates a backend with overlay members without copying it.
 *
 * This is a decoration primitive: every non-overridden target property remains
 * reachable. Never use it to narrow a capability surface; construct an
 * explicit allowlist projection first, then decorate that projection.
 *
 * Backend wrappers use this instead of object spread so proxy backends keep
 * getters and non-enumerable members, and so the derived object carries the
 * source's serialized-resource audit. GraphBackend functions are receiver-free
 * by contract, so delegated methods are returned unchanged.
 */
export function deriveBackend<
  T extends GraphBackend | TransactionBackend,
  const O extends Partial<T> = Partial<T>,
>(base: T, overrides: ExactBackendOverlay<T, O>): T {
  function hasOverlayProperty(property: PropertyKey): boolean {
    return Object.hasOwn(overrides, property);
  }

  const decoratedBackend = new Proxy(base, {
    get(targetObject, property) {
      if (hasOverlayProperty(property)) {
        return Reflect.get(overrides, property, overrides);
      }
      return Reflect.get(targetObject, property, targetObject);
    },

    has(targetObject, property) {
      return (
        hasOverlayProperty(property) || Reflect.has(targetObject, property)
      );
    },

    ownKeys(targetObject) {
      return [
        ...new Set([
          ...Reflect.ownKeys(targetObject),
          ...Reflect.ownKeys(overrides),
        ]),
      ];
    },

    getOwnPropertyDescriptor(targetObject, property) {
      if (hasOverlayProperty(property)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(
          overrides,
          property,
        );
        if (descriptor === undefined) return;
        return { ...descriptor, configurable: true };
      }
      return Reflect.getOwnPropertyDescriptor(targetObject, property);
    },

    set(targetObject, property, value) {
      if (hasOverlayProperty(property)) {
        return Reflect.set(overrides, property, value, overrides);
      }
      return Reflect.set(targetObject, property, value, targetObject);
    },

    defineProperty(targetObject, property, attributes) {
      if (hasOverlayProperty(property)) {
        return Reflect.defineProperty(overrides, property, attributes);
      }
      return Reflect.defineProperty(targetObject, property, attributes);
    },

    deleteProperty(targetObject, property) {
      if (hasOverlayProperty(property)) {
        return Reflect.deleteProperty(overrides, property);
      }
      return Reflect.deleteProperty(targetObject, property);
    },
  });
  carryBackendResourceAudit(decoratedBackend, base);
  return decoratedBackend;
}

/**
 * Copies exactly `keys` off `base` into a fresh object.
 *
 * Generic over the SOURCE's own type, so a structurally wider input keeps the
 * declared types of the members it does provide. Keys the source does not
 * carry stay absent rather than becoming `undefined` members.
 *
 * @internal
 */
export function projectBackend<
  TBackend extends object,
  const TKey extends keyof TBackend,
>(base: TBackend, keys: readonly TKey[]): Readonly<Pick<TBackend, TKey>> {
  const entries = keys.flatMap((key) => {
    if (!Reflect.has(base, key)) return [];
    return [[key, Reflect.get(base, key)] as const];
  });

  // Keys are constrained to TBackend and values are copied from that same
  // object without reshaping. Optional members remain absent.
  const projection = Object.fromEntries(entries) as Readonly<
    Pick<TBackend, TKey>
  >;
  // A projection forwards every statement to the SAME connection as its source,
  // so it owns the same serialized transaction resource. Carrying here rather
  // than at each call site keeps the verdict attached through the projections
  // built deep inside the store (recorded-time capture, hooked query backends),
  // where an import guard would otherwise see an unaudited backend and let a
  // read-and-write-through-one-connection stream proceed into a deadlock.
  carryBackendResourceAudit(projection, base);
  return projection;
}

/**
 * Every key a derived backend must retain: the source's own keys — enumerable
 * or not, string or symbol — plus every key on its prototype chain up to, but
 * not including, `Object.prototype`.
 *
 * A class-implemented GraphBackend is a supported shape and keeps its methods
 * on the prototype, so `Reflect.ownKeys` alone would silently drop them.
 */
function backendKeys<TBackend extends object>(
  base: TBackend,
): readonly (keyof TBackend)[] {
  const keys = new Set<PropertyKey>();
  let current: object | undefined = base;
  while (current !== undefined && current !== Object.prototype) {
    for (const key of Reflect.ownKeys(current)) keys.add(key);
    current = Reflect.getPrototypeOf(current) ?? undefined;
  }
  // Every key was enumerated off `base` itself, so each one is a key of
  // TBackend at runtime; the compiler cannot narrow `PropertyKey` against an
  // unresolved type parameter.
  return [...keys] as unknown as readonly (keyof TBackend)[];
}

/**
 * Narrows a backend by omission — the seam replacement for
 * `const { omitted, ...rest } = backend`.
 *
 * Omits from the SOURCE's keys, so a structurally wider input (an
 * `AdapterBackend` with `transactionWithNative` / `adoptTransaction`) keeps
 * every member it had except the named ones.
 *
 * KEY RULE, deliberately NOT the rest destructure's rule: the retained set is
 * every own key (enumerable or not, string or symbol) PLUS every key on the
 * prototype chain up to — not including — `Object.prototype`, minus `omitted`.
 * A rest destructure copies only own ENUMERABLE keys and drops prototype
 * members; the declared `Omit<TBackend, TKey>` promises they survive, and
 * enumerating the prototype chain is what makes that promise true. Retaining
 * non-enumerable own keys is the other deliberate difference: a member hidden
 * behind a non-enumerable descriptor is still a member the wrapper forwards.
 *
 * @internal
 */
export function projectBackendWithout<
  TBackend extends object,
  const TKey extends keyof TBackend,
>(base: TBackend, omitted: readonly TKey[]): Omit<TBackend, TKey> {
  const excluded = new Set<PropertyKey>(omitted);
  const retained = backendKeys(base).filter((key) => !excluded.has(key));
  return projectBackend(base, retained);
}

/**
 * Creates a runtime GraphBackend projection.
 *
 * Structurally wider inputs (for example AdapterBackend) lose every property
 * not named by the portable GraphBackend allowlist. Optional port members stay
 * absent when the source does not provide them.
 *
 * @internal
 */
export function projectGraphBackend(base: GraphBackend): GraphBackend {
  return projectBackend<GraphBackend, ProjectedGraphBackendKey>(
    base,
    GRAPH_BACKEND_PROJECTION_KEYS,
  );
}

/**
 * Wraps a GraphBackend with idempotent close that also runs a teardown
 * callback (e.g. closing the underlying database connection).
 */
export function wrapWithManagedClose<TNativeTransaction>(
  backend: AdapterBackend<TNativeTransaction>,
  teardown: () => void | Promise<void>,
): AdapterBackend<TNativeTransaction>;
export function wrapWithManagedClose(
  backend: GraphBackend,
  teardown: () => void | Promise<void>,
): GraphBackend;
export function wrapWithManagedClose(
  backend: GraphBackend,
  teardown: () => void | Promise<void>,
): GraphBackend {
  let backendClosed = false;
  let teardownComplete = false;
  let closeInFlight: Promise<void> | undefined;

  async function closeManagedResources(): Promise<void> {
    const errors: unknown[] = [];
    if (!backendClosed) {
      try {
        await backend.close();
        backendClosed = true;
      } catch (error) {
        errors.push(error);
      }
    }
    if (!teardownComplete) {
      try {
        await teardown();
        teardownComplete = true;
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(
        errors,
        "The backend and its managed resource both failed to close.",
      );
    }
  }

  const closeOverlay: Pick<GraphBackend, "close"> = {
    async close(): Promise<void> {
      if (backendClosed && teardownComplete) return;
      closeInFlight ??= closeManagedResources().finally(() => {
        closeInFlight = undefined;
      });
      await closeInFlight;
    },
  };
  return deriveBackend(backend, closeOverlay);
}
