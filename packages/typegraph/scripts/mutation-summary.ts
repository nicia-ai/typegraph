import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Renders a Stryker JSON report as a markdown summary: the mutation score, the
 * per-status counts, and every survived mutant with its location. Written to
 * `$GITHUB_STEP_SUMMARY` when that is set, otherwise to stdout.
 *
 * A missing report is reported, not thrown: the mutation run that should have
 * produced it has already failed the job on its own, and a second failure here
 * would only bury the real error.
 */

type MutantLocation = Readonly<{
  start: Readonly<{ line: number; column: number }>;
}>;

type Mutant = Readonly<{
  mutatorName: string;
  status: string;
  replacement?: string;
  location: MutantLocation;
}>;

type MutationReport = Readonly<{
  files?: Readonly<Record<string, Readonly<{ mutants?: readonly Mutant[] }>>>;
}>;

type Survivor = Readonly<{
  file: string;
  line: number;
  column: number;
  mutatorName: string;
  replacement: string;
}>;

const DEFAULT_REPORT_PATH = "reports/mutation-diff/mutation.json";
const MAXIMUM_LISTED_SURVIVORS = 50;
const MAXIMUM_REPLACEMENT_LENGTH = 80;

function countByStatus(report: MutationReport): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const file of Object.values(report.files ?? {})) {
    for (const mutant of file.mutants ?? []) {
      counts.set(mutant.status, (counts.get(mutant.status) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * Stryker reports file keys relative to the project root, but a plugin is free
 * to report an absolute path. Shorten those to a project-relative path only
 * when they actually live under it; anything else stays verbatim rather than
 * becoming a wall of `../`.
 */
function displayPath(file: string): string {
  if (!path.isAbsolute(file)) return file;
  const relative = path.relative(process.cwd(), file);
  return relative.startsWith("..") ? file : relative;
}

function compareSurvivors(left: Survivor, right: Survivor): number {
  if (left.file !== right.file) return left.file < right.file ? -1 : 1;
  if (left.line !== right.line) return left.line - right.line;
  return left.column - right.column;
}

function collectSurvivors(report: MutationReport): readonly Survivor[] {
  const survivors = Object.entries(report.files ?? {}).flatMap(
    ([file, fileResult]) =>
      (fileResult.mutants ?? [])
        .filter((mutant) => mutant.status === "Survived")
        .map((mutant) => ({
          file: displayPath(file),
          line: mutant.location.start.line,
          column: mutant.location.start.column,
          mutatorName: mutant.mutatorName,
          replacement: formatReplacement(mutant.replacement),
        })),
  );
  return survivors.toSorted((left, right) => compareSurvivors(left, right));
}

function formatReplacement(replacement: string | undefined): string {
  if (replacement === undefined) return "";
  const singleLine = replacement.replaceAll(/\s+/g, " ").trim();
  const truncated =
    singleLine.length > MAXIMUM_REPLACEMENT_LENGTH ?
      `${singleLine.slice(0, MAXIMUM_REPLACEMENT_LENGTH)}…`
    : singleLine;
  return truncated.replaceAll("|", String.raw`\|`).replaceAll("`", "'");
}

function formatScore(counts: ReadonlyMap<string, number>): string {
  const detected = (counts.get("Killed") ?? 0) + (counts.get("Timeout") ?? 0);
  const undetected =
    (counts.get("Survived") ?? 0) + (counts.get("NoCoverage") ?? 0);
  const valid = detected + undetected;
  if (valid === 0) return "No mutants were generated for the changed lines.";
  const score = ((detected / valid) * 100).toFixed(2);
  return `Mutation score on changed lines: **${score}%** (${detected} of ${valid} mutants detected).`;
}

function renderSurvivorTable(
  survivors: readonly Survivor[],
): readonly string[] {
  if (survivors.length === 0) {
    return ["No survived mutants on the changed lines."];
  }

  const listed = survivors.slice(0, MAXIMUM_LISTED_SURVIVORS);
  const rows = listed.map(
    (survivor) =>
      `| \`${survivor.file}:${survivor.line}:${survivor.column}\` | ${survivor.mutatorName} | \`${survivor.replacement}\` |`,
  );
  const overflow =
    survivors.length > listed.length ?
      [
        "",
        `…and ${survivors.length - listed.length} more. The full report is attached as a workflow artifact.`,
      ]
    : [];

  return [
    `### Survived mutants (${survivors.length})`,
    "",
    "| Location | Mutator | Replacement |",
    "| --- | --- | --- |",
    ...rows,
    ...overflow,
    "",
    "Each survivor on a changed line needs a test that kills it or a written justification in the pull request description.",
  ];
}

function renderSummary(report: MutationReport): string {
  const counts = countByStatus(report);
  const statuses = [
    "Killed",
    "Survived",
    "Timeout",
    "NoCoverage",
    "CompileError",
    "RuntimeError",
    "Ignored",
  ] as const;

  return [
    "## Changed-line mutation testing",
    "",
    formatScore(counts),
    "",
    `| ${statuses.join(" | ")} |`,
    `| ${statuses.map(() => "---").join(" | ")} |`,
    `| ${statuses.map((status) => counts.get(status) ?? 0).join(" | ")} |`,
    "",
    ...renderSurvivorTable(collectSurvivors(report)),
  ].join("\n");
}

async function readReport(
  reportPath: string,
): Promise<MutationReport | undefined> {
  try {
    return JSON.parse(await readFile(reportPath, "utf8")) as MutationReport;
  } catch {
    return undefined;
  }
}

async function emit(markdown: string): Promise<void> {
  const summaryPath = process.env["GITHUB_STEP_SUMMARY"];
  if (summaryPath === undefined || summaryPath === "") {
    console.log(markdown);
    return;
  }
  await appendFile(summaryPath, `${markdown}\n`);
}

async function main(): Promise<void> {
  const reportPath = process.argv[2] ?? DEFAULT_REPORT_PATH;
  const report = await readReport(reportPath);

  if (report === undefined) {
    await emit(
      [
        "## Changed-line mutation testing",
        "",
        `No mutation report was found at \`${reportPath}\`; the mutation run did not complete.`,
      ].join("\n"),
    );
    return;
  }

  await emit(renderSummary(report));
}

try {
  await main();
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
