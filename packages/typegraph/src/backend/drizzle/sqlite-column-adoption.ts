import { isSqliteDuplicateColumnError } from "../../utils/sql-errors";

export type SqliteColumnRow = Readonly<{ name?: unknown }>;
export type SqliteColumnAdoptionPlan = Readonly<{
  addedColumns: readonly string[];
  statements: (columns: ReadonlySet<string>) => readonly string[];
}>;
type AdoptionStep = Readonly<
  { kind: "inspect" } | { kind: "execute"; statement: string }
>;
type AdoptionOutcome = Readonly<
  | { ok: true; rows?: readonly SqliteColumnRow[] }
  | { ok: false; error: unknown }
>;

/** One inventory, normalization, and bounded race-recovery policy for all SQLite adopters. */
function* adoptionSteps(
  plan: SqliteColumnAdoptionPlan,
): Generator<AdoptionStep, void, AdoptionOutcome> {
  // Each added column can lose one race; allow a fresh inventory after each loss.
  attempts: for (let attempt = 0; ; attempt += 1) {
    const inventory = yield { kind: "inspect" };
    if (!inventory.ok) throw inventory.error;
    const columns = new Set(
      (inventory.rows ?? []).flatMap((row) =>
        typeof row.name === "string" ? [row.name] : [],
      ),
    );
    for (const statement of plan.statements(columns)) {
      const result = yield { kind: "execute", statement };
      if (result.ok) continue;
      if (
        attempt < plan.addedColumns.length &&
        plan.addedColumns.some((column) =>
          isSqliteDuplicateColumnError(result.error, column),
        )
      )
        continue attempts;
      throw result.error;
    }
    return;
  }
}

export type SyncSqliteColumnDriver = Readonly<{
  readColumns: () => readonly SqliteColumnRow[];
  execute: (statement: string) => void;
}>;
export type AsyncSqliteColumnDriver = Readonly<{
  readColumns: () => Promise<readonly SqliteColumnRow[]>;
  execute: (statement: string) => Promise<void>;
}>;

function failedStep(error: unknown): AdoptionOutcome {
  return { ok: false, error };
}

function executeStep(
  step: AdoptionStep,
  driver: SyncSqliteColumnDriver,
): AdoptionOutcome;
function executeStep(
  step: AdoptionStep,
  driver: AsyncSqliteColumnDriver,
): AdoptionOutcome | Promise<AdoptionOutcome>;
function executeStep(
  step: AdoptionStep,
  driver: SyncSqliteColumnDriver | AsyncSqliteColumnDriver,
): AdoptionOutcome | Promise<AdoptionOutcome> {
  try {
    if (step.kind === "inspect") {
      const rows = driver.readColumns();
      if ("then" in rows)
        return rows.then(
          (entries): AdoptionOutcome => ({ ok: true, rows: entries }),
          (error: unknown) => failedStep(error),
        );
      return { ok: true, rows };
    }
    // A callback typed void may return a native statement result. Only a
    // promise represents pending execution; synchronous return values are ignored.
    const result: unknown = driver.execute(step.statement);
    if (
      typeof result === "object" &&
      result !== null &&
      "then" in result &&
      typeof result.then === "function"
    )
      return Promise.resolve(result).then(
        (): AdoptionOutcome => ({ ok: true }),
        (error: unknown) => failedStep(error),
      );
    return { ok: true };
  } catch (error) {
    return failedStep(error);
  }
}

export function adoptSqliteColumnsSync(
  plan: SqliteColumnAdoptionPlan,
  driver: SyncSqliteColumnDriver,
): void {
  const steps = adoptionSteps(plan);
  let next = steps.next();
  while (!next.done) next = steps.next(executeStep(next.value, driver));
}

export async function adoptSqliteColumns(
  plan: SqliteColumnAdoptionPlan,
  driver: AsyncSqliteColumnDriver,
): Promise<void> {
  const steps = adoptionSteps(plan);
  let next = steps.next();
  while (!next.done) next = steps.next(await executeStep(next.value, driver));
}
