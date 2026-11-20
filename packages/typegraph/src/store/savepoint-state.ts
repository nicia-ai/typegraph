import { backendDerivationRoot } from "../backend/derive-backend";
import { runSavepointScope } from "../backend/savepoint-scope-exclusion";

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

/**
 * The one owner of TypeGraph savepoint scopes, their savepoint-local state and
 * success/error hook settlement.
 *
 * The scope is open on its transaction session for its whole duration,
 * settlement included: a savepoint's rollback undoes every statement issued
 * on the session since it was taken, so while the scope is open a statement
 * from outside it — and a second scope beside it — is refused rather than
 * left for the rollback to undo ({@link runSavepointScope}). `operation`
 * names the call holding the scope in that refusal. Because only nested
 * scopes can open while one is open, the scope chain below only ever nests.
 */
export function withSavepointState<T>(
  target: object,
  operation: string,
  run: (restore: (cause: unknown) => void) => Promise<T>,
): Promise<T> {
  return runSavepointScope(target, operation, () =>
    runSavepointStateScope(target, run),
  );
}

async function runSavepointStateScope<T>(
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
