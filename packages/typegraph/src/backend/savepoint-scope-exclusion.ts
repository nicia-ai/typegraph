/**
 * The one owner of the rule that keeps a TypeGraph savepoint's rollback from
 * reaching work that is not part of the scope that took it.
 *
 * Rolling back to a savepoint undoes every statement issued on its session
 * since the savepoint was taken, whoever issued it. Calls made inside one
 * `store.transaction()` callback may overlap (`Promise.all`), so a call that
 * rolled its savepoint back after a caught failure would also undo an
 * overlapping sibling's completed, successfully reported writes, and a
 * sibling that read rows the scope later rolled back would have decided from
 * state that never commits. While a scope is open on a session, therefore,
 * every statement TypeGraph would issue on that session from outside the
 * scope is refused with a {@link SavepointScopeConflictError} before it is
 * sent, and so is opening a second scope beside it. Nothing waits: refusing
 * leaves the database transaction untouched and usable.
 *
 * Where the rule is enforced: {@link admitSessionStatement} is called by the
 * execution adapter each dialect binds to a native transaction
 * (`drizzle/execution/session-statement-guard.ts`), the one path every
 * statement a transaction-scoped first-party backend issues goes through —
 * reads, writes, fences, savepoint control and atomic programs alike — at
 * the moment the statement would be sent. A fluent query is therefore
 * judged when it executes, not when it was built. {@link runSavepointScope}
 * opens a scope; it is called only by `withSavepointState`, the one owner of
 * TypeGraph savepoint scopes.
 *
 * "Inside the scope" is read from the async call graph through
 * `AsyncLocalStorage` ({@link createAsyncContextLoader}): work started from
 * inside a scope, however deep, is part of it, and a scope opened from inside
 * a scope nests. Only a scope that is still open counts: a continuation
 * scheduled inside a scope that runs after the scope closed is outside every
 * scope opened since. On a runtime without `AsyncLocalStorage` no scope is
 * ever recorded, so nothing is refused.
 *
 * The session is the native transaction a dialect bound the backend to
 * ({@link registerTransactionSession}). Two bindings of one native
 * transaction — the context `store.transaction()` hands its callback and
 * `store.withTransaction(tx.sql)` adopting that same handle — share one
 * session, as does every decoration of either, found through the backend's
 * derivation chain. A backend no dialect registered (a custom backend) has no
 * statement seam TypeGraph owns, so its scopes are not recorded and nothing
 * is refused on it. Statements a caller issues on the native handle itself
 * (raw `tx.sql`) never pass through TypeGraph and cannot be refused.
 */
import { SavepointScopeConflictError } from "../errors";
import { createAsyncContextLoader } from "./async-context";
import { backendDerivationChain } from "./derive-backend";

/** One open savepoint scope, and the scope it was opened inside. */
type SavepointScopeFrame = Readonly<{
  /** The operation that opened the scope, as error messages name it. */
  operation: string;
  parent: SavepointScopeFrame | undefined;
}>;

/** The innermost scope, per session, the current async execution runs in. */
type EnclosingScopes = ReadonlyMap<object, SavepointScopeFrame>;

const enclosingScopesLoader = createAsyncContextLoader<EnclosingScopes>();

/** The native transaction each dialect-bound transaction backend runs on. */
const transactionSessions = new WeakMap<object, object>();

/** The scopes open right now on each session. */
const openScopes = new WeakMap<object, Set<SavepointScopeFrame>>();

/**
 * Records that `backend` issues its statements on the native transaction
 * `session`. Called by a dialect where it binds a transaction backend to its
 * driver's transaction handle, with the same `session` its statement guard
 * is keyed to.
 */
export function registerTransactionSession(
  backend: object,
  session: object,
): void {
  transactionSessions.set(backend, session);
}

/** The native transaction `target` executes on, when a dialect bound it. */
function transactionSessionOf(target: object): object | undefined {
  for (const link of backendDerivationChain(target)) {
    const session = transactionSessions.get(link);
    if (session !== undefined) return session;
  }
  return undefined;
}

/**
 * An open scope on `session` that the current execution is not inside, if
 * any. Scopes enclosing the current execution — open or not — are found by
 * walking from its innermost scope outward; an open scope missing from that
 * walk belongs to some other call.
 */
function foreignOpenScope(
  session: object,
  enclosing: EnclosingScopes | undefined,
): SavepointScopeFrame | undefined {
  const open = openScopes.get(session);
  if (open === undefined || open.size === 0) return undefined;
  const ancestry = new Set<SavepointScopeFrame>();
  for (
    let frame = enclosing?.get(session);
    frame !== undefined;
    frame = frame.parent
  ) {
    ancestry.add(frame);
  }
  for (const frame of open) {
    if (!ancestry.has(frame)) return frame;
  }
  return undefined;
}

/**
 * Refuses a statement about to be sent on the native transaction `session`
 * when another call's savepoint scope is open there. `describe` names the
 * statement for the error and is called only on refusal.
 */
export function admitSessionStatement(
  session: object,
  describe: () => string,
): void {
  const open = openScopes.get(session);
  if (open === undefined || open.size === 0) return;
  const holder = foreignOpenScope(
    session,
    enclosingScopesLoader.current()?.getStore(),
  );
  if (holder === undefined) return;
  throw new SavepointScopeConflictError({
    refused: describe(),
    holder: holder.operation,
  });
}

/**
 * Runs `scope` as an open savepoint scope of `operation` on the session
 * `target` executes on. Refuses to open it beside another call's open scope
 * on that session; a scope opened from inside an open scope nests.
 */
export async function runSavepointScope<T>(
  target: object,
  operation: string,
  scope: () => Promise<T>,
): Promise<T> {
  const session = transactionSessionOf(target);
  if (session === undefined) return scope();
  if (enclosingScopesLoader.current() === undefined) {
    await enclosingScopesLoader.ready();
  }
  const context = enclosingScopesLoader.current();
  if (context === undefined) return scope();

  // The check and the registration below are one synchronous step, so no
  // other scope can open between them.
  const enclosing = context.getStore();
  const holder = foreignOpenScope(session, enclosing);
  if (holder !== undefined) {
    throw new SavepointScopeConflictError({
      refused: `Opening a savepoint for ${operation}`,
      holder: holder.operation,
    });
  }
  const frame: SavepointScopeFrame = {
    operation,
    parent: enclosing?.get(session),
  };
  let open = openScopes.get(session);
  if (open === undefined) {
    open = new Set();
    openScopes.set(session, open);
  }
  open.add(frame);
  const inside = new Map(enclosing);
  inside.set(session, frame);
  try {
    return await context.run(inside, scope);
  } finally {
    open.delete(frame);
  }
}
