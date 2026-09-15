# Subgraph batching: remote Neon PostgreSQL measurement

Measured on 2026-09-15 from a Codex desktop host whose observed public egress
geolocated to Bend, Oregon, against an exclusive Neon pooled endpoint in AWS
us-west-2 (Oregon). The database ran PostgreSQL 18.6 and the client used
node-postgres. The egress lookup describes the observed network exit, not a
verified physical location of the desktop. This is a real remote PostgreSQL
connection, without injected delay, but it is a same-region placement and does
not represent every deployment route.

The benchmark used eight roots, depth two, and branching factor two. Each shape
was run twice: overlap, disjoint, identity-only in the first pass, then the
reverse order. Each run reseeded the dedicated database, used three warmup
rounds and 20 measured rounds per mode, and rotated the order of `direct`,
default `batchOnce()`, and opt-in shared `batchOnce()` within each round. The
table combines 40 elapsed-time samples per shape and mode. Its p95 uses linear
interpolation between sorted samples. [Raw timing samples](./subgraph-batch-neon-oregon-2026-09-15.json)
preserve both passes separately.

| Shape | Mode | p50 elapsed | p95 elapsed | Statements | Raw rows | Encoded returned bytes |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 75% overlap, full 2,048-byte payload | Concurrent direct reads | 74.84 ms | 100.85 ms | 24 | 115 | 174,385 |
| Same | Default `batchOnce()` | 43.40 ms | 149.99 ms | 1 | 8 | 182,259 |
| Same | Shared `batchOnce()` | 30.85 ms | 121.72 ms | 1 | 1 | 130,226 |
| Disjoint, full 256-byte payload | Concurrent direct reads | 73.55 ms | 106.32 ms | 24 | 160 | 58,952 |
| Same | Default `batchOnce()` | 42.42 ms | 125.38 ms | 1 | 8 | 69,961 |
| Same | Shared `batchOnce()` | 34.10 ms | 106.10 ms | 1 | 1 | 84,363 |
| 75% overlap, identity-only projection | Concurrent direct reads | 72.34 ms | 81.71 ms | 24 | 115 | 17,900 |
| Same | Default `batchOnce()` | 42.47 ms | 68.15 ms | 1 | 8 | 21,741 |
| Same | Shared `batchOnce()` | 31.11 ms | 55.38 ms | 1 | 1 | 23,840 |

A separate reused pooled connection completed 20 measured sequential `SELECT 1`
calls after three warmups with a 24.34 ms p50 and 25.86 ms p95. That time
includes the client, pooler, network, and trivial SQL; it is not a server-only
execution measurement.

Default batching reduced median elapsed time relative to concurrent direct calls
in every shape, consistent with its one-statement execution. With overlapping
full payloads, opt-in sharing was 29% faster at the median than default batching
and returned 29% fewer encoded bytes. With disjoint roots it was 20% faster at
the median but returned 21% more bytes; with identity-only projections it was
27% faster but returned 10% more bytes. Sharing's latency advantage therefore
does not imply a transfer advantage. The overlapping full-payload p95 also
remained above direct reads despite its lower median, illustrating why a small
synthetic sample does not establish a universal tail-latency winner.

This evidence supports keeping independent bounded subgraphs in one default
`batchOnce()` call and trying `{ shareSubgraphs: true }` when overlapping
neighborhoods repeat substantial projected properties. It does not justify
changing the default: this is one pooled service, one same-region client route,
one small graph shape, and 40 samples per mode. Server execution time and
database-protocol wire bytes were not observed. `Encoded returned bytes` is the
UTF-8 JSON size of raw rows at the `GraphBackend.execute` boundary; independent
direct calls run concurrently, so summed backend durations can exceed elapsed
wall time.

To reproduce a shape, set `POSTGRES_URL` to a **dedicated disposable PostgreSQL database** and run, for example:

```bash
pnpm --filter @nicia-ai/typegraph-benchmarks bench:subgraph-batch:postgres -- \
  --postgres-driver=pg --roots=8 --depth=2 --branching=2 \
  --overlap=75 --projection=full --payload-bytes=2048 \
  --iterations=20 --warmup=3
```

Use `--overlap=0 --payload-bytes=256` for disjoint full results, or
`--projection=identity` with the first shape's overlap and stored payload size.
The harness **drops and recreates public TypeGraph tables** before each run, so
it must never target a shared application database. The two passes reported
here used no `--simulated-roundtrip-ms` option.
