# Seeded-regression proof: `identity-frontier-396`

This is the committed, curated record of the WS0 perf-harness workstream's
own goal loop (batch B6): seed a known, already-fixed cost regression into a
scratch worktree, then ask whether the harness this workstream built
(`bench:regression`, `tests/perf/explain/**`) actually catches it, at the
right severity, two independent ways. Produced by `pnpm bench:regression:proof
-- --seed=identity-frontier-396`
(`packages/benchmarks/src/regression-proof.ts`); the gitignored,
machine-generated artifacts for this specific run live at
`packages/benchmarks/reports/regression/proof-identity-frontier-396-2026-08-13/`
(`report.md`, `report.json`, `explain.json`, `proof-report.md`) and are
summarized here for the permanent record.

## Seed provenance

- Patch: `packages/benchmarks/etc/seeds/identity-frontier-396.patch`.
- Reverts `317f73d13177a6976cba79ac74588abfcda8f2e0` ("perf(query): bound
  current identity expansion by the frontier, not the closure"). Its parent,
  `2562fe083f6ce3f3541d6e1698015a185a36193e`, carries the #396/#432 shape the
  reverted commit fixed.
- Three files patched: `packages/typegraph/src/query/compiler/
  identity-traversal.ts`, `.../recursive.ts`,
  `.../emitter/standard-builders.ts`.
- Effect: restores the graph-wide `identity_peer_class` MATERIALIZED CTE at
  the *current* read coordinate — cost = sum of squares of every identity
  class in the graph — instead of `317f73d`'s frontier-seeded joins (seek the
  frontier row's class through the closure primary key, that class's members
  through the class index, each member's node through the nodes primary key).
  Semantics survive the seed (it is a shipped historical state); cost does
  not.
- Regenerate with (from repo root):

  ```sh
  git diff HEAD 317f73d^ -- \
    packages/typegraph/src/query/compiler/identity-traversal.ts \
    packages/typegraph/src/query/compiler/recursive.ts \
    packages/typegraph/src/query/compiler/emitter/standard-builders.ts \
    > packages/benchmarks/etc/seeds/identity-frontier-396.patch
  ```

## Worktrees

| Point | SHA | Notes |
| --- | --- | --- |
| base / tag (unseeded) | `d8865663778109304a71c0149bc76e3f90c0ce3b` | Two separate scratch worktrees (`bench:regression`'s own three-point model), both this same unseeded sha — the proof's `--tag=<sha> --base=<sha>` isolates the seed patch as the only variable. |
| candidate (seeded) | `d8865663778109304a71c0149bc76e3f90c0ce3b` (same commit; the patch is an uncommitted working-tree change) | `/tmp/typegraph-regression/d88656637781/candidate` — provisioned, patched via `git apply`, installed and built, then removed in the driver's `finally` block. |

`git apply --check` (run by `assertSeedPatchApplies` before any worktree was
touched) and the actual `git apply` inside the candidate worktree both
succeeded — confirmed by the run completing past that step; the seed patch
target files are unmodified in `packages/typegraph/src/query/compiler/`
outside the seeded worktree throughout (`git diff --stat -- packages/typegraph/src`
against this commit is empty).

## Timing half

Lane `identity-frontier`, backend `sqlite`. `bench:regression` compared the
seeded candidate against both baseline points (both the unseeded sha):

| Lane | Measurement | Baseline | baseline ms | candidate ms | ratio | classification |
| --- | --- | --- | --- | --- | --- | --- |
| identity-frontier | `identity-frontier:current-hop` | tag | 0.032 | 96.825 | 3027.20x | **failed** |
| identity-frontier | `identity-frontier:historical-hop` | tag | 1417.226 | 1447.302 | 1.02x | ok |
| identity-frontier | `identity-frontier:current-hop` | base | 0.030 | 96.825 | 3206.55x | **failed** |
| identity-frontier | `identity-frontier:historical-hop` | base | 1422.671 | 1447.302 | 1.02x | ok |

The seed moves only the label the fix touches (`current-hop`, the
current-coordinate compilation path `317f73d` changed): ~3,000-3,200x, far
past `failRatio` (2.0x) and `minAbsoluteDeltaMs` (0.5ms) — the correct
severity for a shape this workstream's own methodology doc measured at
~69,000x on the original fixture. `historical-hop` — the same hop pinned to
a valid-time coordinate, which always uses the historical reconstruction
path and was never touched by `317f73d` or its seed — stayed within 2% (a
measurement-noise band, not a regression), confirming the seed patches
exactly the current-coordinate path it claims to and nothing else.

`bench:regression` exited `2` (a hard failure is present). `--tag`/`--base`
both resolving to the same sha means every OTHER lane the default set would
have measured (`perf`, `write`, `identity`) was correctly excluded via
`--lanes=identity-frontier` — the proof's own lane, per §0's design.

**`judgeTimingProof` verdict: `proven`** — evidence: `0.030ms -> 96.825ms
(3206.55x, failed)` (the `base` baseline point, the seed's declared
`(laneId, baseline)` pair).

## Explain half

Invocation (inside the seeded worktree's `packages/typegraph`):

```sh
pnpm vitest run tests/perf/explain/identity-frontier-expansion.test.ts \
  --reporter=json --outputFile=<dir>/explain.json
```

| Case | Status | Diagnostic |
| --- | --- | --- |
| sqlite / reaches the target through an identity peer | **passed** | — (semantic case, I-SEED-SEMANTICS) |
| sqlite / seeks the identity closure from the frontier | **failed** | `assertPlanShape: required term SEARCH identity_seed_class USING INDEX sqlite_autoindex_typegraph_identity_closure_1 not found in [sqlite] frontier hop` — plan text opens with `MATERIALIZE identity_peer_class` instead (the reverted, graph-wide CTE) |
| postgres / reaches the target through an identity peer | **passed** | — (semantic case, I-SEED-SEMANTICS) |
| postgres / visits at most FRONTIER_ROW_CEILING rows expanding the frontier | **failed** | `assertRowCeiling: 60050.979999999996 visited rows exceeds ceiling 100 for [postgres] frontier hop` — 600x over the 100-row ceiling |

Both semantic cases (`reaches the target through an identity peer`) still
pass on both engines — the seed is a cost regression, never a semantic
break (I-SEED-SEMANTICS): the query still finds `target` through the
identity peer, it just pays the pre-`317f73d` cost to do it.

**`judgeExplainProof` verdict: `proven`** — evidence: "2 must-fail case(s)
failed with their declared diagnostics; 2 must-pass case(s) still passed".

## Combined verdict

```json
{
  "seedId": "identity-frontier-396",
  "timing": { "kind": "proven", "evidence": "0.030ms -> 96.825ms (3206.55x, failed)" },
  "explain": { "kind": "proven", "evidence": "2 must-fail case(s) failed with their declared diagnostics; 2 must-pass case(s) still passed" },
  "proven": true
}
```

`proofExitCode` returned `0`.

## Loop record

- **Cycle 1** (the only cycle needed): ran `bench:regression:proof
  --seed=identity-frontier-396` exactly as specced, against the batch's own
  code and fixture sizing (`UNRELATED_CLASS_COUNT=9`,
  `UNRELATED_CLASS_SIZE=200`). Both halves proved on the first attempt — no
  `--lane-timeout-ms` increase, no fixture enrichment, and no threshold or
  ceiling change was needed. The measured ratio (~3,200x) is nearly three
  orders of magnitude past `failRatio`, so the fixture sizing had ample
  margin; a separate manual check (**LANE-FIXTURE-SIZE**, below) confirms
  that margin is real, not accidental.

## Load-bearing evidence checks (manual, recorded here per §5)

- **SEED-PROOF** — the run recorded above IS this check: the seed patch
  itself drives the timing half to `failed` (3206.55x) and the explain half
  to two red cases with their exact declared diagnostics. This is the
  batch's goal condition, measured true.
- **LANE-FIXTURE-SIZE** — dropped `UNRELATED_CLASS_SIZE` from 200 to 5 (9
  classes of 5 members instead of 200; `seedRowsPerKind` 45 instead of
  1,800) and re-ran `bench:identity-frontier` directly (not through the full
  proof driver) on both the unseeded tree and a scratch worktree with the
  seed patch applied:
  - Unseeded `current-hop` median: 0.033206ms.
  - Seeded `current-hop` median: 0.121839ms.
  - Ratio: ~3.67x — numerically past `failRatio` (2.0x), but the absolute
    delta is 0.0886ms, **below** `minAbsoluteDeltaMs` (0.5ms). Per
    `policy.ts`'s `classifyRatio` (rule I2, checked before any ratio-based
    severity), this measurement classifies as `below-noise-floor`, not
    `failed` or even `flagged` — the seed would be reported as **no
    regression at all** at this fixture size, regardless of what the raw
    ratio of two noise-scale numbers suggests. This is the sharper form of
    the check the spec anticipated (a ratio "falling below `failRatio`"):
    at `UNRELATED_CLASS_SIZE=5` the seed's absolute signal never clears the
    noise floor, so it goes undetected by the harness's own policy — proving
    `UNRELATED_CLASS_SIZE=200` (whose delta, ~96.8ms, clears the floor by
    two orders of magnitude) is load-bearing, not an arbitrary round number.
    Restored to `UNRELATED_CLASS_SIZE=200` (the committed value) immediately
    after this check via `cp` from a pre-edit backup + `cmp` byte-identical
    verification (never `git checkout --`); the two spurious history rows
    this check produced (unseeded-size-5 in this worktree, and the seeded
    scratch worktree's own separate history file) were identified by their
    `seedRowsPerKind: 45` signature and removed — only the two legitimate
    unseeded, committed-fixture-size (`seedRowsPerKind: 1800`) smoke rows
    (SQLite and PostgreSQL) remain in `reports/history.jsonl`.

## Reproduce

```sh
pnpm --filter @nicia-ai/typegraph-benchmarks bench:regression:proof -- --seed=identity-frontier-396
```

## Deviation from context-ws0 decision 1 (documented, not escalated)

`context-ws0.md`'s decision 1 states the timing lane runs on the EC2 runner
(B5). This proof's timing leg instead ran locally on SQLite (and was
separately smoke-tested on PostgreSQL against the docker-compose server —
see the commit body): no AWS credentials exist in this environment (B5's own
notes state this explicitly), and the seeded signal here is an
orders-of-magnitude effect (~3,200x, consistent with the historical
~69,000x measurement this harness's methodology doc cites), not a
20%-threshold judgment call that needs controlled EC2 hardware to trust.
