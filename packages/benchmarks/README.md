# TypeGraph benchmarks

Two benchmark programs live in this package:

- **`src/*-bench.ts` + `src/main.ts`** — the synthetic perf-sanity suite
  (`pnpm bench`, `pnpm perf:check`) that runs in CI as a regression guardrail
  on a small seeded graph. Keep using this for fast, deterministic
  before/after comparisons during development.
- **`src/real/`** — the real-workload benchmark program described below:
  industry-standard datasets and queries, run against TypeGraph and named
  competitors, with a fairness harness (row-count + value-level digest
  parity, noisy-sample detection, a competitor doctor, and a
  `summary.json` per run). This supersedes `neo4j-compare/` (a 7.2k-node
  microbenchmark) for anything beyond order-of-magnitude anchors — see
  that directory's README for what it still remains useful for (a
  same-machine two-command sanity check with no dataset to fetch).

The full program design lives in `docs/design/benchmark-program-plan.md`
(gitignored, local to the repo checkout that approved it).

## Real-workload benchmarks (`src/real/`)

### Lane 1 — LDBC SNB Interactive short reads (IS1-IS7)

The headline lane: LDBC SNB Interactive's seven short-read queries (point
reads, neighbor lists, reply-chain walks), adapted to this schema — the
closest standard workload to TypeGraph's operational profile. Every
query's output fields and result ordering match the official LDBC
reference implementation (verified against
`ldbc/ldbc_snb_interactive_v1_impls`) — but the schema itself
deliberately flattens two relationships the official schema models as
edges into plain properties instead: `Person.cityId` (official IS1
traverses `IS_LOCATED_IN` to a `City` node; this schema has no `City`
node at all) and `Forum.moderatorId` (official IS6 traverses
`HAS_MODERATOR`; see `src/real/schema/snb-graph.ts`'s module doc for why).
Both are simplifications applied identically across all four engines, not
a TypeGraph-specific shortcut — call this lane "LDBC SNB-derived," not a
claim of full official schema conformance.

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

# Tiny committed fixture (31 persons, 40 posts, 105 comments — including a
# dedicated 25-comment same-creationDate tie cluster, see "Parity gate"
# below) — fast, always runnable in CI regardless of Docker/optional-package
# availability
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:smoke

# Same, but exits non-zero on a genuine parity mismatch (row count or
# value digest) between 2+ engines that ran (the CI-safe form: 0 or 1
# runnable engines still exits 0)
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:smoke:check

# Adversarial correctness check, independent of cross-engine consensus: one
# fixture person's IS2 answer is known in advance (see "Parity gate" below),
# checked against each doctor-runnable engine's actual result directly
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:verify-is2-tie-break

# Real LDBC SF1 (~9.9k persons, ~361k knows (directed), ~1M posts, ~2.05M
# comments). Takes under an hour on typical hardware (TypeGraph/SQLite
# ~40 minutes, TypeGraph/Postgres ~12 minutes, Neo4j ~5 minutes, LadybugDB
# under a minute, as of the most recent real run — see
# reports/snb-lane1-results.md for the numbers and why the load times
# differ this much across engines; that doc is the canonical source, this
# README's numbers can drift).
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:sf1

# Or run it on a dedicated ephemeral EC2 instance instead of local
# hardware (docs/ec2-benchmark-runner.md) — useful when local hardware is
# contended, or for a stable, reproducible hardware profile.
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:sf1:ec2 -- \
  --region=us-west-2 --subnet-id=<id> --security-group-id=<id> \
  --iam-instance-profile=<name>
```

`bench:snb:sf1` looks for an extracted datagen directory at
`~/.cache/typegraph/fixtures/ldbc-snb/sf1` and prints the exact download
commands if it's missing:

```bash
mkdir -p ~/.cache/typegraph/fixtures/ldbc-snb/sf1 && cd ~/.cache/typegraph/fixtures/ldbc-snb/sf1
curl -L -O https://datasets.ldbcouncil.org/snb-interactive-v1/social_network-sf1-CsvBasic-LongDateFormatter.tar.zst
zstd -d --stdout social_network-sf1-CsvBasic-LongDateFormatter.tar.zst | tar -xf - --strip-components=1
```

The archive extracts into its own `social_network-...-LongDateFormatter/`
subdirectory, not flat — `--strip-components=1` is required, not
cosmetic; without it, `dynamic/person_0_0.csv` won't be where
`resolveDatasetRoot` looks for it. Or point at an existing extract with
`--data-dir <path>`. Real datasets are never committed — only the tiny
smoke fixture under `fixtures/` is.

Useful flags (all scripts): `--engines=typegraph-sqlite,neo4j` (default:
all four), `--requests-per-query=N`, `--warmup-requests=N`, `--seed=N`,
`--output=<dir>` (default `bench-results/current/snb-<profile>`,
gitignored).

#### What every run writes

- `bench-results/current/snb-<profile>/results.json` — per-query,
  per-engine latency stats (p50/p95/p99/mean/CV, flagged noisy above 25%
  CV) plus the parity verdict (row count and value digest).
- `bench-results/current/snb-<profile>/summary.json` — exact commands,
  engine versions, dataset parameters, hardware, git commit.
- `bench-results/current/snb-<profile>/competitor-doctor.json` — which
  engines were runnable and why not, for the ones that weren't.
- `reports/history.jsonl` — one append per engine per run, labels
  `snb:IS1`..`snb:IS7`, alongside the synthetic suite's rows in the same
  file.

#### Parity gate

Every engine executes the identical seeded request sequence (same sampled
person/message ids, same order), so per-request results are directly
comparable index-for-index. A query is "comparable" only when every engine
that ran agrees on **both** the result-set size (row count) **and** a
canonical value digest built from the query's actual LDBC-defined output
fields (message content, names, ids, ordering — not just how many rows
came back) — see `src/real/harness/parity.ts`'s `evaluateParity()` and
`src/real/engines/types.ts`'s `canonicalDigest()`. Row-count agreement
alone previously let a real semantic bug (all four engines measuring the
wrong IS2 workload) go undetected for as long as it did, which is why the
gate compares values now, not just counts. `--check` turns a genuine
mismatch (2+ engines disagreeing, on either signal) into a non-zero exit;
it never fires when fewer than 2 engines ran, so a no-Docker CI
environment (only the two embedded engines runnable) still exits 0.

Cross-engine agreement is still only consensus, not proof — this lane has
shipped bugs (a shared wrong workload, a shared lexicographic-vs-numeric
tie-break) that every engine reproduced identically, which parity alone
can never catch. `bench:snb:verify-is2-tie-break` checks against a known
answer instead: the smoke fixture's dedicated tie-cluster person (25
same-creationDate comments, `dataset/smoke-fixture-constants.ts`) has an
IS2 result computable in advance, since an identical creationDate leaves
ascending message id as the only tie-break — each doctor-runnable engine's
actual result is checked against that oracle directly, independent of
what any other engine returned.

The EC2 runner (`bench:snb:sf1:ec2:collect`) additionally requires the
full four-engine set to have actually produced results — see
`src/real/ec2/run-sf1-ec2.ts`'s `collect()` doc comment for why a paid,
multi-hour run can't tolerate the same partial-engine leniency a local/CI
invocation intentionally allows.

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
