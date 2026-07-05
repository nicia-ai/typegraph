# TypeGraph benchmarks

Two benchmark programs live in this package:

- **`src/*-bench.ts` + `src/main.ts`** — the synthetic perf-sanity suite
  (`pnpm bench`, `pnpm perf:check`) that runs in CI as a regression guardrail
  on a small seeded graph. Keep using this for fast, deterministic
  before/after comparisons during development.
- **`src/real/`** — the real-workload benchmark program described below:
  industry-standard datasets and queries, run against TypeGraph and named
  competitors, with a fairness harness (row-count parity, noisy-sample
  detection, a competitor doctor, and a `summary.json` per run). This
  supersedes `neo4j-compare/` (a 7.2k-node microbenchmark) for anything
  beyond order-of-magnitude anchors — see that directory's README for what
  it still remains useful for (a same-machine two-command sanity check with
  no dataset to fetch).

The full program design lives in `docs/design/benchmark-program-plan.md`
(gitignored, local to the repo checkout that approved it).

## Real-workload benchmarks (`src/real/`)

### Lane 1 — LDBC SNB Interactive short reads (IS1-IS7)

The headline lane: the official LDBC Social Network Benchmark's seven
short-read queries (point reads, neighbor lists, reply-chain walks) — the
closest standard workload to TypeGraph's operational profile.

**Engines** (docs/design/benchmark-program-plan.md's fair pairings):

| Pairing | Product under test | Competitor |
| --- | --- | --- |
| Embedded | `typegraph-sqlite` (better-sqlite3, in-process) | `ladybugdb` (`@ladybugdb/core`, Kuzu-family, in-process) |
| Server | `typegraph-postgres` (node-postgres, imperative docker container) | `neo4j` (pinned image, imperative docker container) |

Every query is implemented through the TypeGraph query builder for the
TypeGraph engines (never hand-written SQL — see
`src/real/engines/typegraph-queries.ts`'s module doc) and through
idiomatic Cypher for Neo4j/LadybugDB. `src/real/schema/snb-graph.ts`
documents one schema-design note worth knowing before reading the query
code: `replyOf`'s target is polymorphic (a Comment replies to either a
root Post or another Comment), which TypeGraph resolves with a
never-instantiated ontological `Message` supertype
(`subClassOf(Post, Message)` / `subClassOf(Comment, Message)`) so the
reply-chain walk can use `includeSubClasses` — Neo4j and LadybugDB don't
need this, since multi-label nodes / multi-pair relationship tables handle
polymorphic endpoints natively.

#### Running it

```bash
# Preflight: which engines are actually runnable on this machine right now
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:doctor

# Tiny committed fixture (30 persons, 40 posts, 80 comments) — fast, always
# runnable in CI regardless of Docker/optional-package availability
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:smoke

# Same, but exits non-zero on a genuine row-count mismatch between 2+
# engines that ran (the CI-safe form: 0 or 1 runnable engines still exits 0)
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:smoke:check

# Real LDBC SF1 (~10.6k persons, ~180k knows, ~1.1M posts, ~2.2M comments)
# CAUTION: as of this writing, TypeGraph/SQLite's bulk load shows apparent
# O(n^2) scaling on this schema (batches slow down as the graph grows —
# see the PR description for the isolated reproduction), so an SF1 load
# does not complete in a practical amount of time. Filed as a library
# finding, not fixed here (this is a benchmarks-only PR). Use the smoke
# profile until that's resolved.
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:sf1
```

`bench:snb:sf1` looks for an extracted datagen directory at
`~/.cache/typegraph/fixtures/ldbc-snb/sf1` and prints the exact download
commands if it's missing:

```bash
mkdir -p ~/.cache/typegraph/fixtures/ldbc-snb/sf1 && cd ~/.cache/typegraph/fixtures/ldbc-snb/sf1
curl -L -O https://datasets.ldbcouncil.org/snb-interactive-v1/social_network-sf1-CsvBasic-LongDateFormatter.tar.zst
zstd -d --stdout social_network-sf1-CsvBasic-LongDateFormatter.tar.zst | tar -xf -
```

Or point at an existing extract with `--data-dir <path>`. Real datasets are
never committed — only the tiny smoke fixture under `fixtures/` is.

Useful flags (all scripts): `--engines=typegraph-sqlite,neo4j` (default:
all four), `--requests-per-query=N`, `--warmup-requests=N`, `--seed=N`,
`--output=<dir>` (default `bench-results/current/snb-<profile>`,
gitignored).

#### What every run writes

- `bench-results/current/snb-<profile>/results.json` — per-query,
  per-engine latency stats (p50/p95/p99/mean/CV, flagged noisy above 25%
  CV) plus the row-count parity verdict.
- `bench-results/current/snb-<profile>/summary.json` — exact commands,
  engine versions, dataset parameters, hardware, git commit.
- `bench-results/current/snb-<profile>/competitor-doctor.json` — which
  engines were runnable and why not, for the ones that weren't.
- `reports/history.jsonl` — one append per engine per run, labels
  `snb:IS1`..`snb:IS7`, alongside the synthetic suite's rows in the same
  file.

#### Row-count parity gate

Every engine executes the identical seeded request sequence (same sampled
person/message ids, same order), so per-request row counts are directly
comparable index-for-index. A query is "comparable" only when every engine
that ran returned the same result-set size for every sampled request — see
`src/real/harness/parity.ts`. `--check` turns a genuine mismatch (2+
engines disagreeing) into a non-zero exit; it never fires when fewer than
2 engines ran, so a no-Docker CI environment (only the two embedded
engines runnable) still exits 0.

#### Competitor doctor

`src/real/harness/doctor.ts` checks Docker, `pg`/`better-sqlite3`,
`neo4j-driver`, `@ladybugdb/core`, and image cache status, and records
every missing piece as an explicit `failed`/`skipped` row — never a silent
skip. The harness only attempts engines the doctor reports runnable.

## Adding a new lane

Lanes 2-4 (LinkBench request mix, LSQB, adversarial shapes) are planned in
`docs/design/benchmark-program-plan.md` and land as separate PRs. The
shared harness in `src/real/harness/` (stats, parity, doctor, summary,
history, imperative Postgres container launcher) is written to be
lane-agnostic — a new lane adds its own dataset loader, schema, and engine
query implementations under `src/real/`, and reuses the harness as-is.
