import { z } from "zod";

/**
 * Headroom over a recorded actual, not a per-PR allowance: a check passes
 * when `measured <= budgetCeiling(recorded)`, where `recorded` is the
 * measured actual `pnpm size-budget:update` wrote at seed time — never a
 * target, an estimate, or the previous PR's measurement. Because the
 * ceiling is anchored to a fixed recorded number, many small PRs cannot
 * walk the budget upward one +5% increment at a time; each is compared
 * against the same baseline until someone deliberately re-seeds.
 */
export const BUDGET_HEADROOM = 1.05;

const RecordedMetricSchema = z.object({
  minified: z.number().int().nonnegative(),
  gzip: z.number().int().nonnegative(),
});

const RecordedEntrypointSchema = z.object({
  minified: z.number().int().nonnegative(),
  gzip: z.number().int().nonnegative(),
  excludedDomains: z.array(z.string()),
});

const RecordedArtifactsSchema = z.object({
  esmBytes: z.number().int().nonnegative(),
  cjsBytes: z.number().int().nonnegative(),
  declarationBytes: z.number().int().nonnegative(),
});

export const SizeBudgetFileSchema = z.object({
  entrypoints: z.record(z.string(), RecordedEntrypointSchema),
  probes: z.record(z.string(), RecordedMetricSchema),
  artifacts: RecordedArtifactsSchema,
});

export type SizeBudgetFile = z.infer<typeof SizeBudgetFileSchema>;

export type ViolationKind =
  "over-budget" | "domain-mismatch" | "missing-entry" | "stale-entry";

export type BudgetViolation = Readonly<{
  targetId: string;
  metric: string;
  kind: ViolationKind;
  detail: string;
}>;

export function budgetCeiling(recorded: number): number {
  return Math.ceil(recorded * BUDGET_HEADROOM);
}

/**
 * The single owner of the pass/fail decision for one byte metric (`minified`
 * or `gzip`) of one target. Every caller — the vitest suite and the CLI —
 * asks this function, never re-spelling the `budgetCeiling` comparison
 * inline.
 */
export function compareMetric(
  targetId: string,
  metric: string,
  recorded: number,
  measured: number,
): readonly BudgetViolation[] {
  const ceiling = budgetCeiling(recorded);
  if (measured > ceiling) {
    return [
      {
        targetId,
        metric,
        kind: "over-budget",
        detail: `measured ${measured} exceeds the budget ceiling of ${ceiling} (recorded actual ${recorded} + ${BUDGET_HEADROOM}x headroom).`,
      },
    ];
  }

  return [];
}

/**
 * Requires exact set equality between the recorded excluded-domain list and
 * the domains the entrypoint's import graph does not reach right now
 * (`universe \ reached`). A leak (a previously excluded domain now reached)
 * and a stale entry (`src` gained or lost a domain, changing the universe)
 * are both failures — the recorded set can only change via a deliberate
 * re-seed, never silently.
 */
export function compareExcludedDomains(
  targetId: string,
  recorded: readonly string[],
  reached: readonly string[],
  universe: readonly string[],
): readonly BudgetViolation[] {
  const reachedSet = new Set(reached);
  const actualExcluded = universe.filter((domain) => !reachedSet.has(domain));
  const recordedSet = new Set(recorded);
  const actualExcludedSet = new Set(actualExcluded);

  const leaked = recorded.filter((domain) => !actualExcludedSet.has(domain));
  const stale = actualExcluded.filter((domain) => !recordedSet.has(domain));

  if (leaked.length === 0 && stale.length === 0) {
    return [];
  }

  const details: string[] = [];
  if (leaked.length > 0) {
    details.push(
      `now reaches previously-excluded domains: ${leaked.join(", ")} (reachability leak).`,
    );
  }
  if (stale.length > 0) {
    details.push(
      `now excludes domains absent from the recorded set: ${stale.join(", ")} (src/ gained or lost a domain; re-seed).`,
    );
  }

  return [
    {
      targetId,
      metric: "excludedDomains",
      kind: "domain-mismatch",
      detail: details.join(" "),
    },
  ];
}

/**
 * Requires the recorded budget's entrypoint/probe IDs to exactly match the
 * IDs derived from the current inventory (`package.json` `exports` and
 * `PROBE_SYMBOLS`). Both directions are named separately: an expected ID
 * absent from the recorded file is `missing-entry`; a recorded ID no longer
 * in the expected inventory is `stale-entry`. Checking only one direction
 * would let a deleted entrypoint's budget rot forever alongside a real one.
 */
export function compareInventory(
  expectedIds: readonly string[],
  recordedIds: readonly string[],
): readonly BudgetViolation[] {
  const expectedSet = new Set(expectedIds);
  const recordedSet = new Set(recordedIds);

  const missing = expectedIds.filter((id) => !recordedSet.has(id));
  const stale = recordedIds.filter((id) => !expectedSet.has(id));

  return [
    ...missing.map((id): BudgetViolation => ({
      targetId: id,
      metric: "inventory",
      kind: "missing-entry",
      detail: `no recorded budget entry for "${id}"; run pnpm size-budget:update.`,
    })),
    ...stale.map((id): BudgetViolation => ({
      targetId: id,
      metric: "inventory",
      kind: "stale-entry",
      detail: `recorded budget entry "${id}" no longer corresponds to a published target; run pnpm size-budget:update.`,
    })),
  ];
}
