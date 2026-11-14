import { isSqliteDuplicateColumnError } from "../../utils/sql-errors";

export type SqliteColumnRow = Readonly<{ name?: unknown }>;
export type SqliteColumnAdoptionPlan = Readonly<{
  addedColumns: readonly string[];
  statements: (columns: ReadonlySet<string>) => readonly string[];
}>;
export type SyncSqliteColumnDriver = Readonly<{
  readColumns: () => readonly SqliteColumnRow[];
  execute: (statement: string) => void;
}>;
export type AsyncSqliteColumnDriver = Readonly<{
  readColumns: () => Promise<readonly SqliteColumnRow[]>;
  execute: (statement: string) => Promise<void>;
}>;

/** Normalize inventories once for synchronous and asynchronous SQLite drivers. */
function sqliteColumnNames(
  rows: readonly SqliteColumnRow[],
): ReadonlySet<string> {
  return new Set(
    rows.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
  );
}

/** Each additive column can lose one race; re-inventory after each bounded loss. */
function shouldRetrySqliteColumnAdoption(
  plan: SqliteColumnAdoptionPlan,
  attempt: number,
  error: unknown,
): boolean {
  return (
    attempt < plan.addedColumns.length &&
    plan.addedColumns.some((column) =>
      isSqliteDuplicateColumnError(error, column),
    )
  );
}

export function adoptSqliteColumnsSync(
  plan: SqliteColumnAdoptionPlan,
  driver: SyncSqliteColumnDriver,
): void {
  for (let attempt = 0; ; attempt += 1) {
    const statements = plan.statements(sqliteColumnNames(driver.readColumns()));
    try {
      for (const statement of statements) driver.execute(statement);
      return;
    } catch (error) {
      if (!shouldRetrySqliteColumnAdoption(plan, attempt, error)) throw error;
    }
  }
}

export async function adoptSqliteColumns(
  plan: SqliteColumnAdoptionPlan,
  driver: AsyncSqliteColumnDriver,
): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    const statements = plan.statements(
      sqliteColumnNames(await driver.readColumns()),
    );
    try {
      for (const statement of statements) await driver.execute(statement);
      return;
    } catch (error) {
      if (!shouldRetrySqliteColumnAdoption(plan, attempt, error)) throw error;
    }
  }
}
