# EC2 Regression Lane

Runs `bench:regression` (see [`regression-mode.md`](regression-mode.md)) on a
dedicated, ephemeral EC2 instance instead of locally — the runner behind the
`Perf Timing Lane` GitHub Actions workflow
(`.github/workflows/perf-timing-lane.yml`). It reuses the SSM plumbing built
for the SNB EC2 runner (`docs/ec2-benchmark-runner.md`,
`src/real/ec2/{aws-cli,bootstrap-common,ssm-run}.ts`) rather than a second AWS
client — the only new code is the regression-specific bootstrap tail, the
remote run script, and the artifact/verdict decisions
(`src/regression/ec2/*.ts`).

## Two subcommands

```bash
# Provisions the instance, confirms bootstrap, starts bench:regression in
# the background, and prints a launch.json path plus the exact collect
# invocation. It writes instance.json immediately after allocation so a
# later bootstrap/SSM failure still leaves the workflow a termination handle:
pnpm --filter @nicia-ai/typegraph-benchmarks bench:regression:ec2 -- \
  --region=us-west-2 \
  --subnet-id=<your-subnet-id> \
  --security-group-id=<your-security-group-id> \
  --iam-instance-profile=<your-instance-profile-name>

# Polls until the run finishes, fetches each backend's report, judges the
# run, writes reports locally, and terminates the instance:
pnpm --filter @nicia-ai/typegraph-benchmarks bench:regression:ec2:collect -- \
  --launch-json=packages/benchmarks/reports/regression/ec2-<run-id>/launch.json
```

`collect` also accepts `--instance-id=<id> --command-id=<id> [--run-id=<id>]
[--backend=...]` directly instead of `--launch-json`, but the two forms are
mutually exclusive and `--instance-id`/`--command-id` must be supplied
together.

## Why the bootstrap does a full clone

`bench:regression`'s default baselines are `git tag --list
'@nicia-ai/typegraph@*'` (the last published tag) and `git merge-base
<candidate> main` (the PR base) — both need the full tag set and a resolvable
`main`, which the SNB runner's `git fetch --depth 1` + `checkout FETCH_HEAD`
cannot provide. This bootstrap instead does a full `git clone` (no `--depth`,
no `--single-branch`) and then `git checkout <ref>`, followed by a guard that
fails the bootstrap loudly — `git rev-parse --verify main` and `test -n
"$(git tag --list '@nicia-ai/typegraph@*')"` — rather than discovering hours
into a run that a baseline can't resolve.

## Flags

`launch` (required): `--region`, `--subnet-id`, `--security-group-id`,
`--iam-instance-profile`.

`launch` (optional): `--aws-profile`, `--instance-type` (default
`c7i.2xlarge` — these are single-threaded latency measurements, not SNB's
memory-proportional bulk load, so SNB's `c7i.4xlarge`/`r7i.4xlarge` defaults
don't apply), `--volume-size-gib` (default 100), `--volume-iops` (default
10000), `--volume-throughput-mbps` (default 400 — IOPS/throughput copied from
the SNB defaults because gp3 baseline was a measured bottleneck for SQLite
checkpoint I/O; timing measurements must not inherit that noise), `--repo-url`
(default `https://github.com/nicia-ai/typegraph.git`), `--ref` (default: the
invoking checkout's own `HEAD` SHA — must already be pushed), `--postgres-image`
(default `pgvector/pgvector:pg18`, matching CI's `test-postgres` service),
`--backend` (`sqlite`, `postgres`, or `both`; default `sqlite`), `--lanes`,
`--base`, `--tag`, `--feature-baseline` (all passed through to the remote
`bench:regression` invocation, omitted entirely when not given —
`bench:regression`'s own CLI would read an empty `--flag=` as an explicit,
wrong empty-string ref), `--lane-timeout-ms` (default 900000),
`--bootstrap-timeout-seconds` (default 2400 — apt + optional Docker + Node +
a full-history clone + install + build), `--run-timeout-seconds` (default
14400 — three lanes across up to four worktrees and two backends, each
worktree installing and building, kept under the workflow's 330-minute job
ceiling with a buffer), `--ssh-public-key-path` and `--associate-public-ip`
(diagnostic SSH fallback, see `docs/ec2-benchmark-runner.md`), `--output`
(local report directory; default
`packages/benchmarks/reports/regression/ec2-<run-id>`, already gitignored).

`collect` (required): exactly one of `--launch-json=<path>` or
`--instance-id`+`--command-id` together.

`collect` (optional): `--region`/`--aws-profile` (override the launch
record's), `--run-id`/`--backend` (only meaningful with
`--instance-id`/`--command-id`), `--poll-interval-seconds` (default 60),
`--keep`, `--output` (with `--launch-json`, defaults to the exact directory
`launch` wrote `launch.json` into, so fetched reports always land alongside
it even when `launch` was given a non-default `--output`; with
`--instance-id`/`--command-id` there is no launch record to read a directory
from, so it falls back to `packages/benchmarks/reports/regression/ec2-<run-id>`
using whatever `--run-id` was passed).

## The Postgres leg

Requesting `--backend=postgres`/`both` makes the bootstrap install Docker and
start a `pgvector/pgvector:pg18` container (`typegraph-regression-postgres`,
matching CI's `test-postgres` service), with a bounded `pg_isready` loop that
fails the bootstrap if the container never becomes healthy. The remote run
script exports `POSTGRES_URL` pointing at that container only when a postgres
leg was requested.

## Artifact transport and the SSM character cap

Each backend's `report.md`/`report.json` is fetched through its own SSM
command as `gzip -c <path> | base64 -w0` — the same 24,000-character
`StandardOutputContent` cap that forced the SNB runner to split its own
result artifacts across separate commands applies here too, and a
compressed-then-truncated payload fails decode outright (a gzip CRC
mismatch) rather than silently producing a short report. A decode failure
for one backend is recorded as an unfetched backend and does not abort
fetching the others.

## Judging a run

`judgeRemoteRun` (`src/regression/ec2/collect-verdict.ts`) is the single
decision `collect` prints and exits by:

- Any requested backend whose report could not be fetched is a hard failure.
- No readable exit code from the remote run's stdout is a hard failure.
- A remote exit code of `1` or `2` is read through as that code **even when
  the SSM command's own status is `Failed`** — `bench:regression` exiting
  nonzero because it measured a real regression makes SSM report the shell
  script itself as failed, which is not the same thing as the run breaking.
- Any other non-`Success` SSM status (`TimedOut`, `Cancelled`, …) is a hard
  failure.
- A `Success` status with exit code `0` is clean.

## Cost safety net

Same dead-man's-switch mechanism as the SNB runner
(`docs/ec2-benchmark-runner.md`'s "Cost safety net"): the bootstrap schedules
a `shutdown` timed to comfortably outlive both the bootstrap and run
timeouts. `collect`'s `finally` always terminates the instance (unless
`--keep`), including failures during the first SSM poll. The GitHub Actions
workflow adds a best-effort backstop that reads the early `instance.json`
record when launch failed before `launch.json` or `collect`; it is skipped for
an explicit `keep=true` dispatch.

## Verifying the pipeline cheaply

Before trusting a full run, run once with `--lanes=perf --backend=sqlite` —
the smallest lane/backend combination — to confirm bootstrap, the run
script, artifact fetch, and termination all work end-to-end before spending
hours (and the AWS bill that comes with it) on the full lane set.

## The GitHub Actions workflow

`.github/workflows/perf-timing-lane.yml` drives this runner on
`workflow_dispatch`, a weekly schedule, and the `perf-lane` PR label — see
[`docs/TESTING.md`](../../../docs/TESTING.md)'s "Performance timing lane
(EC2)" section for the full trigger and mandatory-by-policy rules. It reads
its AWS configuration from repository variables
(`PERF_LANE_AWS_REGION`, `PERF_LANE_SUBNET_ID`, `PERF_LANE_SECURITY_GROUP_ID`,
`PERF_LANE_IAM_INSTANCE_PROFILE`) and an OIDC role secret
(`PERF_LANE_AWS_ROLE_ARN`), failing its preflight step listing every missing
one rather than attempting an AWS call with a partial configuration. A fork
PR labeled `perf-lane` is refused outright (`refuse-fork-label`) — it has no
access to this repository's OIDC role — with a message pointing at
`workflow_dispatch` instead.
