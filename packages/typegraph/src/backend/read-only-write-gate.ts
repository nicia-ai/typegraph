/**
 * THE enforcement point of a read-only scope: the backend object every
 * statement passes.
 *
 * A read-only `store.transaction` opens a read-only scope on the native
 * transaction it runs on and on the driver connection that transaction runs
 * on (`openReadOnlyScope`). A backend object bound to that transaction (a
 * transaction backend the engine opened, a backend built over the caller's
 * `tx.sql`, a savepoint either opens) or running on that connection (a root
 * backend over a one-connection SQLite driver) resolves the same fact
 * (`backendReadOnlyScopeGraph`), so each member that can write refuses with
 * the typed read-only refusal before any statement, whichever entry point
 * reached it: a Store surface, a schema entry point that takes a backend, a
 * maintenance export, or code that has not been written yet.
 *
 * Which members are writes is `member-access.ts`'s table, compile-time total
 * over every backend member name. The bundled factories apply the gate at
 * construction ({@link gateBackendUnderConstruction}), through
 * `derive-backend.ts`, never by copying; an atomic mutation program, which
 * dispatches its statements without going through a member, asks the same
 * question at dispatch (`atomic-mutation-program.ts`). A raw-SQL member
 * refuses only a statement library code marked as a write
 * (`asCompiledWriteStatementSql`): SQL a caller wrote is the engine's to refuse.
 *
 * A hand-written backend is not gated here: nothing ties its objects to a
 * native transaction. The Store's own refusals still apply to every write
 * through a context or Store over a session it opened read-only.
 */
import { hasWriteIntent } from "../query/sql-intent";
import {
  backendReadOnlyScopeGraph,
  refuseReadOnlyTransactionWrite,
} from "../store/native-transaction-state";
import { requireDefined } from "../utils/presence";
import {
  deriveBackendUnderConstruction,
  type ExactBackendOverlay,
  isGraphCommandPort,
} from "./derive-backend";
import { backendMembersWithAccess } from "./member-access";
import type { GraphCommandPort } from "./types";

const READ_ONLY_SUGGESTION =
  'This backend runs inside a transaction TypeGraph opened with accessMode: "read_only". Run the write outside that transaction, or open it without accessMode: "read_only".';

/**
 * Refuses `operation` with the typed read-only refusal when `backend` runs
 * inside a read-only scope TypeGraph opened (`backendReadOnlyScopeGraph`),
 * naming the graph whose transaction opened it.
 */
export function assertBackendWritable(
  backend: object,
  operation: string,
): void {
  const graphId = backendReadOnlyScopeGraph(backend);
  if (graphId === undefined) return;
  refuseReadOnlyTransactionWrite(operation, graphId, READ_ONLY_SUGGESTION);
}

/** The refusal {@link assertBackendWritable} raises, as a rejection. */
function refusalOf(
  backend: object,
  operation: string,
): Promise<never> | undefined {
  try {
    assertBackendWritable(backend, operation);
    return undefined;
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

/** The members the gate wraps, read once from the classification. */
const WRITE_MEMBERS = backendMembersWithAccess("write");
const RAW_MEMBERS = backendMembersWithAccess("raw");

type BackendFunction = (...args: readonly unknown[]) => unknown;

function gateWriteMember(
  self: () => object,
  member: string,
  original: BackendFunction,
): BackendFunction {
  return (...args) =>
    refusalOf(self(), `backend.${member}()`) ?? original(...args);
}

/** The transaction openers: their second argument is the transaction's options. */
const TRANSACTION_OPENERS: ReadonlySet<string> = new Set([
  "transaction",
  "transactionWithNative",
]);

/**
 * A transaction opener, gated: a read-write unit is refused as it opens; one
 * opened with `accessMode: "read_only"` is a read, let through.
 */
function gateTransactionOpener(
  self: () => object,
  member: string,
  original: BackendFunction,
): BackendFunction {
  return (...args) => {
    const options = args[1] as Readonly<{ accessMode?: unknown }> | undefined;
    const refusal =
      options?.accessMode === "read_only" ?
        undefined
      : refusalOf(self(), `backend.${member}()`);
    return refusal ?? original(...args);
  };
}

function gateRawMember(
  self: () => object,
  member: string,
  original: BackendFunction,
): BackendFunction {
  return (...args) => {
    const [statement] = args;
    const refusal =
      hasWriteIntent(statement) ?
        refusalOf(self(), `backend.${member}()`)
      : undefined;
    return refusal ?? original(...args);
  };
}

function gateCommandPort(
  self: () => object,
  port: GraphCommandPort,
): GraphCommandPort {
  return {
    session: port.session,
    execute: (command, context) =>
      refusalOf(self(), `backend.commands.execute(${command.kind})`) ??
      port.execute(command, context),
  };
}

/**
 * The overlay {@link gateBackendUnderConstruction} decorates `base` with:
 * every write and raw member `base` carries, gated on `self()`. Read with
 * `Reflect.get`, so an optional member `base` lacks stays absent.
 */
function readOnlyGateOverlay<T extends object>(
  base: T,
  self: () => object,
): ExactBackendOverlay<T, Partial<T>> {
  const writes = WRITE_MEMBERS.flatMap(
    (member): readonly (readonly [string, unknown])[] => {
      const value: unknown = Reflect.get(base, member);
      if (member === "commands") {
        return isGraphCommandPort(value) ?
            [[member, gateCommandPort(self, value)]]
          : [];
      }
      if (typeof value !== "function") return [];
      const original = value as BackendFunction;
      return [
        [
          member,
          TRANSACTION_OPENERS.has(member) ?
            gateTransactionOpener(self, member, original)
          : gateWriteMember(self, member, original),
        ],
      ];
    },
  );
  const raws = RAW_MEMBERS.flatMap(
    (member): readonly (readonly [string, unknown])[] => {
      const value: unknown = Reflect.get(base, member);
      return typeof value === "function" ?
          [[member, gateRawMember(self, member, value as BackendFunction)]]
        : [];
    },
  );
  // Every key is a member `base` carries (read off it above), and every
  // value has that member's own signature: the original, returning the
  // refusal as a rejection instead of running, or the same command port
  // shape. The cast states that; it widens nothing.
  return Object.fromEntries([...writes, ...raws]) as ExactBackendOverlay<
    T,
    Partial<T>
  >;
}

/**
 * `base`, with every write member refusing inside a read-only scope on the
 * object the factory hands out: the returned one, or `exposed()` when the
 * factory decorates the result further (a caller-serialized queue). For a
 * factory still assembling `base`: it records the native transaction or
 * connection, and registers atomic evidence, on that object
 * (`deriveBackendUnderConstruction`).
 */
export function gateBackendUnderConstruction<T extends object>(
  base: T,
  exposed?: () => object,
): T {
  const holder: { gated: T | undefined } = { gated: undefined };
  const self = (): object => exposed?.() ?? requireDefined(holder.gated);
  holder.gated = deriveBackendUnderConstruction(
    base,
    readOnlyGateOverlay(base, self),
  );
  return holder.gated;
}

/**
 * `members`, an overlay a factory decorates an already-built backend with,
 * with each of its write members refusing inside a read-only scope on
 * `self()` before it runs: for an overlay whose own work comes before the
 * member it wraps (a marker read, say), so that work does not run first.
 * Members it does not classify as writes stay as they are.
 */
export function gateOverlayMembers<T extends object>(
  members: T,
  self: () => object,
): T {
  // The gated entries replace exactly the write and raw members `members`
  // carries, each with that member's own signature.
  return { ...members, ...readOnlyGateOverlay(members, self) };
}
