/**
 * The recorded-capture state a transaction session carries
 * (`TransactionSession.recorded`, `operation-scope.ts`): the binding that
 * decides whether, and how, the writes of the session's operations are
 * recorded.
 *
 * `recorded-capture.ts` sets it when a capture scope or an engine-native
 * mutation witness binds the session, and reads it back, from the operation
 * a reader holds, through its own type predicate: two sessions over one
 * transaction object never share it, and every operation of one session
 * does. The slot is opaque here so the session's type, which the runtime
 * port spells, names none of capture's internals.
 */
export interface RecordedSessionState {
  /**
   * The capture scope or witness bound to the session, as
   * `recorded-capture.ts` built it, or `undefined` when nothing is bound.
   */
  binding: unknown;
}
