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

export function adoptSqliteColumnsSync(
  plan: SqliteColumnAdoptionPlan,
  driver: Readonly<{
    readColumns: () => readonly SqliteColumnRow[];
    execute: (statement: string) => void;
  }>,
): void {
  const steps = adoptionSteps(plan);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    const outcome: AdoptionOutcome = (() => {
      try {
        if (step.kind === "inspect")
          return { ok: true, rows: driver.readColumns() };
        driver.execute(step.statement);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    })();
    next = steps.next(outcome);
  }
}

export async function adoptSqliteColumns(
  plan: SqliteColumnAdoptionPlan,
  driver: Readonly<{
    readColumns: () => Promise<readonly SqliteColumnRow[]>;
    execute: (statement: string) => Promise<void>;
  }>,
): Promise<void> {
  const steps = adoptionSteps(plan);
  let next = steps.next();
  while (!next.done) {
    const step = next.value;
    const outcome: AdoptionOutcome = await (async () => {
      try {
        if (step.kind === "inspect")
          return { ok: true, rows: await driver.readColumns() };
        await driver.execute(step.statement);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    })();
    next = steps.next(outcome);
  }
}
