/**
 * The one construction seam for derived backends.
 *
 * Every backend the library builds FROM another backend — an overlay, an
 * allowlist projection, a narrowing-by-omission, a managed-close wrapper — is
 * built here, and every constructor in this module carries the source's
 * serialized-resource audit, its first-party-factory write-fence mark, and
 * its schema-fenced-insert origin evidence onto the object it returns. Raw
 * `{ ...backend }`, `Object.assign` and rest-omission construction build a
 * NEW object none of those proofs follow, which
 * is the defect this module exists to make unreachable: a derived backend
 * that lost its resource-audit mark reads as unowned, and the import/clone
 * guards then let a read-and-write-through-one-connection stream proceed into
 * a deadlock; one that lost its write-fence mark would resolve
 * `resolveWriteFencePlan`'s dialect-derivation arm at one call site and
 * `unfenced` at another for the same underlying backend.
 *
 * This is the only module that imports {@link carryBackendResourceAudit},
 * {@link carryFirstPartyFactoryMark}, and
 * {@link carrySchemaFencedInsertEligibility}.
 *
 * Naming convention this module's ratchet depends on: an identifier ending in
 * `Backend` denotes a whole backend object; a members fragment is named
 * `*Members`.
 */
import { downgradeRootAtomicBatch } from "./capabilities/execution";
import { carrySchemaFencedInsertEligibility } from "./capabilities/schema-fenced-insert";
import { carryFirstPartyFactoryMark } from "./capabilities/write-fence";
import { carryGraphCommandPortSessionMetadata } from "./command-contract";
import {
  GRAPH_BACKEND_PROJECTION_KEYS,
  type ProjectedGraphBackendKey,
} from "./graph-backend-keys";
import { carryBackendResourceAudit } from "./transaction-resource";
import {
  type AdapterBackend,
  type BackendCapabilities,
  type GraphBackend,
  type GraphCommandPort,
} from "./types";

/**
 * Rejects overlay members that are not members of the decorated backend, so a
 * misspelled override cannot silently add a property nothing forwards to.
 *
 * @internal
 */
export type ExactBackendOverlay<T extends object, O extends Partial<T>> = O &
  Readonly<Record<Exclude<keyof O, keyof T>, never>>;

function isGraphCommandPort(value: unknown): value is GraphCommandPort {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Readonly<Record<string, unknown>>;
  return (
    (candidate["session"] === "root" ||
      candidate["session"] === "transaction") &&
    typeof candidate["execute"] === "function"
  );
}

function downgradeDerivedAtomicBatch(capabilities: unknown): unknown {
  if (typeof capabilities !== "object" || capabilities === null) return;
  const capabilityMembers = capabilities as Readonly<
    Record<PropertyKey, unknown>
  >;
  const execution = capabilityMembers["execution"];
  if (typeof execution !== "object" || execution === null) return;
  const executionMembers = execution as Readonly<Record<PropertyKey, unknown>>;
  if (!("atomicBatch" in executionMembers)) return;
  return downgradeRootAtomicBatch(capabilityMembers as BackendCapabilities);
}

function deriveExecutionCapabilities(base: object, overrides: object): unknown {
  const capabilities =
    Object.hasOwn(overrides, "capabilities") ?
      (Reflect.get(overrides, "capabilities", overrides) as unknown)
    : (Reflect.get(base, "capabilities", base) as unknown);
  return downgradeDerivedAtomicBatch(capabilities);
}

/**
 * A same-session command-port wrapper preserves the underlying transaction's
 * coordination and isolation evidence. A root-to-transaction override is a
 * deliberate session boundary (recorded capture opens that transaction), so
 * it starts with fresh evidence that the transaction factory must bind.
 */
function carryDerivedCommandPortMetadata(
  base: object,
  overrides: object,
): void {
  if (!Object.hasOwn(overrides, "commands")) return;
  const baseCommands: unknown = Reflect.get(base, "commands");
  const overrideCommands: unknown = Reflect.get(overrides, "commands");
  if (
    isGraphCommandPort(baseCommands) &&
    isGraphCommandPort(overrideCommands) &&
    baseCommands.session === overrideCommands.session
  ) {
    carryGraphCommandPortSessionMetadata(baseCommands, overrideCommands);
  }
}

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
 *
 * `T` is bounded by `object`, not by the backend union — the same bound
 * {@link projectBackend} carries — so a PROJECTION is decorable too: the write
 * pipeline's read-only row-work target is what a batch's pending-aware
 * validation overlays. `ExactBackendOverlay` still rejects any key `T` does not
 * declare, so the looser bound cannot smuggle a member onto a surface that
 * withholds it.
 */
export function deriveBackend<
  T extends object,
  const O extends Partial<T> = Partial<T>,
>(base: T, overrides: ExactBackendOverlay<T, O>): T {
  const derivedCapabilities = deriveExecutionCapabilities(base, overrides);
  // A Proxy may not report a different value for a non-writable,
  // non-configurable data property on its target. Bundled backends are often
  // frozen at public boundaries, so proxying `base` directly makes a valid
  // overlay throw before it can forward anything. The extensible shell owns
  // no backend members; every operation below still delegates to `base` or
  // `overrides`, preserving getters and the no-copy decoration contract.
  const decorationShell = Object.create(Reflect.getPrototypeOf(base)) as T;

  function hasOverlayProperty(property: PropertyKey): boolean {
    return Object.hasOwn(overrides, property);
  }

  const decoratedBackend = new Proxy(decorationShell, {
    get(_targetObject, property) {
      if (property === "capabilities" && derivedCapabilities !== undefined) {
        return derivedCapabilities;
      }
      if (hasOverlayProperty(property)) {
        return Reflect.get(overrides, property, overrides);
      }
      return Reflect.get(base, property, base);
    },

    has(_targetObject, property) {
      return hasOverlayProperty(property) || Reflect.has(base, property);
    },

    ownKeys() {
      return [
        ...new Set([...Reflect.ownKeys(base), ...Reflect.ownKeys(overrides)]),
      ];
    },

    getOwnPropertyDescriptor(_targetObject, property) {
      if (property === "capabilities" && derivedCapabilities !== undefined) {
        const source = hasOverlayProperty(property) ? overrides : base;
        const descriptor = Reflect.getOwnPropertyDescriptor(source, property);
        return descriptor === undefined ? undefined : (
            {
              configurable: true,
              enumerable: descriptor.enumerable ?? false,
              value: derivedCapabilities,
              writable: "writable" in descriptor ? descriptor.writable : false,
            }
          );
      }
      if (hasOverlayProperty(property)) {
        const descriptor = Reflect.getOwnPropertyDescriptor(
          overrides,
          property,
        );
        if (descriptor === undefined) return;
        return { ...descriptor, configurable: true };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(base, property);
      return descriptor === undefined ? undefined : (
          { ...descriptor, configurable: true }
        );
    },

    set(_targetObject, property, value) {
      if (hasOverlayProperty(property)) {
        return Reflect.set(overrides, property, value, overrides);
      }
      return Reflect.set(base, property, value, base);
    },

    defineProperty(_targetObject, property, attributes) {
      if (hasOverlayProperty(property)) {
        return Reflect.defineProperty(overrides, property, attributes);
      }
      return Reflect.defineProperty(base, property, attributes);
    },

    deleteProperty(_targetObject, property) {
      if (hasOverlayProperty(property)) {
        return Reflect.deleteProperty(overrides, property);
      }
      return Reflect.deleteProperty(base, property);
    },
  });
  carryBackendResourceAudit(decoratedBackend, base);
  carryFirstPartyFactoryMark(decoratedBackend, base);
  carrySchemaFencedInsertEligibility(decoratedBackend, base);
  carryDerivedCommandPortMetadata(base, overrides);
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
    const value = Reflect.get(base, key) as unknown;
    const projectedValue =
      key === "capabilities" ?
        (downgradeDerivedAtomicBatch(value) ?? value)
      : value;
    return [[key, projectedValue] as const];
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
  carryFirstPartyFactoryMark(projection, base);
  carrySchemaFencedInsertEligibility(projection, base);
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
