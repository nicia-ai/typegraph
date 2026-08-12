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

Add an entry to `DEFAULT_REGRESSION_POLICY.accepted` (or a
policy variant threaded through the same shape):

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
per-lane table (`Lane | Measurement | Baseline | baseline ms | candidate
ms | ratio | classification`), the resolved SHA of every worktree, the
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
