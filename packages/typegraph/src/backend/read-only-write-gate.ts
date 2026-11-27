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
 * over every backend member name, read once per member a caller reads. The
 * bundled factories apply the gate at construction
 * ({@link gateBackendUnderConstruction}), through `derive-backend.ts`, never
 * by copying, as a view of the members the backend object is read for: a
 * transaction backend pays for the members its transaction uses, not for
 * every member it carries; an atomic mutation program, which
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
  isGraphCommandPort,
} from "./derive-backend";
import { backendMemberAccess } from "./member-access";
import type { GraphCommandPort } from "./types";

const READ_ONLY_SUGGESTION =
  'This backend runs inside a transaction TypeGraph opened with accessMode: "read_only". Run the write outside that transaction, or open it without accessMode: "read_only".';

/**
 * Refuses `operation` with the typed read-only refusal when `backend` runs
 * inside a read-only scope TypeGraph opened (`backendReadOnlyScopeGraph`),
 * naming the graph whose transaction opened it. `member` is the backend
 * member whose work is about to be admitted, where one is: on a root backend
 * over one connection, whether it is admitted behind the transaction or
 * inside it depends on the member.
 */
export function assertBackendWritable(
  backend: object,
  operation: string,
  member?: string,
): void {
  const graphId = backendReadOnlyScopeGraph(backend, member);
  if (graphId === undefined) return;
  refuseReadOnlyTransactionWrite(operation, graphId, READ_ONLY_SUGGESTION);
}

/** The refusal {@link assertBackendWritable} raises, as a rejection. */
function refusalOf(
  backend: object,
  member: string,
  operation = `backend.${member}()`,
): Promise<never> | undefined {
  try {
    assertBackendWritable(backend, operation, member);
    return undefined;
  } catch (error) {
    return Promise.reject(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}

type BackendFunction = (...args: readonly unknown[]) => unknown;

/** The transaction openers: their second argument is the transaction's options. */
const TRANSACTION_OPENERS: ReadonlySet<string> = new Set([
  "transaction",
  "transactionWithNative",
]);

function gateWriteMember(
  self: () => object,
  member: string,
  original: BackendFunction,
): BackendFunction {
  return (...args) => refusalOf(self(), member) ?? original(...args);
}

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
      : refusalOf(self(), member);
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
      hasWriteIntent(statement) ? refusalOf(self(), member) : undefined;
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
      refusalOf(
        self(),
        "commands",
        `backend.commands.execute(${command.kind})`,
      ) ?? port.execute(command, context),
  };
}

/**
 * `value`, the member `member` of a backend object, as the gate presents
 * it: a write or raw member refusing inside a read-only scope on `self()`,
 * a command port refusing every command there, anything else as it is.
 * The one place a member is decorated by its classification.
 */
function gatedMember(
  self: () => object,
  member: string,
  value: unknown,
): unknown {
  const access = backendMemberAccess(member);
  if (access === undefined || access === "read") return value;
  if (member === "commands") {
    return isGraphCommandPort(value) ? gateCommandPort(self, value) : value;
  }
  if (typeof value !== "function") return value;
  const original = value as BackendFunction;
  if (access === "raw") return gateRawMember(self, member, original);
  return TRANSACTION_OPENERS.has(member) ?
      gateTransactionOpener(self, member, original)
    : gateWriteMember(self, member, original);
}

/**
 * `base`, with every write member refusing inside a read-only scope on the
 * object the factory hands out: the returned one, or `exposed()` when the
 * factory decorates the result further (a caller-serialized queue). For a
 * factory still assembling `base`: it records the native transaction or
 * connection, and registers atomic evidence, on that object
 * (`deriveBackendUnderConstruction`). Each member is gated when it is first
 * read, so building the gate costs the same whatever `base` carries.
 */
export function gateBackendUnderConstruction<T extends object>(
  base: T,
  exposed?: () => object,
): T {
  const holder: { gated: T | undefined } = { gated: undefined };
  const self = (): object => exposed?.() ?? requireDefined(holder.gated);
  holder.gated = deriveBackendUnderConstruction(base, {}, (member, value) =>
    gatedMember(self, member, value),
  );
  return holder.gated;
}
