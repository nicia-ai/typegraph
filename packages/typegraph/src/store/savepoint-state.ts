import { backendDerivationRoot } from "../backend/derive-backend";

type Checkpoint = () => () => void;
const checkpoints = new WeakMap<object, Set<Checkpoint>>();
const effects = new WeakMap<object, (() => void)[]>();

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
  registrations.add(checkpoint);
  return () => {
    registrations.delete(checkpoint);
  };
}

/** Success hooks remain immediate outside TypeGraph-owned savepoints. */
export function publishSavepointEffect(
  target: object | undefined,
  effect: () => void,
): void {
  const pending =
    target === undefined ? undefined : (
      effects.get(backendDerivationRoot(target))
    );
  if (pending !== undefined) {
    pending.push(effect);
    return;
  }
  effect();
}

/** Keeps nested savepoints' session state and success hooks aligned with SQL. */
export async function withSavepointState<T>(
  target: object,
  run: (restore: () => void) => Promise<T>,
): Promise<T> {
  const session = backendDerivationRoot(target);
  const restore = [...(checkpoints.get(session) ?? [])].map((checkpoint) =>
    checkpoint(),
  );
  const previous = effects.get(session);
  const pending: (() => void)[] = [];
  effects.set(session, pending);
  const state = { rolledBack: false };
  let result: T;
  try {
    result = await run(() => {
      state.rolledBack = true;
      for (const reset of restore) reset();
    });
  } finally {
    if (previous === undefined) effects.delete(session);
    else effects.set(session, previous);
  }
  if (!state.rolledBack) {
    for (const effect of pending) publishSavepointEffect(target, effect);
  }
  return result;
}
