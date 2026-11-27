/**
 * The one owner of "which native transaction does this transaction backend
 * run on".
 *
 * THE RULE: state is shared only on proof, and proof is bound to the
 * resource. Two bindings resolve one native transaction only when the engine
 * can show they run on the same one:
 *
 * 1. **Engine savepoint** — a savepoint the engine opened itself on a handle
 *    it could identify is the enclosing transaction
 *    ({@link recordEngineSavepoint}).
 * 2. **Pinned transaction handle** — a driver that runs each transaction on a
 *    per-transaction handle of its own (libSQL's `client.transaction()`
 *    handle, PGlite's transaction client), kept by every Drizzle transaction
 *    object and caller savepoint of that transaction, is identified by that
 *    handle, never by the client it was opened from, and only while the
 *    handle reports its transaction open (a trigger's `RAISE(ROLLBACK)` ends
 *    a libSQL transaction mid-callback; both report a finished one closed).
 * 3. **Transaction object** — a Drizzle transaction object that is one per
 *    BEGIN or savepoint and executes only inside it (PostgreSQL's
 *    node-postgres and postgres-js) is identified by itself. Neither driver
 *    reports the transaction's end on the object, so a handle retained after
 *    its transaction resolves that ended transaction, never another.
 * 4. **Verified connection token** — a handle that is only a connection
 *    (better-sqlite3's database, or a Drizzle transaction object over it,
 *    which runs on whatever transaction the connection has; Durable Object
 *    storage) identifies no transaction. A transaction the engine opens on
 *    such a connection gets a token of its own
 *    ({@link createNativeTransactionToken}); the token is honoured only while
 *    the driver confirms, at the moment of the lookup, that the connection
 *    still has a transaction open AND no later engine transaction has been
 *    published on it. A token that fails either check has ended and is never
 *    honoured again. A driver that cannot report its transaction state
 *    (`@libsql/client` before 0.18, sql.js, Durable Object storage) never has
 *    its token honoured through the connection; only the opener's own bind
 *    records it ({@link recordOpenedNativeTransaction}), and only until its
 *    span ends.
 *
 * Without proof a binding records nothing and the Store gives each of its
 * sessions a state of its own: wrongly sharing is the worse error, wrongly
 * splitting is what every binding had before this record existed.
 *
 * Every bind of a handle also records the driver connection it runs on, where
 * the dialect names one ({@link resolveNativeTransactionConnection}), proof or
 * not. That is never proof of a transaction and never shares state: it is
 * what a fact that must fail closed (a read-only scope TypeGraph opened)
 * consults for a bind nothing proved, because a connection runs one
 * transaction at a time. Only a bind of a handle records it: the engine's own
 * bind of a transaction it opened is proven by its token, and a root backend
 * is not a bind at all, so neither consults the connection.
 *
 * A savepoint a caller opens resolves the enclosing transaction only where
 * proof 2 or 4 covers it (libSQL and PGlite keep the pinned handle;
 * better-sqlite3 inside an engine-opened transaction keeps the connection).
 * node-postgres and postgres-js hand a caller savepoint a new transaction
 * object with no link to the enclosing one, so its sessions share a state of
 * their own.
 *
 * A backend built over a caller's transaction object
 * (`createPostgresTransactionBackend`, or `createSqliteBackend` over a
 * Drizzle transaction object) is recorded when it is built, by the same
 * proofs as a bind: every statement it runs, and every savepoint it opens, is
 * in that object's native transaction, so a Store over it can reach the
 * transaction's state before a write of its own opens a savepoint. Without
 * proof (a better-sqlite3 transaction object outside an engine-opened
 * transaction) nothing is recorded, as for a bind.
 *
 * Residuals, where the driver exposes no signal that would close them:
 *
 * - better-sqlite3 reports THAT a transaction is open, not WHICH. If the
 *   engine's transaction ends implicitly (a trigger's `RAISE(ROLLBACK)`) and
 *   the caller opens another before any lookup or engine publish observes the
 *   end, a lookup inside that one still honours the ended token.
 * - node-postgres keeps the pooled client on a Drizzle transaction object
 *   after its transaction ends and the client returns to the pool. A caller
 *   who keeps using that object past its callback runs statements on
 *   whatever the client does next, a later transaction included, while the
 *   object still resolves the transaction it was opened for.
 *
 * The dialect decides which proof a handle offers (`sqliteNativeHandle`,
 * `postgresNativeHandle`), with the one transaction-object classifier its
 * adoption boundaries use.
 */
import { backendDerivationChain } from "./derive-backend";

/**
 * The connection an engine transaction was opened on, and how the driver
 * confirms, at a lookup, that the connection still has a transaction open.
 * `isTransactionOpen` is `undefined` for a driver that reports no
 * transaction state: its token is then never honoured through the
 * connection.
 */
export type ConnectionTransactionProbe = Readonly<{
  connection: object;
  isTransactionOpen: (() => boolean) | undefined;
}>;

/** A bound backend's native handle, as its dialect classifies its proof. */
export type NativeHandle =
  | Readonly<{
      /**
       * Proof 3: `handle` is one per BEGIN or savepoint. `connection` is
       * the driver connection it runs on (node-postgres' pooled client,
       * which a caller savepoint of it keeps), when the dialect can name it.
       */
      kind: "transaction";
      handle: object;
      connection?: object | undefined;
    }>
  | Readonly<{
      /**
       * Proof 2: `handle` runs on the per-transaction driver handle
       * `pinned`, whose transaction is open while `isOpen()` says so.
       */
      kind: "pinned";
      handle: object;
      pinned: object;
      isOpen: () => boolean;
    }>
  | Readonly<{
      /** Proof 4 or none: `handle` runs on whatever `connection` has open. */
      kind: "connection";
      handle: object;
      connection: object;
    }>;

/** Bound transaction backend → the native transaction (or token) it runs on. */
const BOUND_NATIVE_TRANSACTIONS = new WeakMap<object, object>();

/** Savepoint handle the engine opened → the native transaction it is in. */
const ENGINE_SAVEPOINTS = new WeakMap<object, object>();

/**
 * Every engine token → the probe that verifies it, or `undefined` when the
 * driver has none. Membership is what makes an identity a token.
 */
const TOKEN_PROBES = new WeakMap<
  object,
  ConnectionTransactionProbe | undefined
>();

/** Pinned driver handle → whether its transaction is still open. */
const PINNED_PROBES = new WeakMap<object, () => boolean>();

/** Identities (tokens, pinned handles) whose transaction is known to have ended. */
const ENDED_TOKENS = new WeakSet<object>();

/** Connection → the token of the engine transaction last published on it. */
const PUBLISHED_TOKENS = new WeakMap<object, object>();

/**
 * Bound backend → the driver connection it runs on. Never proof of a
 * transaction: read only by {@link resolveNativeTransactionConnection}.
 */
const BOUND_CONNECTIONS = new WeakMap<object, object>();

/** One read-only scope held on a connection: the graph whose transaction opened it. */
type ConnectionReadOnlyScope = Readonly<{ graphId: string }>;

/**
 * Driver connection → each read-only scope the Store has open on a
 * transaction running on it, innermost last ({@link holdConnectionReadOnlyScope}).
 */
const READ_ONLY_CONNECTIONS = new WeakMap<
  object,
  readonly ConnectionReadOnlyScope[]
>();

/**
 * Whether `token` still identifies the transaction open on its connection:
 * not ended, and, where the driver can be asked, still the connection's
 * published transaction with a transaction open. Marks it ended otherwise.
 */
function isTokenLive(token: object): boolean {
  if (ENDED_TOKENS.has(token)) return false;
  const probe = TOKEN_PROBES.get(token);
  if (probe?.isTransactionOpen === undefined) return true;
  if (
    PUBLISHED_TOKENS.get(probe.connection) === token &&
    probe.isTransactionOpen()
  ) {
    return true;
  }
  ENDED_TOKENS.add(token);
  if (PUBLISHED_TOKENS.get(probe.connection) === token) {
    PUBLISHED_TOKENS.delete(probe.connection);
  }
  return false;
}

/**
 * The identity `identity` stands for now: a token or a pinned handle only
 * while its transaction is open, and never again once it was seen ended.
 */
function liveIdentity(identity: object): object | undefined {
  if (TOKEN_PROBES.has(identity)) {
    return isTokenLive(identity) ? identity : undefined;
  }
  if (ENDED_TOKENS.has(identity)) return undefined;
  const isOpen = PINNED_PROBES.get(identity);
  if (isOpen !== undefined && !isOpen()) {
    ENDED_TOKENS.add(identity);
    return undefined;
  }
  return identity;
}

/**
 * The native transaction `handle` runs in now, by the proof its kind offers,
 * or `undefined` without proof.
 */
export function identifyNativeTransaction(
  handle: NativeHandle,
): object | undefined {
  // Proof 1: a savepoint the engine opened.
  const enclosing = ENGINE_SAVEPOINTS.get(handle.handle);
  if (enclosing !== undefined) return liveIdentity(enclosing);
  switch (handle.kind) {
    case "pinned": {
      // Proof 2: the driver's per-transaction handle, whatever connection
      // or client the transaction object also names, while it is open.
      PINNED_PROBES.set(handle.pinned, handle.isOpen);
      return liveIdentity(handle.pinned);
    }
    case "transaction": {
      // Proof 3: the per-BEGIN transaction object itself.
      return handle.handle;
    }
    case "connection": {
      // Proof 4: the token the engine published on the connection, only
      // while the driver confirms it is still the open transaction.
      const published = PUBLISHED_TOKENS.get(handle.connection);
      return published !== undefined && isTokenLive(published) ?
          published
        : undefined;
    }
  }
}

/**
 * Records, once per bind, the native transaction `backend` runs on (see
 * {@link identifyNativeTransaction}), and the driver connection the handle
 * names, where it names one. Records no transaction without proof.
 */
export function recordNativeTransactionHandle(
  backend: object,
  handle: NativeHandle,
): void {
  const nativeTransaction = identifyNativeTransaction(handle);
  if (nativeTransaction !== undefined) {
    BOUND_NATIVE_TRANSACTIONS.set(backend, nativeTransaction);
  }
  const connection = handle.kind === "pinned" ? undefined : handle.connection;
  if (connection !== undefined) BOUND_CONNECTIONS.set(backend, connection);
}

/**
 * Records that every statement of `backend` runs in the engine transaction
 * `token` identifies: the opener's own bind, or a backend built over the
 * connection while `token` is published on it (proof 4,
 * {@link identifyNativeTransaction}). Resolves only while the token is live.
 * The token is the proof, and neither is a bind of a handle, so no connection
 * is recorded ({@link engineTransactionConnection} names the token's).
 */
export function recordOpenedNativeTransaction(
  backend: object,
  token: object,
): void {
  BOUND_NATIVE_TRANSACTIONS.set(backend, token);
}

/**
 * Records that the engine opened the savepoint `savepoint` on `enclosing`, so
 * a bind on the savepoint's handle records the native transaction
 * `enclosing` runs in. Call it as Drizzle hands the engine the savepoint's
 * handle, before anything is bound on it.
 */
export function recordEngineSavepoint(
  savepoint: object,
  enclosing: NativeHandle,
): void {
  const nativeTransaction = identifyNativeTransaction(enclosing);
  if (nativeTransaction !== undefined) {
    ENGINE_SAVEPOINTS.set(savepoint, nativeTransaction);
  }
}

/**
 * A new identity for one transaction the engine is about to open on a
 * connection-level handle. `probe` names the connection and how the driver
 * confirms the transaction is still open; a token whose probe cannot confirm
 * it is never honoured through the connection.
 */
export function createNativeTransactionToken(
  probe: ConnectionTransactionProbe | undefined,
): object {
  const token = Object.freeze({});
  TOKEN_PROBES.set(token, probe);
  return token;
}

/**
 * Whether `nativeTransaction` (an identity
 * {@link resolveNativeTransactionHandle} returned) is a token the engine
 * minted for a transaction it opened ({@link createNativeTransactionToken}):
 * every session that resolves it is proven to run in that transaction.
 */
export function isEngineTransactionToken(nativeTransaction: object): boolean {
  return TOKEN_PROBES.has(nativeTransaction);
}

/**
 * The driver connection the engine opened the transaction `token` identifies
 * on, or `undefined` when its probe names none.
 */
export function engineTransactionConnection(token: object): object | undefined {
  return TOKEN_PROBES.get(token)?.connection;
}
/**
 * Runs `run` with `token` published on its connection. Call it once the
 * transaction `token` identifies has begun, around the work that runs inside
 * it AND the COMMIT or ROLLBACK that ends it.
 *
 * The connection's BEGIN succeeding proves that any transaction published on
 * it before has ended (a SQLite connection runs one transaction at a time),
 * so publishing ends it. When `run` settles the token has ended too.
 */
export async function publishConnectionNativeTransaction<T>(
  token: object,
  run: () => Promise<T>,
): Promise<T> {
  const probe = TOKEN_PROBES.get(token);
  // Only a driver that can confirm the transaction publishes it as proof.
  const published = probe?.isTransactionOpen === undefined ? undefined : probe;
  if (published !== undefined) {
    PUBLISHED_TOKENS.set(published.connection, token);
  }
  try {
    return await run();
  } finally {
    ENDED_TOKENS.add(token);
    if (
      published !== undefined &&
      PUBLISHED_TOKENS.get(published.connection) === token
    ) {
      PUBLISHED_TOKENS.delete(published.connection);
    }
  }
}

/**
 * The native transaction `backend` runs on: the record of the nearest link of
 * its derivation chain that has one, or `undefined` when no link does or the
 * nearest record is a token that is no longer live.
 */
export function resolveNativeTransactionHandle(
  backend: object,
): object | undefined {
  for (const link of backendDerivationChain(backend)) {
    const nativeTransaction = BOUND_NATIVE_TRANSACTIONS.get(link);
    if (nativeTransaction !== undefined) return liveIdentity(nativeTransaction);
  }
  return undefined;
}

/**
 * The driver connection the bind `backend` runs on, as the nearest link of
 * its derivation chain that has one recorded: the connection-level handle's
 * connection (better-sqlite3's database, `@libsql/client` before 0.18,
 * sql.js, Durable Object storage) or the pooled client a node-postgres
 * transaction object runs on. `undefined` where the dialect names none (a
 * per-transaction pinned handle), and for anything that is not a bind of a
 * handle (a root backend, the engine's own bind of a transaction it opened).
 *
 * This is never proof of which transaction `backend` runs in, so no state
 * is shared through it. A connection runs one transaction at a time, so it is
 * what a fact that must fail closed consults: a read-only scope TypeGraph has
 * open on a transaction running on this connection.
 */
export function resolveNativeTransactionConnection(
  backend: object,
): object | undefined {
  for (const link of backendDerivationChain(backend)) {
    const connection = BOUND_CONNECTIONS.get(link);
    if (connection !== undefined) return connection;
  }
  return undefined;
}

/**
 * Holds a read-only scope the Store opened for the graph `graphId` on
 * `connection` until the returned release is called. The Store holds one for
 * as long as a read-only scope it opened on a transaction running on that
 * connection is open: a connection runs one transaction at a time, so
 * meanwhile every statement a bind nothing proved issues on it runs in that
 * transaction ({@link connectionReadOnlyScopeGraph}).
 */
export function holdConnectionReadOnlyScope(
  connection: object,
  graphId: string,
): () => void {
  const scope: ConnectionReadOnlyScope = { graphId };
  const held = READ_ONLY_CONNECTIONS.get(connection) ?? [];
  READ_ONLY_CONNECTIONS.set(connection, [...held, scope]);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = READ_ONLY_CONNECTIONS.get(connection) ?? [];
    const index = current.lastIndexOf(scope);
    if (index !== -1) {
      READ_ONLY_CONNECTIONS.set(connection, current.toSpliced(index, 1));
    }
  };
}

/**
 * THE connection half of the read-only question: the graph of the innermost
 * read-only scope held on `connection`, or `undefined` when there is none.
 * Asked only for a bind of a handle that nothing proved to run in a given
 * transaction: on that connection it runs in whichever transaction is open.
 */
export function connectionReadOnlyScopeGraph(
  connection: object,
): string | undefined {
  return READ_ONLY_CONNECTIONS.get(connection)?.at(-1)?.graphId;
}
