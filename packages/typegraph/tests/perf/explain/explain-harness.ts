/**
 * Plan-shape assertion primitives shared by every suite under
 * `tests/perf/explain/`.
 *
 * This module owns three decisions that would otherwise get re-spelled per
 * suite (AGENTS.md "one predicate, one owner"):
 *
 * - {@link totalActualRows} is the ONE reducer over a PostgreSQL
 *   `EXPLAIN (ANALYZE, FORMAT JSON)` tree. It used to be declared privately in
 *   `tests/identity-frontier-bounded.test.ts`; that file now imports it from
 *   here instead of keeping its own copy (see that file's diff).
 * - {@link assertRowCeiling} is the only site that compares a plan's visited
 *   rows against a ceiling.
 * - {@link assertPlanShape} is the only site that compares a plan's rendered
 *   text against required/forbidden terms.
 *
 * Neither assertion silently passes on a plan it cannot judge: a ceiling
 * check refuses an engine that reports no rows-visited counter (SQLite,
 * always; any write-side EXPLAIN, on either engine — see
 * `ExplainSubject.explainWrite` in `explain-engines.ts`) instead of treating
 * `undefined` as zero, and a shape check refuses an empty plan text against a
 * non-empty `required` list instead of certifying nothing as compliance.
 */
import { requireDefined } from "../../../src/utils/presence";
import type { CapturedStatement } from "../../test-utils";

/** One node of a PostgreSQL `EXPLAIN (FORMAT JSON)` plan tree. */
export type PostgresPlanNode = Readonly<{
  "Node Type"?: string;
  "Relation Name"?: string;
  "Index Name"?: string;
  /**
   * Present on `CTE Scan` / `WorkTable Scan` nodes, which name what they scan
   * here rather than in `"Relation Name"`. Not part of the digest's signature
   * verbatim, but required for {@link renderPostgresPlan} to render a line an
   * assertion can name — verified against a real `CTE Scan` node in this tree
   * (`identity_peer_class`, historical identity-frontier plan).
   */
  "CTE Name"?: string;
  "Actual Rows"?: number;
  "Actual Loops"?: number;
  Plans?: readonly PostgresPlanNode[];
}>;

/** The document `EXPLAIN (ANALYZE, FORMAT JSON) <statement>` returns. */
export type PostgresPlanRoot = Readonly<{ Plan: PostgresPlanNode }>;

/**
 * Rows every plan node emitted, loops multiplied out. THE one owner (see this
 * module's doc comment): PostgreSQL reports per-loop averages under
 * `ANALYZE`, so a nested loop's inner side has to be multiplied back out to
 * count the work it actually did.
 */
export function totalActualRows(node: PostgresPlanNode): number {
  const own = (node["Actual Rows"] ?? 0) * (node["Actual Loops"] ?? 1);
  return (node.Plans ?? []).reduce(
    (sum, child) => sum + totalActualRows(child),
    own,
  );
}

/**
 * Renders a PostgreSQL `FORMAT JSON` plan to one line per node, pre-order:
 * `<Node Type> [on <Relation-or-CTE>] [using <Index Name>]`.
 */
export function renderPostgresPlan(root: PostgresPlanNode): string {
  const lines: string[] = [];
  function visit(node: PostgresPlanNode): void {
    const relation = node["Relation Name"] ?? node["CTE Name"];
    const parts = [
      node["Node Type"] ?? "",
      ...(relation === undefined ? [] : [`on ${relation}`]),
      ...(node["Index Name"] === undefined ?
        []
      : [`using ${node["Index Name"]}`]),
    ];
    lines.push(parts.join(" "));
    for (const child of node.Plans ?? []) visit(child);
  }
  visit(root);
  return lines.join("\n");
}

/** Engine-rendered plan, one node per line, plus the engine's row counter. */
export type ExplainedPlan = Readonly<{
  engine: "sqlite" | "postgres";
  label: string;
  text: string;
  /** `undefined` where the engine reports no counter (SQLite always; any write EXPLAIN). */
  visitedRows: number | undefined;
}>;

function describePlan(plan: ExplainedPlan): string {
  return `[${plan.engine}] ${plan.label}\n${plan.text}`;
}

function matchesTerm(text: string, term: string | RegExp): boolean {
  return typeof term === "string" ? text.includes(term) : term.test(text);
}

/**
 * Asserts a plan's rendered text carries every `required` term and none of
 * the `forbidden` ones.
 *
 * Refuses two vacuous invocations rather than silently passing them: calling
 * with both lists empty asserts nothing, and calling with a non-empty
 * `required` list against an empty plan text can never be satisfied honestly
 * — an empty plan is not evidence of the required shape, whatever the reason
 * it came back empty (see `claim-upsert.test.ts`'s declared-skipped SQLite
 * INSERT cases, which never reach this assertion at all for exactly that
 * reason).
 */
export function assertPlanShape(
  input: Readonly<{
    plan: ExplainedPlan;
    required: readonly (string | RegExp)[];
    forbidden: readonly (string | RegExp)[];
  }>,
): void {
  const { plan, required, forbidden } = input;
  if (required.length === 0 && forbidden.length === 0) {
    throw new Error(
      `assertPlanShape called with no required and no forbidden terms for ${describePlan(plan)} — this asserts nothing`,
    );
  }
  if (plan.text.trim() === "" && required.length > 0) {
    throw new Error(
      `assertPlanShape: empty plan text cannot satisfy required terms [${required.join(", ")}] for ${describePlan(plan)}`,
    );
  }
  for (const term of required) {
    if (!matchesTerm(plan.text, term)) {
      throw new Error(
        `assertPlanShape: required term ${String(term)} not found in ${describePlan(plan)}`,
      );
    }
  }
  for (const term of forbidden) {
    if (matchesTerm(plan.text, term)) {
      throw new Error(
        `assertPlanShape: forbidden term ${String(term)} found in ${describePlan(plan)}`,
      );
    }
  }
}

/**
 * Asserts a plan visited no more than `ceiling` rows.
 *
 * Refuses to judge a plan whose engine reports no counter — `undefined` means
 * "unmeasured", never "zero", and treating it as zero would make the ceiling
 * pass vacuously on exactly the engine (SQLite) or leg (any write EXPLAIN)
 * that cannot report it.
 */
export function assertRowCeiling(
  input: Readonly<{ plan: ExplainedPlan; ceiling: number }>,
): void {
  const { plan, ceiling } = input;
  if (plan.visitedRows === undefined) {
    throw new Error(
      `${plan.engine} reports no rows-visited counter for ${plan.label}; assert plan shape instead`,
    );
  }
  if (plan.visitedRows > ceiling) {
    throw new Error(
      `assertRowCeiling: ${plan.visitedRows} visited rows exceeds ceiling ${ceiling} for ${describePlan(plan)}`,
    );
  }
}

/** Every captured statement whose SQL text satisfies `matches`. */
export function statementsMatching(
  captured: readonly CapturedStatement[],
  matches: (sql: string) => boolean,
): readonly CapturedStatement[] {
  return captured.filter((statement) => matches(statement.sql));
}

/**
 * The single captured statement whose SQL text satisfies `matches`, named by
 * `label` for a clear failure. Throws when zero or more than one statement
 * matches — a probe assertion built on "the" statement is unusable if the
 * selector is ambiguous.
 */
export function onlyStatementMatching(
  captured: readonly CapturedStatement[],
  label: string,
  matches: (sql: string) => boolean,
): CapturedStatement {
  const matched = statementsMatching(captured, matches);
  if (matched.length !== 1) {
    throw new Error(
      `onlyStatementMatching("${label}"): expected exactly 1 matching statement, found ${matched.length}\n` +
        captured.map((statement) => statement.sql).join("\n---\n"),
    );
  }
  return requireDefined(matched[0]);
}
