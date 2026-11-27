/**
 * THE one owner of "set a PostgreSQL transaction-local setting for the
 * duration of one TypeGraph unit".
 *
 * `set_config(name, value, is_local => true)` (`SET LOCAL`) lasts until the
 * end of the transaction it runs in. That ends the setting only when the
 * transaction is TypeGraph's own: a backend built over a caller's transaction
 * opens savepoints, and `RELEASE SAVEPOINT` keeps every setting changed under
 * it, so without a restore the caller's transaction carries TypeGraph's value
 * into every statement it runs after TypeGraph returns.
 *
 * Every site that changes such a setting goes through
 * {@link withTransactionLocalSettings}, with the scope its unit needs:
 *
 * - `"transaction"`: the unit is a transaction TypeGraph opened and will end.
 *   Its COMMIT or ROLLBACK ends the setting, so the owner issues the setting
 *   statement and nothing else.
 * - `"unit"`: the setting must end with the unit, because the transaction
 *   belongs to a caller or outlives the unit. The first change of each
 *   setting reads its prior value IN the statement that sets it, on the same
 *   session, and the unit's success restores it before control returns.
 *
 * A failed unit is restored only when it failed by a refusal the unit minted
 * through {@link TransactionLocalSettingScope.refusal}: one thrown between
 * statements, with none in flight and the transaction not aborted. Any other
 * failure issues nothing more. An engine error has aborted the transaction,
 * and a driver-side failure (a client query timeout) can leave a statement
 * still running on the session, so a restore there would fail or overlap it.
 * Either way the transaction can continue only through a rollback, and a
 * rollback reverts the setting: the `ROLLBACK TO SAVEPOINT` a TypeGraph unit
 * on a caller's transaction runs inside, or the caller's own rollback.
 *
 * {@link settingScopeOfTransaction} is the one answer to which scope a
 * transaction backend's unit needs, from evidence the PostgreSQL backend
 * records on the transaction backend it binds to a transaction it opened
 * itself ({@link recordTypeGraphOwnedTransaction}). A transaction backend
 * without that evidence — a savepoint of a caller's transaction, an adopted
 * transaction, a custom backend, a wrapper not derived through
 * `deriveBackend` — takes `"unit"`, which is correct on any transaction and
 * only costs the restore.
 *
 * Transaction-local settings are a PostgreSQL facility; the dialect decides
 * whether an option produces one (`DialectAdapter.transactionWorkingMemory`),
 * and only a PostgreSQL session ever reaches this module.
 */
import { CompilerInvariantError } from "../errors";
import { sql, type SqlFragment } from "../query/sql-fragment";
import { backendDerivationChain } from "./derive-backend";

/**
 * One transaction-local setting.
 *
 * `value` is either the literal value or an expression of the setting's
 * prior value (`search_path` extended at its front, say), which the owner
 * passes as the SQL expression that reads it.
 *
 * `emptyMeansUnset` is for a parameter an extension defines when its library
 * loads (pgvector's `hnsw.*`, `ivfflat.*`). Before that, a `SET LOCAL` that
 * rolled back leaves a placeholder that reads as the empty string, which the
 * library then rejects as a value. When the parameter never reads as empty
 * once defined, an empty prior is that placeholder and is restored as unset
 * (reset to the default) rather than assigned.
 */
export type TransactionLocalSetting = Readonly<{
  name: string;
  value: string | ((previous: SqlFragment) => SqlFragment);
  emptyMeansUnset?: boolean;
}>;

/** How long a setting changed in a unit lasts; see the module comment. */
export type TransactionLocalSettingLifetime = "transaction" | "unit";

/** The session a unit's settings are changed on: its pinned connection. */
export type TransactionLocalSettingSession = Readonly<{
  execute: <Row>(query: SqlFragment) => Promise<readonly Row[]>;
}>;

/** A prior value the unit already read on the same session. */
export type ObservedTransactionLocalSetting = Readonly<{
  name: string;
  previous: string;
}>;

export type TransactionLocalSettingScope = Readonly<{
  /**
   * Changes a setting for the rest of the unit. A later change of the same
   * setting in the unit keeps the prior value the first one read.
   */
  set: (setting: TransactionLocalSetting) => Promise<void>;
  /**
   * Marks `error` as a refusal the unit raises between statements, on a
   * transaction that is not aborted, and returns it to be thrown. Only such a
   * failure takes the restore.
   */
  refusal: <E extends object>(error: E) => E;
}>;

const TYPEGRAPH_OWNED_TRANSACTIONS = new WeakSet<object>();

/**
 * Records that `transactionBackend` is bound to a transaction its backend
 * opened itself with `BEGIN` and will end with `COMMIT` or `ROLLBACK`. Call it
 * only where that is structurally true, before the backend is handed out.
 */
export function recordTypeGraphOwnedTransaction(
  transactionBackend: object,
): void {
  TYPEGRAPH_OWNED_TRANSACTIONS.add(transactionBackend);
}

/**
 * The lifetime a setting changed through `transactionBackend` needs: the
 * transaction's own when TypeGraph opened that transaction (on the nearest
 * link of its derivation chain), else the unit's.
 */
export function settingScopeOfTransaction(
  transactionBackend: object,
): TransactionLocalSettingLifetime {
  return (
      backendDerivationChain(transactionBackend).some((link) =>
        TYPEGRAPH_OWNED_TRANSACTIONS.has(link),
      )
    ) ?
      "transaction"
    : "unit";
}

type PriorSetting = Readonly<{ name: string; previous: string | undefined }>;

function settingValue(
  setting: TransactionLocalSetting,
  previous: SqlFragment,
): SqlFragment {
  return typeof setting.value === "string" ?
      sql`${setting.value}`
    : setting.value(previous);
}

/** The setting statement that reads nothing. */
function applyStatement(setting: TransactionLocalSetting): SqlFragment {
  return sql`SELECT set_config(${setting.name}, ${settingValue(
    setting,
    sql`current_setting(${setting.name})`,
  )}, true)`;
}

/**
 * The setting statement that returns the prior value it replaced. The
 * materialized CTE is evaluated before the outer target list, so the read
 * cannot observe the new value, whatever order the planner gives the outer
 * expressions. `missing_ok`: an extension parameter whose library has not
 * loaded on the session reads as NULL instead of raising 42704.
 */
function applyReadingPriorStatement(
  setting: TransactionLocalSetting,
): SqlFragment {
  return sql`WITH prior AS MATERIALIZED (SELECT current_setting(${setting.name}, true) AS previous) SELECT prior.previous, set_config(${setting.name}, ${settingValue(
    setting,
    sql`prior.previous`,
  )}, true) AS applied FROM prior`;
}

/**
 * One statement restoring every prior value. An undefined prior is passed as
 * NULL, which resets the parameter to its default.
 */
function restoreStatement(priors: readonly PriorSetting[]): SqlFragment {
  return sql`SELECT ${sql.join(
    priors.map((prior) =>
      prior.previous === undefined ?
        sql`set_config(${prior.name}, NULL, true)`
      : sql`set_config(${prior.name}, ${prior.previous}, true)`,
    ),
    sql`, `,
  )}`;
}

function priorValue(
  setting: TransactionLocalSetting,
  read: unknown,
): string | undefined {
  if (typeof read !== "string") return undefined;
  return setting.emptyMeansUnset === true && read === "" ? undefined : read;
}

/**
 * Runs `run` with the settings it changes through its scope lasting exactly
 * `lifetime`. `observed` carries prior values the unit already read on the
 * same session (folded into an earlier statement of its own), which are then
 * not read again.
 */
export async function withTransactionLocalSettings<T>(
  session: TransactionLocalSettingSession,
  lifetime: TransactionLocalSettingLifetime,
  run: (scope: TransactionLocalSettingScope) => Promise<T>,
  observed: readonly ObservedTransactionLocalSetting[] = [],
): Promise<T> {
  const priors = new Map<string, PriorSetting>();
  const observedPriors = new Map(
    observed.map((setting) => [setting.name, setting.previous]),
  );
  const refusals = new WeakSet<object>();

  const scope: TransactionLocalSettingScope = {
    async set(setting) {
      if (lifetime === "transaction" || priors.has(setting.name)) {
        await session.execute(applyStatement(setting));
        return;
      }
      if (observedPriors.has(setting.name)) {
        priors.set(setting.name, {
          name: setting.name,
          previous: observedPriors.get(setting.name),
        });
        await session.execute(applyStatement(setting));
        return;
      }
      const [row] = await session.execute<{ previous: unknown }>(
        applyReadingPriorStatement(setting),
      );
      if (row === undefined) {
        throw new CompilerInvariantError(
          `Changing the transaction-local setting ${setting.name} returned no row.`,
        );
      }
      priors.set(setting.name, {
        name: setting.name,
        previous: priorValue(setting, row.previous),
      });
    },
    refusal(error) {
      refusals.add(error);
      return error;
    },
  };

  const restore = async (): Promise<void> => {
    if (priors.size === 0) return;
    await session.execute(restoreStatement([...priors.values()]));
  };

  const result = await run(scope).catch(async (error: unknown) => {
    if (typeof error === "object" && error !== null && refusals.has(error)) {
      try {
        await restore();
      } catch {
        /* The refusal stays the error reported. */
      }
    }
    throw error;
  });
  await restore();
  return result;
}
