# Regression mode

`pnpm bench:regression` (from the repo root, or `pnpm --filter
@nicia-ai/typegraph-benchmarks bench:regression` / `tsx
src/regression-bench.ts` from this package) automates the methodology that
caught the 0.46.0 identity-traversal regression (SQLite 0.0082ms → 564ms
median, ~69,000×; PostgreSQL killed at 60s — see #396): compare the
candidate against multiple historical points instead of only the PR's own
base, because the regression can have entered *before* the PR — that one
did, at main's base commit, invisible to PR-only comparison.

## The three-point baseline model

Every run compares the candidate against up to three baselines, each
checked out into its own scratch git worktree:

| Point | Resolved from | Flag |
| --- | --- | --- |
| `tag` | The most recently published `@nicia-ai/typegraph` npm tag (version-sorted, never lexical — lexical order would pick `@nicia-ai/typegraph@0.9.2` over `@nicia-ai/typegraph@0.49.0`) | `--tag=<ref>` |
| `base` | `git merge-base <candidate> main` | `--base=<ref>` |
| `feature` (optional) | Not resolved by default — a fourth point for comparing against a feature branch's own earlier state | `--feature-baseline=<ref>` |

The candidate is either an existing ref checked out into a fresh scratch
worktree (`--candidate=<ref>`) or an already-checked-out worktree path,
including the repo you're invoking from (`--candidate-worktree=<path>`,
defaulting to the invoking repo root). `--candidate` and
`--candidate-worktree` are mutually exclusive.

The default `base` is always resolved against the *candidate* being
measured, never against the invoking checkout's own `HEAD` — those differ
whenever `--candidate=<ref>` names something other than what the invoking
repo currently has checked out. Passing `--candidate=some-other-branch`
without `--base` compares against `git merge-base some-other-branch main`,
not `git merge-base HEAD main`.

Scratch worktrees always live outside the repository (default:
`<tmpdir>/typegraph-regression/<repo HEAD short sha>`, override with
`--worktree-root`) — an in-repo worktree would pollute `git status`,
prettier, and knip scans. Each one gets `pnpm install --frozen-lockfile
--prefer-offline` plus an explicit `pnpm --filter @nicia-ai/typegraph
build` before any lane runs in it. `--skip-install` skips both steps, but
is refused (not silently ignored) against a worktree with no
`node_modules` — there is nothing to skip installing.

Set `NODE_OPTIONS=--max-old-space-size=8192` when invoking `bench:regression`,
same as the repo's standard pre-commit gate — `@nicia-ai/typegraph`'s
declaration build is memory-hungry enough to need it.

## Lanes

A lane is a pnpm script name per backend (`packages/benchmarks/src/regression/lanes.ts`,
`lanes/synthetic.ts`, `lanes/real-workload.ts`). `--lanes=perf,write` selects
by id; omitting `--lanes` runs the default set (`perf`, `write`, `identity`).
An unknown id throws, naming every valid one.

`lanes/real-workload.ts` is the seam PR #286's SNB lanes register into:
appending a `RegressionLane` entry there is the entire integration — no
runtime `register()` call, no edit anywhere else in the harness.

## Backends

`--backend=sqlite` (default), `--backend=postgres`, or `--backend=both`.
A postgres leg requires a resolvable `POSTGRES_URL` — requesting
`postgres`/`both` without one throws instead of silently downgrading to
sqlite-only (an accepted option is applied or refused, never dropped).

A lane whose backend leg is undefined for that lane (see
`RegressionLane.scripts`), or whose script is absent from a particular
worktree's `packages/benchmarks/package.json`, is reported as
`unavailable` with a reason. It never reports a ratio and never counts as
"no regression" — see `resolveLanes`/`runLane` in
`src/regression/{lanes,run-lane}.ts`.

## Threshold policy

`src/regression/policy.ts`:

| Threshold | Value | Meaning |
| --- | --- | --- |
| `flagRatio` | 1.2 | candidate/baseline ≥ 1.2× → `flagged` (exit 1) |
| `failRatio` | 2.0 | candidate/baseline ≥ 2.0× → `failed` (exit 2) |
| `minAbsoluteDeltaMs` | 0.5 | a comparison below this absolute delta is `below-noise-floor`, regardless of ratio |

The noise floor gates on the **absolute delta**, never on the baseline's
magnitude — the #396 regression's baseline was 0.0082ms; gating on the
baseline instead of the delta would have suppressed the exact case this
tool exists to catch.

## Accepting a known regression

Add an entry to `DEFAULT_REGRESSION_POLICY.accepted` in
`src/regression/policy.ts`. `main()` reads this constant directly; there is
no `--policy`/`--accept` CLI flag or config-file override, so recording an
accepted regression is a source change reviewed like any other:

```ts
{
  laneId: "vector",
  label: "vector:ann-filtered",
  baseline: "base", // or "all" to cover every baseline
  maxRatio: 1.6,
  reason: "Known regression from the HNSW rebuild; tracked in #1234.",
  issue: "#1234",
}
```

`reason` is required and non-empty. The acceptance only applies up to its
own `maxRatio` — a ratio above that ceiling re-classifies to `flagged`/`failed`
with a note naming the exceeded ceiling; it is never silently absorbed. An
acceptance that matches no observed `(laneId, label, baseline)` triple in a
run is **stale** and is itself a hard failure (exit 2) — a regression tool
that lets its own overrides rot is not trustworthy.

## Report output

Each run writes `report.md` and `report.json` to
`packages/benchmarks/reports/regression/<ISO-date>-<candidate short sha>/`
by default (`--output=<dir>` to override; this directory is gitignored —
curated proof reports are committed separately at
`packages/benchmarks/reports/regression-*.md`). The markdown includes a
per-lane table (`Lane | Measurement | Baseline | Unit | baseline | candidate |
ratio | classification`), the resolved SHA of every worktree, the
policy in force, and every applied acceptance with its reason. The JSON
report nests measurements by lane id, then baseline — never a flattened
`"lane:baseline"` string key.

## Exit code

`reportExitCode` (`src/regression/compare.ts`) is the single owner:

- `2` — any hard failure (`ratio ≥ failRatio`), any stale acceptance, or
  any lane that produced no trustworthy comparison at all: the script was
  unavailable, the run failed or timed out, **or** the baseline and
  candidate signatures disagree (e.g. a different `sampleIterations`) so
  the two runs are not comparable in the first place.
- `1` — no hard failure, but at least one flag (`ratio ≥ flagRatio`, or a
  baseline-only measurement missing from the candidate).
- `0` — clean.

A timeout (`--lane-timeout-ms`, default 15 minutes) is a hard failure, not
an absence — the PostgreSQL "killed at 60s" case from #396 must surface in
the exit code, not vanish because the process never produced a result.
An incomparable lane (signature mismatch) is treated with the same
severity as an unrunnable one: "no comparison happened" is the same
untrustworthy state whether the run never happened, failed, or ran but
can't be measured against its baseline — none of them may read as "no
regression."

A lane that exits successfully but appends no measurement is also unrunnable.
This covers optional engines and capabilities that can legitimately skip their
work: a zero-row result is not evidence of unchanged performance. Signatures
must have identical key sets and values. The synthetic and SNB writers include
warmup/sample counts, and multi-engine SNB runs include the sorted engine set;
a missing parameter is a mismatch rather than a wildcard.

Most measurements are latency, where lower is better and the default absolute
noise floor is `0.5ms`. Vector `*-recall` measurements are declared as
higher-is-better recall values with a `0.01` noise floor. The classifier turns
their ratio into degradation polarity before applying the same flag/fail
thresholds, so increased recall is an improvement and decreased recall is a
regression.

## Running on EC2

`bench:regression:ec2` / `bench:regression:ec2:collect` run this exact tool
on a dedicated, ephemeral EC2 instance instead of locally — the runner behind
the scheduled/on-demand `Perf Timing Lane` GitHub Actions workflow. See
[`docs/ec2-regression-lane.md`](ec2-regression-lane.md).

## Seeded-regression proof

`pnpm bench:regression:proof -- --seed=<id>` (or `pnpm --filter
@nicia-ai/typegraph-benchmarks bench:regression:proof -- --seed=<id>` / `tsx
src/regression-proof.ts --seed=<id>` from this package) is this workstream's
own load-bearing test: it seeds a known, already-fixed cost regression into a
scratch worktree and asks whether the harness built above actually catches
it, at the right severity, two independent ways.

### The seed registry

`src/regression/proof/seeds.ts` registers a `RegressionSeed` per known
historical regression. A seed is a *reverse* patch — `git diff <fixed-sha>
<fixed-sha>^` over exactly the files the fix touched — committed under
`packages/benchmarks/etc/seeds/*.patch`. Applying it inside a scratch
worktree un-fixes the regression without touching anything else, so the
worktree's behavior on the seeded shape is a known answer, not a guess.

The one registered seed today, `identity-frontier-396`, reverts `317f73d`
("perf(query): bound current identity expansion by the frontier, not the
closure"), restoring its parent `2562fe0`'s graph-wide `identity_peer_class`
MATERIALIZED CTE at the current read coordinate — the #396/#432 shape (cost =
sum of squares of every identity class in the graph). `allowedPathPrefixes`
scopes it to `packages/typegraph/src/query/compiler/` only; a seed that
touched its own guarding test would prove nothing.

### The two halves and their judges

`src/regression/proof/verdict.ts` is the testable core — every decision the
proof makes lives here, none of it re-derived by the CLI or the driver:

- **Timing half** (`judgeTimingProof`): reads the `bench:regression` report
  the driver produced against the seeded worktree and asks whether the
  `LaneComparison` for the seed's declared `(laneId, baseline)` classifies
  the seed's declared `label` at exactly the seed's declared severity. It
  never recomputes severity from thresholds — `classification` is owned by
  `policy.classifyRatio`, consumed here, not re-derived — and it refuses a
  report generated under a modified policy (a widened threshold or an
  acceptance could make the seed "pass" without the fix having anything to
  do with it).
- **Explain half** (`judgeExplainProof`): reads a `vitest --reporter=json`
  run of the seed's declared `tests/perf/explain/**` file and asks whether
  every declared `mustFail` case failed, unambiguously, with a message
  containing its own declared diagnostic substring, while every declared
  `mustPass` case still passed. A red test proves nothing on its own — an
  import error or a timeout is also red — the diagnostic substring is what
  proves the test went red for the *declared* reason. A `mustFail` case that
  passed is reported as "the seed passed undetected": the batch's own
  STOP-and-escalate signal, never softened by loosening a ceiling or a term.

`combineProofVerdict` is `proven` only when both halves ran and both proved;
`--half=timing`/`--half=explain` runs one half for fast iteration during the
loop protocol below, but `src/regression-proof.ts` refuses to write the
curated report for a partial run (`PartialProofReportError`) — a report
claiming "both halves proven" from a run that only checked one would be
dishonest.

When `--backend=both` is requested, the timing half reads the separate
`sqlite/report.json` and `postgres/report.json` files and requires both backend
verdicts to prove. One inconclusive backend makes the timing half inconclusive.

### The `--tag=<base>` isolation rationale

The driver invokes `bench:regression` with `--tag=<sha> --base=<sha>`, the
SAME resolved sha, deliberately. The proof isolates exactly one variable —
the seed patch — so both baseline points must be the unseeded tree. A real
three-point run against a published tag would mix that release's own
label/signature differences (`missing-baseline`, `incomparable`) into the
result and prove nothing about the seed itself.

### The exit-code-is-not-proof rule

`judgeTimingProof` never looks at `reportExitCode` — an unrunnable lane, an
incomparable signature, and a hard failure on the WRONG label all produce
exit code `2`, but none of them is evidence that *this* seed was caught for
*this* reason. Proof requires the exact matched `(lane, label, baseline,
classification)` comparison the seed declares; an exit code is a summary,
never a substitute.

### Report

Each proof run writes a curated report to `packages/benchmarks/reports/
regression/proof-<seedId>-<date>/proof-report.md` (gitignored, like every
other `reports/regression/` output). The load-bearing, committed proof for
`identity-frontier-396` is at
[`reports/regression-seeded-identity-frontier-396.md`](../reports/regression-seeded-identity-frontier-396.md).
