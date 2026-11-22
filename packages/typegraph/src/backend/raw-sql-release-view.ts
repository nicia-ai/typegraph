/**
 * Carries the control-releasing view of a schema-write transaction from the
 * backend that opened the transaction to the code that hands the
 * transaction's `executeSchemaDdl` to someone else.
 *
 * `executeSchemaDdl` forwards whatever SQL text it is given, transaction
 * control included, so handing it to code TypeGraph does not own releases
 * control of the transaction exactly as handing over the native handle does
 * (`native-transaction-release.ts`): the view's `executeSchemaDdl` releases
 * before its statement is sent. A schema preflight and the callback of the
 * public `schemaWriteTransaction` are handed the view; TypeGraph's own
 * schema-write work, which sends only DDL it generated, keeps the transaction
 * backend itself.
 *
 * Registered and resolved by the same adapter (the backend that opens the
 * schema-write transaction and the members that hand it on are built
 * together), so a module-local registry is enough.
 */

const RAW_SQL_RELEASING_VIEWS = new WeakMap<object, object>();

/**
 * Registers `view` as the control-releasing view of exactly `backend`. The
 * view must be derived from `backend` (`deriveBackend`), overriding only the
 * members that forward caller SQL.
 */
export function registerRawSqlReleasingView<T extends object>(
  backend: T,
  view: T,
): void {
  RAW_SQL_RELEASING_VIEWS.set(backend, view);
}

/**
 * The backend to hand to code TypeGraph does not own in place of exactly
 * `target`: its registered control-releasing view, or `target` itself when
 * none was registered (its transaction has no commit evidence to protect).
 * Exact identity, not the derivation chain, so a view registered for an
 * ancestor never replaces a target's own overlays.
 */
export function resolveRawSqlReleasingView<T extends object>(target: T): T {
  // Registered for exactly this backend by the code that built it, as a
  // derivation of it: the same surface.
  return (RAW_SQL_RELEASING_VIEWS.get(target) as T | undefined) ?? target;
}
