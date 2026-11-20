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
| Server | `typegraph-postgres` | `pggraph` (pgGraph PostgreSQL extension, pinned image, imperative docker container) |

Pinned competitor versions (`src/real/harness/engine-pins.ts`, exact in
`package.json`):

| Engine | Pin |
| --- | --- |
| Neo4j | `neo4j:2026.10.2` by digest, Graph Data Science `2026.10.2` jar (SHA-256 checked, mounted as `/plugins`) |
| pgGraph | `ghcr.io/evokoa/pggraph:1.2.1` by digest (PostgreSQL 17) |
| LadybugDB | `@ladybugdb/core` `0.22.3` |
| TypeGraph/PostgreSQL server | `pgvector/pgvector:0.8.7-pg18` by digest |

Every run records the versions each engine reports while running (a version
query, the extension catalog, `gds.version()`), not the pin, in the log,
`results.json` and `summary.json`.

Every query is implemented through the TypeGraph query builder for the
TypeGraph engines (never hand-written SQL — see
`src/real/engines/typegraph-queries.ts`'s module doc) and through
idiomatic Cypher for Neo4j/LadybugDB. `src/real/schema/snb-graph.ts`
documents one schema-design note worth knowing before reading the query
code: `replyOf`'s target is polymorphic (a Comment replies to either a
root Post or another Comment), which TypeGraph resolves with a
never-instantiated ontological `Message` supertype
(`subClassOf(Post, Message)` / `subClassOf(Comment, Message)`) so the
reply-chain walk can use `expansion: "subclasses"` — Neo4j and LadybugDB don't
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
# comments). Takes under an hour on typical hardware — see
# reports/snb-lane1-results.md for current load times and why they differ
# this much across engines; that doc is the canonical, current source,
# not duplicated here since these numbers drift with every run.
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
all five), `--requests-per-query=N`, `--warmup-requests=N`, `--seed=N`,
`--output=<dir>` (default `bench-results/current/snb-<profile>`,
gitignored), `--no-history` (do not append to `reports/history.jsonl`),
`--require-all-engines` (fail instead of skipping a requested engine the
doctor cannot run).

#### Running against existing servers

Each server engine launches its own throwaway container by default. On a
host that cannot start containers, point it at a server instead; the doctor
then probes that server and does not require Docker for that engine.

| Variable | Engine | Isolation and cleanup | Server requirements |
| --- | --- | --- | --- |
| `TYPEGRAPH_BENCH_POSTGRES_URL=postgresql://user:pass@host:port/db` | `typegraph-postgres` | Creates a fresh per-run database, never touches the database in the URL, drops the per-run database on close | Role with `CREATEDB` |
| `TYPEGRAPH_BENCH_PGGRAPH_URL=postgresql://user:pass@host:port/db` | `pggraph` | Same per-run database, with `CREATE EXTENSION graph` in it; close runs `graph.reset(true)` and drops it | The pgGraph extension installed; a superuser role (the extension is untrusted and the load sets `graph.sync_mode`) |
| `TYPEGRAPH_BENCH_NEO4J_URL=bolt://user:pass@host:7687` (+ optional `TYPEGRAPH_BENCH_NEO4J_DATABASE`, default `neo4j`) | `neo4j` | Requires the database to be empty (no nodes, constraints, non-lookup indexes or GDS projections) and refuses it otherwise; close deletes the run's nodes, its three `snb_*` constraints and its per-run GDS projection | Graph Data Science installed |

Credentials in a URL are redacted in every log line and report. pgGraph keeps
its CSR artifacts under the server's data directory; version 1.2.1 does not
reclaim a dropped graph's artifact directory, so a pgGraph run on a shared
server leaves that directory behind.

Neo4j on an existing server cannot use the offline `neo4j-admin database
import` the container path uses, so it loads online: nodes in batched
`UNWIND` transactions as they stream, relationships after every node exists,
with the same three uniqueness constraints created first. Every batch is
checked against the server's created-node and created-relationship counters.
Query timings stay comparable (same graph, same constraints, same GDS
projection, same warm-up); load times are not, and every report names the
load path each engine used.

The run header prints the resolved `@nicia-ai/typegraph` entry path and the
TypeGraph version and commit, so a run that picked up another checkout's
build is visible.

#### Comparison runs (all engines, smoke then SF1)

`bench:snb:compare` is the entry point for a published comparison. It runs
smoke-scale parity and then each real scale, each as one run of every
selected engine (one parity check across all of them), and writes
`report.md` plus the JSON files to `<output-root>/snb-<scale>/`. It passes
`--check --require-all-engines`, so a parity mismatch, an engine failure, or
a selected engine the doctor cannot run exits non-zero, and a failed smoke
run stops before SF1. It does not append to `reports/history.jsonl` unless
given `--history`.

```bash
# (a) Smoke parity, all five engines, containers started by the harness
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:compare -- --scales=smoke

# (b) SF1, all five engines, containers (smoke parity runs first; omit
# --data-dir-sf1 to use ~/.cache/typegraph/fixtures/ldbc-snb/sf1)
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:compare -- \
  --scales=smoke,sf1 --data-dir-sf1=<extracted SF1 dir>

# Either one against existing servers instead of containers
TYPEGRAPH_BENCH_POSTGRES_URL=postgresql://user:pass@host:5432/db \
TYPEGRAPH_BENCH_PGGRAPH_URL=postgresql://user:pass@host:5433/db \
TYPEGRAPH_BENCH_NEO4J_URL=bolt://user:pass@host:7687 \
  pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:compare -- --scales=smoke,sf1
```

`--engines=a,b` narrows the set, `--output-root=<dir>` picks where reports
go, and `--requests-per-query`, `--warmup-requests`, `--seed` and
`--queries` are forwarded to every scale.

What the container path needs. Engines run one at a time, and each engine's
containers and volumes are removed before the next engine starts.

| Engine | Image | Ports | Volumes and files | Memory |
| --- | --- | --- | --- | --- |
| `typegraph-postgres` | `pgvector/pgvector:0.8.7-pg18` (pinned digest) | container 5432 on a free 127.0.0.1 port | anonymous data volume, removed with the container | server defaults, `fsync=off` |
| `neo4j` | `neo4j:2026.10.2` (pinned digest) | container 7687 on a free 127.0.0.1 port | named `/data` volume (removed on close); the staged import CSVs (about the dataset's size) and the GDS jar bind-mounted from the OS temp dir; 256 MiB tmpfs each for `/logs` and `/tmp`; the GDS jar (about 70 MB, downloaded once from GitHub) cached in `~/.cache/typegraph/neo4j-plugins` | heap and page cache from `neo4j-admin server memory-recommendation` for the memory Docker reports, so most of the host; since 2026.09 the page cache is reserved in full at startup |
| `pggraph` | `ghcr.io/evokoa/pggraph:1.2.1` (pinned digest, PostgreSQL 17) | container 5432 on a free 127.0.0.1 port | anonymous data volume, removed with the container | image defaults; pgGraph's own `graph.memory_limit_mb` (2 GiB default) bounds the CSR build |
| `typegraph-sqlite` | none | none | database file in the OS temp dir | page cache sized from host memory |
| `ladybugdb` | none | none | staged CSVs and database in the OS temp dir | default buffer pool |

The Graph Data Science jar is fetched with Node's `fetch`, which ignores
`HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1` is set; on a proxied host set it,
or place the pinned jar in `~/.cache/typegraph/neo4j-plugins/` beforehand
(it is still checked against the pinned SHA-256).

The published SF1 numbers come from an EC2 `c7i.4xlarge` (16 vCPU, 32 GiB)
with a 150 GiB gp3 volume (`docs/ec2-benchmark-runner.md`); that is a known-good
size for all five engines at SF1. The SF1 archive is 230 MB (zstd); the
extracted CSVs are larger. Per-engine disk use at SF1 has not been measured
on this branch.

#### What every run writes

- `bench-results/current/snb-<profile>/results.json` — per-query,
  per-engine latency stats (p50/p95/p99/mean/CV, flagged noisy above 25%
  CV) plus the parity verdict (row count and value digest).
- `bench-results/current/snb-<profile>/summary.json` — exact commands,
  engine versions, dataset parameters, hardware, git commit.
- `bench-results/current/snb-<profile>/competitor-doctor.json` — which
  engines were runnable and why not, for the ones that weren't.
- `bench-results/current/snb-<profile>/report.md` — the same run for a
  reader: verdict, engine versions read from the running engines, where each
  ran and how it loaded, parity per query, p50/p95 per engine.
- `reports/history.jsonl` — one append per engine per run, labels
  `snb:IS1`..`snb:IS7`, alongside the synthetic suite's rows in the same
  file. `--no-history` skips it; `bench:snb:compare` skips it unless given
  `--history`.

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
`neo4j-driver`, `@ladybugdb/core`, image cache status, and every server
named by a `*_URL` variable (reachable, required extension or plugin, role
privileges), and records
every missing piece as an explicit `failed`/`skipped` row — never a silent
skip. The harness only attempts engines the doctor reports runnable.

## Adding a new lane

Lanes 2-4 (LinkBench request mix, LSQB, adversarial shapes) are planned in
`docs/design/benchmark-program-plan.md` and land as separate PRs. The
shared harness in `src/real/harness/` (stats, parity, doctor, summary,
history, imperative Postgres container launcher) is written to be
lane-agnostic — a new lane adds its own dataset loader, schema, and engine
query implementations under `src/real/`, and reuses the harness as-is.

## Subgraph batching benchmark

Measure independent `subgraph()` calls against two runtime-sized `batchOnce()`
arrays with the same roots and options. `batchOnceUnfused` uses the default
independent plans, while `batchOnceShared` passes `{ shareSubgraphs: true }`.
This separates one-statement batching from shared-root planning and hydration.

```bash
pnpm bench:subgraph-batch -- --roots=8 --depth=2 --branching=3 \
  --overlap=75 --projection=full --payload-bytes=256 --iterations=8

pnpm bench:subgraph-batch:postgres -- --postgres-driver=pg \
  --roots=8 --depth=2 --branching=3 --overlap=75
```

`--overlap` is the percentage of roots connected to the first root's tree.
`--projection=identity` excludes application payload fields. To model only
client-side roundtrip latency, add `--simulated-roundtrip-ms=N`. This delay is
injected before each `backend.execute` call and is reported separately; it is
not a substitute for a remote PostgreSQL run. Independent calls execute in
parallel, so their simulated delays may overlap.

Use a dedicated disposable database for PostgreSQL runs: the harness drops and
recreates public TypeGraph tables before every run. It rotates the three mode
orders across rounds and reports median and p95 elapsed time, raw timing
samples, statement count, client-observed aggregate backend duration, raw rows
and JSON-encoded row bytes returned at the backend boundary, and the process
heap delta. Server execution time and actual network wire bytes are explicitly
unobservable through `GraphBackend`.

The [remote Neon Oregon report](reports/subgraph-batch-neon-oregon-2026-09-15.md)
compares two 20-sample passes of overlapping full payloads, disjoint payloads,
and identity-only results against a pooled PostgreSQL service. It records the
client and server placement, an observed simple-query round trip, and the raw
latency distributions without publishing the connection string.
