/**
 * The one savepoint primitive for work TypeGraph recovers inside an open
 * transaction session.
 *
 * TypeGraph isolates a statement that may fail on purpose — a fused write
 * program's deliberate abort, an imported row the database refuses — behind a
 * savepoint, rolls back to it, and reports the typed refusal while the
 * caller's transaction stays usable. The savepoint itself is plain SQL issued
 * through the session's own control channel.
 *
 * Some drivers additionally track the first failed statement of each
 * transaction scope and rethrow it when that scope ends, unless the statement
 * ran inside one of the driver's own savepoint scopes (postgres-js does). A
 * session on such a driver supplies a {@link DriverSavepointScope}; the
 * primitive enters it between its own `SAVEPOINT` and `RELEASE`, so a failure
 * inside the scope is attributed to the nested driver scope and the enclosing
 * one never sees it. The driver scope sits inside TypeGraph's own savepoint,
 * whose release also releases the driver's — a driver that never releases its
 * scopes would otherwise nest every recovered savepoint one level deeper for
 * the rest of the transaction.
 */
import { backendDerivationChain } from "./derive-backend";

/** What a savepoint scope decided once its work ran without throwing. */
export type SavepointDecision<T> =
  | Readonly<{ action: "release"; value: T }>
  | Readonly<{ action: "rollback"; value: T; cause: unknown }>;

/**
 * Runs `scope` inside one of the driver's own savepoint scopes. A throw rolls
 * the driver scope back and propagates; a resolution leaves it to the
 * enclosing TypeGraph savepoint.
 */
export type DriverSavepointScope = <T>(scope: () => Promise<T>) => Promise<T>;

type SessionSavepointPort = Readonly<{
  /** Issues one savepoint control statement on the enclosing session handle. */
  executeControl: (statement: string) => Promise<unknown>;
  enterDriverScope?: DriverSavepointScope | undefined;
}>;

/** The scope failed and rolling its savepoint back failed too. */
export class SavepointRecoveryFailure extends AggregateError {
  constructor(cause: unknown, recoveryError: unknown) {
    super(
      [cause, recoveryError],
      "A TypeGraph savepoint could not be restored after its scope failed.",
      { cause },
    );
    this.name = "SavepointRecoveryFailure";
  }
}

/** Carries a rollback decision out of a driver scope, which rolls back only on a throw. */
class SavepointRollbackDecision<T> extends Error {
  constructor(readonly decision: SavepointDecision<T>) {
    super("TypeGraph savepoint rollback decision");
    this.name = "SavepointRollbackDecision";
  }
}

async function decideInsideDriverScope<T>(
  enterDriverScope: DriverSavepointScope | undefined,
  scope: () => Promise<SavepointDecision<T>>,
): Promise<SavepointDecision<T>> {
  if (enterDriverScope === undefined) return scope();
  try {
    return await enterDriverScope(async () => {
      const decision = await scope();
      if (decision.action === "rollback") {
        throw new SavepointRollbackDecision(decision);
      }
      return decision;
    });
  } catch (error) {
    if (error instanceof SavepointRollbackDecision) {
      return error.decision;
    }
    throw error;
  }
}

/**
 * Runs `scope` inside savepoint `savepoint` on the session behind `port`.
 *
 * A `release` decision releases the savepoint and returns its value. A
 * `rollback` decision, or a throw, rolls back to the savepoint, calls
 * `onRolledBack`, and releases it; the decision's value is returned, the
 * thrown error rethrown. A failed rollback is reported as a
 * {@link SavepointRecoveryFailure}, since the session can no longer be
 * trusted to be at the savepoint's state.
 */
export async function runSessionSavepoint<T>(
  port: SessionSavepointPort,
  savepoint: string,
  scope: () => Promise<SavepointDecision<T>>,
  onRolledBack?: () => void,
): Promise<T> {
  const { executeControl, enterDriverScope } = port;

  async function rollBack(cause: unknown): Promise<void> {
    try {
      await executeControl(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      onRolledBack?.();
      await executeControl(`RELEASE SAVEPOINT ${savepoint}`);
    } catch (recoveryError) {
      throw new SavepointRecoveryFailure(cause, recoveryError);
    }
  }

  await executeControl(`SAVEPOINT ${savepoint}`);
  let decision: SavepointDecision<T>;
  try {
    decision = await decideInsideDriverScope(enterDriverScope, scope);
    if (decision.action === "release") {
      await executeControl(`RELEASE SAVEPOINT ${savepoint}`);
      return decision.value;
    }
  } catch (error) {
    await rollBack(error);
    throw error;
  }
  await rollBack(decision.cause);
  return decision.value;
}

const DRIVER_SAVEPOINT_SCOPES = new WeakMap<object, DriverSavepointScope>();

/**
 * Registers the driver scope of one transaction session's backend. Only a
 * session whose driver attributes failed statements to their own scope
 * registers one.
 */
export function registerDriverSavepointScope(
  backend: object,
  enterDriverScope: DriverSavepointScope,
): void {
  DRIVER_SAVEPOINT_SCOPES.set(backend, enterDriverScope);
}

/**
 * The driver scope of the session `target` executes on. Backends derived from
 * a session's backend issue their statements on that same session, so they
 * resolve its scope along their derivation chain.
 */
export function resolveDriverSavepointScope(
  target: object,
): DriverSavepointScope | undefined {
  for (const link of backendDerivationChain(target)) {
    const enterDriverScope = DRIVER_SAVEPOINT_SCOPES.get(link);
    if (enterDriverScope !== undefined) return enterDriverScope;
  }
  return undefined;
}
