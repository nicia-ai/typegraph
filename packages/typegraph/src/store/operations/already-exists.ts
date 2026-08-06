/**
 * The create API's "this identity is already taken" refusal, and the one
 * translation that turns a driver's duplicate-key report into it.
 *
 * A create learns an id is taken one of two ways: its own existence probe sees
 * the row, or the engine refuses the INSERT. The engine's report used to escape
 * as a `DrizzleQueryError` whose `.message` is the raw SQL text (issue #410), so
 * one condition surfaced as a typed user error down one path and an opaque system
 * error down the other, and a caller could not branch on it at all. Both paths
 * now raise the SAME error, carrying {@link ENTITY_ALREADY_EXISTS_CODE} on its
 * issue.
 *
 * The engine's path is reached two ways, and the second is not a race:
 *
 *  - A NODE create probes first, but the probe and the INSERT are two statements.
 *    PostgreSQL under its default READ COMMITTED does not serialize two write
 *    transactions, so both can probe an absent row and both can then insert it,
 *    and the loser finds out from the INSERT. SQLite cannot reach this shape:
 *    `BEGIN IMMEDIATE` gives the writer slot to one transaction at a time (pinned
 *    by the business-transaction write-lock cases in
 *    `tests/backends/sqlite/sqlite-backend.test.ts`), so the loser's probe runs
 *    after the winner committed and its verdict stands.
 *  - An EDGE create has no existence probe at all — its id is caller-supplied or
 *    freshly generated — so the engine's refusal is the ONLY report on EVERY
 *    backend, race or no race. That is why the classification covers both
 *    dialects and not just PostgreSQL.
 *
 * The backend does the classification (it owns the relation and constraint names
 * the engine reports); this module owns the store-level judgement of what that
 * classification means to a caller.
 */
import { type KindEntity } from "../../core/types";
import {
  DatabaseOperationError,
  ENTITY_ALREADY_EXISTS_CODE,
  ValidationError,
} from "../../errors";

/** An entity the refused statement tried to create. */
type AttemptedCreate = Readonly<{ kind: string; id: string }>;

/** Sentence-initial and mid-sentence names for each entity. */
const ENTITY_LABELS = {
  node: { title: "Node", article: "A node" },
  edge: { title: "Edge", article: "An edge" },
} as const satisfies Record<
  KindEntity,
  Readonly<{ title: string; article: string }>
>;

function alreadyExistsError(
  entity: KindEntity,
  kind: string,
  id: string | undefined,
  detail: string,
  cause: unknown,
): ValidationError {
  const label = ENTITY_LABELS[entity];
  return new ValidationError(
    `${label.title} already exists: ${detail}`,
    {
      entityType: entity,
      kind,
      operation: "create",
      ...(id === undefined ? {} : { id }),
      issues: [
        {
          path: "id",
          code: ENTITY_ALREADY_EXISTS_CODE,
          message: `${label.article} with this ID already exists`,
        },
      ],
    },
    {
      suggestion: `Use a different ID or update the existing ${entity}.`,
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/**
 * The refusal a create raises for a taken id: the probe path's error, and the
 * target of the driver-report translation below.
 */
export function createAlreadyExistsError(
  entity: KindEntity,
  kind: string,
  id: string,
): ValidationError {
  return alreadyExistsError(entity, kind, id, `${kind}/${id}`, undefined);
}

function isDuplicateKeyInsertError(
  error: unknown,
  entity: KindEntity,
): error is DatabaseOperationError {
  return (
    error instanceof DatabaseOperationError &&
    error.details.operation === "insert" &&
    error.details.entity === entity &&
    error.details.reason === "duplicate_key"
  );
}

/**
 * Rethrows a classified duplicate-key insert as {@link createAlreadyExistsError},
 * and anything else untouched.
 *
 * A single insert names the row it lost on exactly. A batch cannot: the engine
 * reports that the chunk collided without saying which row did, and the
 * transaction is already aborted, so there is nothing left to probe. The refusal
 * then names the chunk instead of inventing an attribution — same error type,
 * same issue code, `details.id` simply absent. Every batch here comes from one
 * collection, so the kind is always known.
 */
function rethrowAsAlreadyExists(error: unknown, entity: KindEntity): never {
  if (!isDuplicateKeyInsertError(error, entity)) throw error;
  const attempted: readonly AttemptedCreate[] = error.details.attempted ?? [];
  const first = attempted[0];
  if (first === undefined) throw error;
  if (attempted.length === 1) {
    throw alreadyExistsError(
      entity,
      first.kind,
      first.id,
      `${first.kind}/${first.id}`,
      error,
    );
  }
  throw alreadyExistsError(
    entity,
    first.kind,
    undefined,
    `one of the ${attempted.length} ${first.kind} ids written in this batch`,
    error,
  );
}

/**
 * Runs an insert (or a group of inserts issued as one unit) and converts a
 * duplicate-key refusal into the create API's already-exists error.
 */
export async function withAlreadyExistsTranslation<T>(
  entity: KindEntity,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    rethrowAsAlreadyExists(error, entity);
  }
}
