import { backendDerivationRoot } from "../backend/derive-backend";

type Checkpoint = () => () => void;
type SavepointEffect = Readonly<{
  publish: () => void;
  discard: (cause: unknown) => void;
}>;
interface SavepointScope {
  restores: (() => void)[];
  pending: SavepointEffect[];
  parent: SavepointScope | undefined;
  rollback: Readonly<{ cause: unknown }> | undefined;
}

const checkpoints = new WeakMap<object, Set<Checkpoint>>();
const scopes = new WeakMap<object, SavepointScope>();

/** Registers transaction-local state that mirrors writes on this session. */
export function registerSavepointState(
  target: object,
  checkpoint: Checkpoint,
): () => void {
  const session = backendDerivationRoot(target);
  let registrations = checkpoints.get(session);
  if (registrations === undefined) {
    registrations = new Set();
    checkpoints.set(session, registrations);
  }
  if (!registrations.has(checkpoint)) {
    registrations.add(checkpoint);
    // A measure created inside a savepoint starts with empty counts, which
    // every enclosing savepoint must also be able to restore.
    for (
      let scope = scopes.get(session);
      scope !== undefined;
      scope = scope.parent
    ) {
      scope.restores.push(checkpoint());
    }
  }
  return () => {
    registrations.delete(checkpoint);
  };
}

/** Successes publish outside savepoints; rollback reports their original cause. */
export function publishSavepointEffect(
  target: object | undefined,
  publish: () => void,
  discard: (cause: unknown) => void,
): void {
  const scope =
    target === undefined ? undefined : (
      scopes.get(backendDerivationRoot(target))
    );
  if (scope !== undefined) {
    scope.pending.push({ publish, discard });
    return;
  }
  publish();
}

/** The one owner of savepoint-local state and success/error hook settlement. */
export async function withSavepointState<T>(
  target: object,
  run: (restore: (cause: unknown) => void) => Promise<T>,
): Promise<T> {
  const session = backendDerivationRoot(target);
  const scope: SavepointScope = {
    restores: [...(checkpoints.get(session) ?? [])].map((checkpoint) =>
      checkpoint(),
    ),
    pending: [],
    parent: scopes.get(session),
    rollback: undefined,
  };
  scopes.set(session, scope);
  let failure: Readonly<{ cause: unknown }> | undefined;
  let result: T;
  try {
    result = await run((cause) => {
      scope.rollback = { cause };
      for (const restore of scope.restores) restore();
    });
  } catch (error) {
    failure = { cause: error };
    throw error;
  } finally {
    if (scope.parent === undefined) scopes.delete(session);
    else scopes.set(session, scope.parent);
    const discarded = scope.rollback ?? failure;
    // Notify only after SQL recovery and after leaving this hook scope, as the
    // enclosing transaction's buffered runner does when its transaction ends.
    if (discarded !== undefined) {
      for (const effect of scope.pending) effect.discard(discarded.cause);
    }
  }
  if (scope.rollback === undefined) {
    for (const effect of scope.pending) {
      publishSavepointEffect(target, effect.publish, effect.discard);
    }
  }
  return result;
}
