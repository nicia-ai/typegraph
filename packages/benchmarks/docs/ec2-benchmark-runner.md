# EC2 Benchmark Runner (SNB Lane 1)

Runs the exact same SNB Lane 1 short-read benchmark
(`src/real/snb-short-reads.ts`) on a dedicated, ephemeral EC2 instance
instead of your local machine. Useful when local hardware is contended
(background backups, Docker Desktop sharing memory/CPU with unrelated
projects) or when a stable, reproducible hardware profile matters more than
laptop convenience.

No new benchmark logic lives here — the runner provisions a box, clones this
repo at a given ref, installs Docker/Node/pnpm, downloads the official LDBC
dataset, runs the unmodified `pnpm bench:snb:<profile> --check`, and pulls
the results back into your local `bench-results/` and
`reports/history.jsonl`.

## Access model: SSM by default, SSH as an opt-in diagnostic fallback

The runner's default and only required control channel is **AWS Systems
Manager (SSM) Run Command** — `aws ssm send-command` / `get-command-invocation`.
This is a deliberate choice, not just a workaround: it needs no inbound
firewall rule and no key-pair distribution, which is generally the more
portable and secure default for both a locked-down account and a stranger's
own AWS account.

**Prerequisite:** whatever IAM instance profile you pass via
`--iam-instance-profile` must have the AWS-managed
`AmazonSSMManagedInstanceCore` policy attached, and the instance's subnet
must be able to reach the SSM service (either through NAT/IGW internet
egress, or through VPC interface endpoints for `ssm`, `ssmmessages`, and
`ec2messages` if the subnet is fully private).

**Diagnostic-only SSH fallback:** SSM is itself the thing that can fail
(agent connectivity loss, instance network impairment) — precisely when you
most need shell access. Pass `--ssh-public-key-path=<path>` to `launch` to
have the bootstrap script append that key to the `ubuntu` user's
`authorized_keys` before anything else runs. This does **not** open port 22
for you — the caller is responsible for adding (and later removing) an
ingress rule on the security group, scoped as narrowly as possible (e.g. a
single `/32`). Treat this as break-glass, not a standing configuration.

## Usage

```bash
# Kick off a run (fast — provisions, bootstraps, starts the benchmark, exits):
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:sf1:ec2 -- \
  --region=us-west-2 \
  --subnet-id=<your-subnet-id> \
  --security-group-id=<your-security-group-id> \
  --iam-instance-profile=<your-instance-profile-name> \
  --profile=sf1

# Prints an instance id, a command id, and the exact `collect` invocation to
# run next. The benchmark itself can take hours; collect polls until done:
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:sf1:ec2:collect -- \
  --region=us-west-2 \
  --instance-id=<printed-instance-id> \
  --command-id=<printed-command-id> \
  --profile=sf1 \
  --run-id=<printed-run-id>
```

`collect` writes results to
`bench-results/current/snb-<profile>-ec2-<run-id>/`, appends the new lines
to `reports/history.jsonl`, and terminates the instance when done. Pass
`--keep` to leave the instance running for debugging instead.

### Flags

`launch` (required): `--region`, `--subnet-id`, `--security-group-id`,
`--iam-instance-profile`.

`launch` (optional): `--aws-profile` (SSO/named profile; omit to use the
instance-metadata credential chain or a role already assumed in the shell),
`--instance-type` (default `c7i.4xlarge`), `--volume-size-gib` (default
150), `--repo-url` (default `https://github.com/nicia-ai/typegraph.git` —
point this at your fork), `--ref` (default: your local `git rev-parse
HEAD` — **must already be pushed** to `--repo-url`, since the instance does
a fresh clone), `--profile` (`smoke`, `sf1`, or `sf10`; default `sf1`),
`--bootstrap-timeout-seconds` (default 1800), `--benchmark-timeout-seconds`
(defaults per profile: smoke 3600, sf1 36000 — a real SF1 run's
sqlite+postgres+neo4j load phases alone took ~2.6h pre-fix, so a 6h default
proved too tight in practice — sf10 129600 / 36h, deliberately generous
since SF10 is ~10x SF1's row counts with no direct measurement yet of how
each engine's load time actually scales), `--ssh-public-key-path` (see
"Diagnostic-only SSH fallback" above; omit for the SSM-only default).

`collect` (required): `--region`, `--instance-id`, `--command-id`.

`collect` (optional): `--aws-profile`, `--profile` (default `sf1`),
`--run-id`, `--keep`, `--poll-interval-seconds` (default 60).

### Verifying the pipeline cheaply

Before committing to a multi-hour SF1 run, run the whole pipeline once
against `--profile=smoke` (finishes in minutes) to confirm bootstrap,
result-parsing, and termination all work end-to-end before spending hours
on the real dataset.

## Nicia's own AWS setup (worked example)

Region `us-west-2`, account `nicia-production` (SSO profile). There's a
purpose-built `nicia-sandbox-vpc` (OpenTofu-managed) with a host security
group and instance profile already scoped for exactly this kind of ephemeral
benchmark box:

```bash
pnpm --filter @nicia-ai/typegraph-benchmarks bench:snb:sf1:ec2 -- \
  --region=us-west-2 \
  --aws-profile=nicia-production \
  --subnet-id=subnet-02087a7c22913a9f0 \
  --security-group-id=sg-036dfba5f212286da \
  --iam-instance-profile=nicia-sandbox-host-profile \
  --profile=sf1
```

The sandbox's host security group intentionally has **no inbound SSH** (only
`8443`/`443` for an unrelated internal orchestrator API) — SSM is the only
way in, which is exactly what this runner uses. Don't reuse an
already-running instance from another project's benchmark run (check
`aws ec2 describe-instances --filters Name=tag:Project,Values=...` first) —
each run launches its own instance tagged `Project=TypeGraphBenchmark`.

## Cost safety net

If `collect` is never run, the instance keeps billing. The bootstrap script
schedules a `shutdown` dead-man's switch as soon as it starts, so a
forgotten run self-terminates instead of running forever. Its duration is
derived from `--bootstrap-timeout-seconds` + `--benchmark-timeout-seconds`
plus a one-hour buffer (defaults: 30min + 10h + 1h = 11.5h) — deliberately
longer than the benchmark's own SSM `executionTimeout`, so this "nobody
ever collected" safety net can never race a benchmark that's still
legitimately running (an earlier version hardcoded a flat 6h, which was
long enough to kill a real SF1 run in its last minutes). `collect`'s
explicit termination makes the dead-man's switch moot on the happy path —
but if you walk away mid-run, don't assume the box is gone until either
`collect` finishes or that window has passed.

## Deliberate scope cuts (v1)

- **No S3.** Results are small structured JSON (a few KB across 4 engines),
  so they travel through SSM command stdout directly rather than needing an
  S3 bucket, bucket policy, or KMS key.
- **No standing SSH/key-pair management.** SSM remains the only *required*
  path, matching the account's own hardening; `--ssh-public-key-path` is an
  opt-in, break-glass diagnostic fallback (see "Diagnostic-only SSH
  fallback" above), not a second first-class control channel.
- **No auto-scaling/spot/reuse logic.** Every run is a fresh instance,
  terminated at the end.

If you need any of these, they're extensions, not redesigns.
