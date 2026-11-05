/**
 * The run count a property test asks fast-check for: `ci` under CI, `local`
 * otherwise, both multiplied by `TYPEGRAPH_PROPERTY_RUNS_SCALE` (a positive
 * number, default 1) so a deep run raises every budget at once without
 * editing tests.
 */
export function propertyRuns(
  budget: Readonly<{ ci: number; local: number }>,
): number {
  const base = process.env["CI"] ? budget.ci : budget.local;
  return Math.max(1, Math.round(base * propertyRunScale()));
}

const PROPERTY_RUNS_SCALE_ENV = "TYPEGRAPH_PROPERTY_RUNS_SCALE";

function propertyRunScale(): number {
  const raw = process.env[PROPERTY_RUNS_SCALE_ENV];
  if (raw === undefined || raw === "") return 1;
  const scale = Number(raw);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error(
      `${PROPERTY_RUNS_SCALE_ENV} must be a positive number, got "${raw}".`,
    );
  }
  return scale;
}
