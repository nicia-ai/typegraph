/**
 * Neo4j engine driver — the competitor for the "server pairing" (vs
 * TypeGraph/PostgreSQL) in the LDBC SNB Interactive short-read benchmark
 * (docs/design/benchmark-program-plan.md, Lane 1). Launches its own
 * throwaway container imperatively (`docker run` + a named volume for
 * `/data` + a harness-allocated free port) — never an ambient daemon or
 * compose file — the same way `../harness/postgres-container.ts` does for
 * the TypeGraph/PostgreSQL side of that pairing. `/data` is disk-backed
 * (not tmpfs): real LDBC SF1 data plus constraint indexes overflows a
 * laptop-sized Docker VM's RAM (observed on an 8GB VM), the same lesson
 * the sibling braiddb project's own Neo4j driver documents.
 *
 * Unlike TypeGraph (which needs an artificial ontological `Message`
 * supertype so the polymorphic replyOf chain can be walked with one
 * recursive query — see `../schema/snb-graph.ts`), Neo4j nodes carry BOTH
 * `:Message` and their concrete `:Post`/`:Comment` label natively. That means
 * every query below that reads "a message by id" (IS4/IS5/IS6/IS7's parent
 * lookup, IS2's per-message root walk) matches on the single `:Message`
 * label — backed by one `Message(id)` uniqueness constraint — instead of
 * dispatching on `MessageRef.kind` the way the TypeGraph reference driver
 * (`./typegraph-queries.ts`) has to. `REPLY_OF*1..100` variable-length paths
 * and `OPTIONAL MATCH ... coalesce(...)` walk to the root Post uniformly
 * whether the input is already a Post (no outgoing REPLY_OF edges, so the
 * walk finds nothing and `coalesce` falls back to the input itself) or a
 * Comment (the walk lands on exactly one Post, since only Comments appear
 * as interior nodes of a reply chain).
 *
 * Load path: OFFLINE `neo4j-admin database import full`, run as a one-off
 * `docker run` against the same named `/data` volume BEFORE the long-running
 * server container ever starts. Neo4j's own documentation recommends this
 * over online Cypher writes once a load exceeds roughly 10M records into an
 * empty database — this benchmark's SF1 scale (~9,892 persons, ~1M posts,
 * ~2M comments, plus every relationship kind) is well past that threshold,
 * and the batched `UNWIND ... IN TRANSACTIONS OF 5000 ROWS` writes this
 * driver used previously are not how Neo4j itself recommends loading a
 * dataset this size. The LDBC CSVs streamed by `../dataset/ldbc-csv.ts`
 * aren't in neo4j-admin's own import shape, so `stageSnbDatasetForNeo4jImport`
 * below re-stages every node/edge kind into neo4j-admin's CSV header
 * conventions first (`:ID`, `:START_ID`/`:END_ID`, `name:string` property
 * columns — see
 * https://neo4j.com/docs/operations-manual/current/tools/import/): every
 * property is explicitly typed `:string`, never left to infer or coerce to
 * a native `date`/`int` type, so an imported property is byte-identical to
 * what the retired Cypher `CREATE` path produced — a native Neo4j date/
 * datetime property would round-trip through neo4j-driver as a different JS
 * type than the plain ISO-8601 string every other engine returns for the
 * same field, silently breaking the IS4/IS5 content/creationDate
 * comparison. Every entity id streamed out of `ldbc-csv.ts` is already
 * globally unique and prefixed by kind (`person:123`, `message:456`,
 * `forum:789`), so every node file shares one flat, unnamed `:ID` space
 * instead of needing per-kind id-space qualifiers — confirmed empirically
 * against the pinned image (`NEO4J_IMAGE`) before trusting it at SF1 scale.
 * Post/Comment nodes get BOTH labels directly from the `--nodes=
 * Post:Message=...`/`--nodes=Comment:Message=...` CLI arguments (also
 * confirmed empirically: `neo4j-admin` retains both labels on the same
 * node, and an `:ID` column named `id` is ALSO retained as a regular
 * queryable node property, not consumed purely for import-time id
 * resolution). The importer aborts loudly (non-zero exit, so
 * `spawnCapture` rejects) on any dangling relationship endpoint or
 * malformed row by default — no silent `--skip-bad-relationships`/
 * `--skip-duplicate-nodes` opt-in here, so a bad row fails the load instead
 * of quietly shrinking the graph.
 *
 * Offline import resolves every relationship by id directly against its own
 * import-time id index, never via a Cypher `MATCH` — so, unlike the old
 * batched-UNWIND load, the schema constraints below no longer need to exist
 * *during* the load to avoid a label-scan blowup (see `ensureSchema`'s own
 * doc comment). They're still created (and awaited ONLINE) right after the
 * server starts, purely so IS1-IS7's by-id lookups are index-backed at
 * query time.
 *
 * Container construction happens inside `load()` (not the factory), so
 * `loadMs` reflects the full Neo4j setup cost the same way braiddb's
 * reference driver measures it: CSV staging + the offline import + server
 * container startup + constraint creation, fairly comparable to the other
 * engines.
 *
 * Heap/page-cache sizing (`resolveNeo4jMemorySettings`) is host-aware, not a
 * flat constant: it shells out to neo4j-admin's own `server
 * memory-recommendation --docker` for the memory actually visible to the
 * Docker daemon (NOT necessarily `os.totalmem()` — Docker Desktop's VM can
 * expose far less RAM than the host it runs on; the two coincide on a
 * dedicated Linux host with no such VM, which is how this benchmark's
 * published numbers are actually captured), falling back to a documented
 * heuristic split if that command is ever unavailable. Every engine in this
 * lane tears its container down before the next one starts (see
 * `../snb-short-reads.ts`'s `runEngine`, which always calls `handle.close()`
 * in a `finally` before the next engine's factory runs), so Neo4j is free
 * to claim most of the host's memory during its own phase without starving
 * a neighbor.
 */
import { createWriteStream } from "node:fs";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { totalmem, tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import {
  spawnCapture,
  spawnStatus,
  stringifyError,
  freePort,
} from "../harness/process";
import { NEO4J_IMAGE } from "../harness/doctor";
import {
  streamSnbCsvDataset,
  type SnbCommentRow,
  type SnbForumRow,
  type SnbIdPools,
  type SnbPersonRow,
  type SnbPostRow,
} from "../dataset/ldbc-csv";
import {
  type MessageRef,
  type SnbEngineFactory,
  type SnbEngineHandle,
  type SnbQueries,
} from "./types";

// The published `neo4j-driver` .d.ts hand-rolls a subset of the driver
// surface (e.g. its `auth` export omits `auth.none()`, which the underlying
// neo4j-driver-core module has at runtime) — the "untyped default export"
// this program's plan calls out. We sidestep it entirely below by never
// passing an auth token: the container runs with `NEO4J_AUTH=none`, and
// `neo4j.driver(url)` with no token defaults to the `{ scheme: "none" }`
// token internally, so no cast is needed for authentication.
import neo4j, { type Driver, type Session } from "neo4j-driver";

const NEO4J_DATABASE = "neo4j";
const NEO4J_BOLT_PORT = 7687;

const CONTAINER_READY_TIMEOUT_MS = 120_000;
const CONTAINER_POLL_INTERVAL_MS = 1_000;

const ROOT_WALK_MAX_HOPS = 100;
const IS2_MESSAGE_LIMIT = 10;

// ---- Memory sizing ----

/**
 * Bytes visible to the Docker daemon itself — NOT necessarily `os.totalmem()`.
 * On Docker Desktop (macOS/Windows), containers run inside a capped Linux VM
 * that can expose far less RAM than the host physically has (observed on a
 * development machine: a 48GiB host exposing only ~7.8GiB to Docker's VM via
 * `docker info`). Sizing Neo4j's heap/page cache off the wrong number risks
 * either starving it on real headroom or having a virtualization layer OOM-
 * kill it for memory it was never told it didn't have. On a dedicated Linux
 * host with no such VM (e.g. the EC2 instance this benchmark's published
 * numbers come from), Docker runs directly against the host and this value
 * coincides with `os.totalmem()`.
 */
async function resolveDockerVisibleMemoryBytes(): Promise<number> {
  try {
    const output = await spawnCapture("docker", [
      "info",
      "--format",
      "{{.MemTotal}}",
    ]);
    const bytes = Number(output.trim());
    if (Number.isFinite(bytes) && bytes > 0) return bytes;
  } catch {
    // Fall through to the Node-visible host total below.
  }
  return totalmem();
}

type Neo4jMemorySettings = Readonly<{
  heapSize: string;
  pageCacheSize: string;
}>;

const MIN_OS_RESERVE_BYTES = 4 * 1024 ** 3;
const OS_RESERVE_FRACTION = 0.2;

/**
 * Fallback only: reserve the larger of 4GiB or 20% of total memory for OS/
 * Docker/JVM native overhead (the same categories neo4j-admin's own
 * `memory-recommendation` output calls out — Lucene, Netty, the operating
 * system), then split what's left evenly between heap and page cache. Only
 * used if neo4j-admin's own recommendation (below) is unavailable or its
 * output doesn't parse.
 */
function heuristicMemorySettings(totalBytes: number): Neo4jMemorySettings {
  const reserve = Math.max(
    MIN_OS_RESERVE_BYTES,
    totalBytes * OS_RESERVE_FRACTION,
  );
  const usable = Math.max(totalBytes - reserve, MIN_OS_RESERVE_BYTES);
  const perPoolMebibytes = Math.floor(usable / 2 / 1024 ** 2);
  const size = `${perPoolMebibytes}m`;
  return { heapSize: size, pageCacheSize: size };
}

function formatGiB(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
}

const MEMORY_RECOMMENDATION_LINE =
  /^NEO4J_server_memory_(heap_max__size|pagecache_size)='([^']+)'$/;

/**
 * Preferred sizing path: shell out to neo4j-admin's own `server
 * memory-recommendation --docker`, which prints authoritative
 * `NEO4J_server_memory_*` env-var assignments for a given amount of memory
 * — the same heuristic Neo4j's own operations documentation recommends
 * over hand-rolling a split, already in the exact env-var shape
 * `runNeo4jContainer` needs. Falls back to `heuristicMemorySettings` if the
 * command errors or its output doesn't parse (e.g. a future image drops
 * `--docker` support).
 */
async function resolveNeo4jMemorySettings(
  log: (message: string) => void,
): Promise<Neo4jMemorySettings> {
  const totalBytes = await resolveDockerVisibleMemoryBytes();
  try {
    const output = await spawnCapture("docker", [
      "run",
      "--rm",
      NEO4J_IMAGE,
      "neo4j-admin",
      "server",
      "memory-recommendation",
      `--memory=${Math.floor(totalBytes)}`,
      "--docker",
    ]);
    const found = new Map<string, string>();
    for (const line of output.split("\n")) {
      const match = MEMORY_RECOMMENDATION_LINE.exec(line.trim());
      if (match) found.set(match[1]!, match[2]!);
    }
    const heapSize = found.get("heap_max__size");
    const pageCacheSize = found.get("pagecache_size");
    if (heapSize !== undefined && pageCacheSize !== undefined) {
      log(
        `neo4j-admin memory-recommendation (${formatGiB(totalBytes)} visible to docker): ` +
          `heap=${heapSize} pagecache=${pageCacheSize}`,
      );
      return { heapSize, pageCacheSize };
    }
    log(
      "neo4j-admin memory-recommendation output did not parse as expected; " +
        "falling back to heuristic memory sizing",
    );
  } catch (error) {
    log(
      `neo4j-admin memory-recommendation unavailable (${stringifyError(error)}); ` +
        "falling back to heuristic memory sizing",
    );
  }
  const fallback = heuristicMemorySettings(totalBytes);
  log(
    `heuristic memory sizing (${formatGiB(totalBytes)} visible to docker): ` +
      `heap=${fallback.heapSize} pagecache=${fallback.pageCacheSize}`,
  );
  return fallback;
}

// ---- Container lifecycle ----

/**
 * `/data` lives on a named docker volume (disk-backed), not a tmpfs. A
 * tmpfs is RAM-backed by the Docker VM, and real LDBC SF1 data plus
 * constraint indexes overflows a laptop-sized Docker VM — the same
 * "no space left on device" failure mode observed against the
 * TypeGraph/PostgreSQL container's tmpfs on an 8GB VM, and the exact
 * reason the sibling braiddb project's own Neo4j driver switches off
 * tmpfs for anything but its tiny synthetic profile. `/logs` and `/tmp`
 * stay tmpfs — their contents never scale with dataset size.
 */
async function runNeo4jContainer(
  containerName: string,
  dataVolume: string,
  port: number,
  memorySettings: Neo4jMemorySettings,
): Promise<void> {
  await spawnCapture("docker", ["volume", "create", dataVolume]);
  await spawnCapture("docker", [
    "run",
    "-d",
    "--name",
    containerName,
    "-p",
    `127.0.0.1:${port}:${NEO4J_BOLT_PORT}`,
    "-v",
    `${dataVolume}:/data`,
    "--tmpfs",
    "/logs:rw,size=256m",
    "--tmpfs",
    "/tmp:rw,exec,size=256m",
    "-e",
    "NEO4J_AUTH=none",
    "-e",
    `NEO4J_server_memory_heap_initial__size=${memorySettings.heapSize}`,
    "-e",
    `NEO4J_server_memory_heap_max__size=${memorySettings.heapSize}`,
    "-e",
    `NEO4J_server_memory_pagecache_size=${memorySettings.pageCacheSize}`,
    NEO4J_IMAGE,
  ]);
}

/**
 * Poll until the container accepts bolt connections, or throw (with the
 * container's logs) if it exits first. Mirrors braiddb's
 * `waitForNeo4jStarted`/`waitForNeo4jBolt` pair, collapsed into one loop.
 */
async function waitForNeo4jBolt(
  containerName: string,
  driver: Driver,
): Promise<void> {
  const deadline = Date.now() + CONTAINER_READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const inspect = await spawnStatus(
      "docker",
      ["inspect", "-f", "{{.State.Status}}", containerName],
      10_000,
    );
    const state = inspect.stdout.trim();
    if (state === "exited" || state === "dead") {
      const logs = await spawnCapture("docker", [
        "logs",
        "--tail",
        "100",
        containerName,
      ]).catch(() => "");
      throw new Error(
        `Neo4j container exited before it accepted bolt connections: ${logs}`,
      );
    }

    const session = driver.session({ database: NEO4J_DATABASE });
    try {
      await session.run("RETURN 1");
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await session.close().catch(() => undefined);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, CONTAINER_POLL_INTERVAL_MS),
    );
  }
  throw new Error(
    `Neo4j did not accept bolt connections within ${CONTAINER_READY_TIMEOUT_MS}ms: ${stringifyError(lastError)}`,
  );
}

/**
 * Unique constraints on Person/Message/Post/Comment/Forum(id), awaited
 * ONLINE right after the server starts — but AFTER every node and
 * relationship is already in place, unlike the retired batched-Cypher load
 * path this replaced. The offline `neo4j-admin database import` (module doc
 * / `runNeo4jAdminImport` below) resolves every relationship against its own
 * id index at import time, never via a Cypher `MATCH`, so these constraints
 * aren't needed to avoid a load-time label-scan the way they used to be.
 * They're still required here so IS1-IS7's by-id lookups below are
 * index-backed at query time, matching the pk btrees the SQL-backed engines
 * get (same-index fairness, docs/design/benchmark-program-plan.md).
 *
 * No `Message(creationDate)` index: a prior version created one, but a
 * dedicated query-plan audit (`PROFILE` against every IS1-IS7 query at real
 * scale) confirmed it's never chosen by any of them — every message access
 * goes through the `Message(id)`/`Post(id)`/`Comment(id)` uniqueness
 * constraints, since IS2's "recent messages" ordering happens over an
 * already-small, already-fetched candidate set, not as an index-driven scan.
 * Keeping an unused index would only add write-time cost during the load
 * with zero query-time benefit, which is exactly the kind of asymmetry a
 * fair comparison shouldn't carry.
 *
 * Post and Comment BOTH need their own constraint even though every Post/
 * Comment node also carries `:Message`: Neo4j's schema indexes are scoped
 * to one label each, never inherited across the other labels a multi-label
 * node happens to carry. Discovered the hard way against the old load path
 * — its `containerOf`/`replyOf` edge-wiring steps MATCHed by id filtered on
 * the concrete `:Post`/`:Comment` label (not `:Message`), and without a
 * label-specific index those MATCHes silently fell back to a full label
 * scan per row: a 5,000-row batch against SF1's ~1M Post nodes turned one
 * `containerOf` batch into billions of comparisons and multi-hour hangs.
 * The offline importer has no such failure mode (it never issues a Cypher
 * MATCH), but IS4-IS7's own by-id `MATCH`es below would hit the identical
 * label-scan trap without these same constraints, so they stay.
 */
async function ensureSchema(session: Session): Promise<void> {
  await session.run(
    "CREATE CONSTRAINT snb_person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE",
  );
  await session.run(
    "CREATE CONSTRAINT snb_message_id IF NOT EXISTS FOR (m:Message) REQUIRE m.id IS UNIQUE",
  );
  await session.run(
    "CREATE CONSTRAINT snb_post_id IF NOT EXISTS FOR (post:Post) REQUIRE post.id IS UNIQUE",
  );
  await session.run(
    "CREATE CONSTRAINT snb_comment_id IF NOT EXISTS FOR (c:Comment) REQUIRE c.id IS UNIQUE",
  );
  await session.run(
    "CREATE CONSTRAINT snb_forum_id IF NOT EXISTS FOR (f:Forum) REQUIRE f.id IS UNIQUE",
  );
  await session.run("CALL db.awaitIndexes(600)");
}

// ---- Offline bulk load: neo4j-admin database import ----

/**
 * `|` rather than the default `,`: LDBC post/comment/forum-title content is
 * natural-language text, which contains commas constantly but a literal
 * pipe almost never — staging on `|` avoids quoting nearly every large text
 * field (same rationale, and the same character, `./ladybug.ts` stages its
 * own CSVs with — verified independently against `neo4j-admin`'s
 * `--delimiter` option, since Ladybug's CSV shape and Neo4j's import shape
 * are otherwise unrelated formats).
 */
const CSV_DELIMITER = "|";

/**
 * RFC4180-style CSV field escaping: quote-wrap and double any embedded
 * quote whenever the field contains the delimiter, a quote, or a newline.
 * `neo4j-admin database import`'s default `--quote` character is `"`,
 * matching this.
 */
function csvField(value: string): string {
  return /[|"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(CSV_DELIMITER)}\n`;
}

/**
 * Streams rows to a staging CSV file for the later `neo4j-admin` import.
 * `mode: 0o644` is explicit rather than left to the process umask: the
 * staged files are read from inside the `neo4j-admin` container as its own
 * `neo4j` user (a different uid than the host process that wrote them), so
 * relying on an ambient umask to leave them world-readable would be
 * fragile across machines.
 */
function createCsvStager<T>(
  filePath: string,
  header: readonly string[],
  toFields: (row: T) => readonly string[],
): Readonly<{
  write: (row: T) => Promise<void>;
  finish: () => Promise<void>;
}> {
  const stream = createWriteStream(filePath, {
    encoding: "utf-8",
    mode: 0o644,
  });
  stream.write(csvRow(header));

  return {
    async write(row: T): Promise<void> {
      if (!stream.write(csvRow(toFields(row)))) {
        await once(stream, "drain");
      }
    },
    async finish(): Promise<void> {
      stream.end();
      await once(stream, "finish");
    },
  };
}

/**
 * Staged filenames, shared between `stageSnbDatasetForNeo4jImport` (which
 * writes them under the host-side staging directory) and
 * `runNeo4jAdminImport` (which references the same names under the
 * container-side `/import` bind mount) — one source of truth so the two
 * can never drift apart.
 */
const NEO4J_IMPORT_FILES = {
  person: "person.csv",
  forum: "forum.csv",
  post: "post.csv",
  comment: "comment.csv",
  knows: "knows.csv",
  hasCreator: "has-creator.csv",
  containerOf: "container-of.csv",
  replyOf: "reply-of.csv",
} as const;

type KnowsStageRow = Readonly<{ fromId: string; toId: string; since: string }>;
type EdgeStageRow = Readonly<{ fromId: string; toId: string }>;

function createNeo4jStagers(stageDir: string) {
  const filePath = (name: string) => join(stageDir, name);
  return {
    person: createCsvStager<SnbPersonRow>(
      filePath(NEO4J_IMPORT_FILES.person),
      [
        "id:ID",
        "firstName:string",
        "lastName:string",
        "gender:string",
        "birthday:string",
        "creationDate:string",
        "locationIp:string",
        "browserUsed:string",
        "cityId:string",
      ],
      (row) => [
        row.id,
        row.firstName,
        row.lastName,
        row.gender,
        row.birthday,
        row.creationDate,
        row.locationIp,
        row.browserUsed,
        row.cityId,
      ],
    ),
    forum: createCsvStager<SnbForumRow>(
      filePath(NEO4J_IMPORT_FILES.forum),
      ["id:ID", "title:string", "creationDate:string", "moderatorId:string"],
      (row) => [row.id, row.title, row.creationDate, row.moderatorId],
    ),
    post: createCsvStager<SnbPostRow>(
      filePath(NEO4J_IMPORT_FILES.post),
      ["id:ID", "content:string", "creationDate:string"],
      (row) => [row.id, row.content, row.creationDate],
    ),
    comment: createCsvStager<SnbCommentRow>(
      filePath(NEO4J_IMPORT_FILES.comment),
      ["id:ID", "content:string", "creationDate:string"],
      (row) => [row.id, row.content, row.creationDate],
    ),
    knows: createCsvStager<KnowsStageRow>(
      filePath(NEO4J_IMPORT_FILES.knows),
      [":START_ID", ":END_ID", "since:string"],
      (row) => [row.fromId, row.toId, row.since],
    ),
    // hasCreator/replyOf edges reference either a Post or a Comment on one
    // side; unlike `./ladybug.ts` (whose Kuzu-family rel tables must
    // declare each FROM/TO label pair up front), Neo4j relationships carry
    // no endpoint-label schema at all, so one file/one `--relationships`
    // argument handles both concrete kinds without splitting by pair.
    hasCreator: createCsvStager<EdgeStageRow>(
      filePath(NEO4J_IMPORT_FILES.hasCreator),
      [":START_ID", ":END_ID"],
      (row) => [row.fromId, row.toId],
    ),
    containerOf: createCsvStager<EdgeStageRow>(
      filePath(NEO4J_IMPORT_FILES.containerOf),
      [":START_ID", ":END_ID"],
      (row) => [row.fromId, row.toId],
    ),
    replyOf: createCsvStager<EdgeStageRow>(
      filePath(NEO4J_IMPORT_FILES.replyOf),
      [":START_ID", ":END_ID"],
      (row) => [row.fromId, row.toId],
    ),
  } as const;
}

/**
 * Streams the LDBC CSVs into neo4j-admin-import-shaped staging files. A
 * single `neo4j-admin database import` runs once, after every row from
 * every stage is staged — unlike the retired batched-Cypher loader (and
 * `./ladybug.ts`'s per-stage `COPY FROM`), there's no cross-stage ordering
 * dependency to flush early here, since the offline importer itself
 * resolves node-before-edge ordering internally regardless of file order.
 */
async function stageSnbDatasetForNeo4jImport(
  stageDir: string,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  const stagers = createNeo4jStagers(stageDir);

  const result = await streamSnbCsvDataset(
    datasetRoot,
    {
      person: (row) => stagers.person.write(row),
      forum: (row) => stagers.forum.write(row),
      post: (row) => stagers.post.write(row),
      comment: (row) => stagers.comment.write(row),
      edge: (row) => {
        switch (row.kind) {
          case "knows":
            return stagers.knows.write({
              fromId: row.fromId,
              toId: row.toId,
              since: row.createdAt,
            });
          case "hasCreator":
            return stagers.hasCreator.write({
              fromId: row.fromId,
              toId: row.toId,
            });
          case "containerOf":
            return stagers.containerOf.write({
              fromId: row.fromId,
              toId: row.toId,
            });
          case "replyOf":
            return stagers.replyOf.write({
              fromId: row.fromId,
              toId: row.toId,
            });
        }
      },
    },
    log,
  );

  await Promise.all([
    stagers.person.finish(),
    stagers.forum.finish(),
    stagers.post.finish(),
    stagers.comment.finish(),
    stagers.knows.finish(),
    stagers.hasCreator.finish(),
    stagers.containerOf.finish(),
    stagers.replyOf.finish(),
  ]);

  return result.pools;
}

/**
 * Runs `neo4j-admin database import full` as a one-off `docker run --rm`
 * against `dataVolume`'s `/data`, BEFORE the long-running server container
 * (`runNeo4jContainer`) ever attaches to it — the offline import requires a
 * non-existent or empty database directory. `--overwrite-destination=true`
 * is defensive (this benchmark's per-run `dataVolume` name is already
 * unique, so the volume is always fresh) rather than load-bearing.
 * `--id-type=string` is the CLI default; passed explicitly since every id
 * staged above is a prefixed string (`person:123`), never an integer.
 */
async function runNeo4jAdminImport(
  stageDir: string,
  dataVolume: string,
  log: (message: string) => void,
): Promise<void> {
  await spawnCapture("docker", ["volume", "create", dataVolume]);
  const importPath = (name: string) => `/import/${name}`;
  log("neo4j-admin database import: starting offline bulk load");
  await spawnCapture("docker", [
    "run",
    "--rm",
    "-v",
    `${dataVolume}:/data`,
    "-v",
    `${stageDir}:/import:ro`,
    NEO4J_IMAGE,
    "neo4j-admin",
    "database",
    "import",
    "full",
    "--id-type=string",
    `--delimiter=${CSV_DELIMITER}`,
    `--nodes=Person=${importPath(NEO4J_IMPORT_FILES.person)}`,
    `--nodes=Forum=${importPath(NEO4J_IMPORT_FILES.forum)}`,
    `--nodes=Post:Message=${importPath(NEO4J_IMPORT_FILES.post)}`,
    `--nodes=Comment:Message=${importPath(NEO4J_IMPORT_FILES.comment)}`,
    `--relationships=KNOWS=${importPath(NEO4J_IMPORT_FILES.knows)}`,
    `--relationships=HAS_CREATOR=${importPath(NEO4J_IMPORT_FILES.hasCreator)}`,
    `--relationships=CONTAINER_OF=${importPath(NEO4J_IMPORT_FILES.containerOf)}`,
    `--relationships=REPLY_OF=${importPath(NEO4J_IMPORT_FILES.replyOf)}`,
    "--overwrite-destination=true",
    NEO4J_DATABASE,
  ]);
  log("neo4j-admin database import: completed");
}

// ---- Queries: IS1-IS7 ----

async function runRows<Row extends Record<string, unknown>>(
  session: Session,
  query: string,
  parameters: Record<string, unknown> = {},
): Promise<readonly Row[]> {
  const result = await session.run(query, parameters);
  // neo4j-driver's `Record<Entries>` defaults to an untyped shape; narrow
  // each record to the row shape this Cypher query's RETURN clause actually
  // produces (see module doc: neo4j-driver's published types are loose).
  return result.records.map((record) => record.toObject() as Row);
}

/**
 * IS4/IS5/IS6/IS7 below match "a message by id" against the shared
 * `:Message` label instead of dispatching on `MessageRef.kind` — Neo4j's
 * multi-label nodes make the kind-specific TypeGraph dispatch unnecessary
 * (see module doc).
 */
function createNeo4jQueries(getSession: () => Session): SnbQueries {
  async function IS1(personId: string) {
    const rows = await runRows<{ id: string }>(
      getSession(),
      `MATCH (p:Person {id: $id})
       RETURN p.id AS id, p.firstName AS firstName, p.lastName AS lastName, p.birthday AS birthday,
              p.locationIp AS locationIp, p.browserUsed AS browserUsed, p.cityId AS cityId,
              p.gender AS gender, p.creationDate AS creationDate`,
      { id: personId },
    );
    return { rowCount: rows.length };
  }

  // Real LDBC IS2: friend frontier, then the merged top-10 (:Message covers
  // both Post and Comment) authored by those friends, then the root post +
  // root author of each of those 10 messages — required for realistic
  // timing but excluded from rowCount.
  async function IS2(personId: string) {
    const session = getSession();
    const friends = await runRows<{ id: string }>(
      session,
      // CYPHER 5: the default (25) planner compiles this equality-matched-
      // node-then-Expand shape to a full NodeIndexScan + Filter instead of a
      // NodeUniqueIndexSeek (confirmed via PROFILE) — a real, previously
      // undiscovered planner regression for this exact pattern, not a
      // missing index. Pinning the legacy language version restores the
      // seek. Same fix applied to IS3 and IS7's knows-check below, which
      // share the identical `MATCH (:Person {id: $id})-[:KNOWS]->` shape.
      `CYPHER 5
       MATCH (:Person {id: $id})-[:KNOWS]->(friend:Person) RETURN friend.id AS id`,
      { id: personId },
    );
    const friendIds = friends.map((row) => row.id);
    if (friendIds.length === 0) return { rowCount: 0 };

    const recent = await runRows<{ id: string }>(
      session,
      `MATCH (friend:Person)<-[:HAS_CREATOR]-(m:Message)
       WHERE friend.id IN $friendIds
       RETURN m.id AS id
       ORDER BY m.creationDate DESC, m.id DESC
       LIMIT ${IS2_MESSAGE_LIMIT}`,
      { friendIds },
    );

    for (const message of recent) {
      await runRows<{ rootId: string; authorId: string }>(
        session,
        `MATCH (m:Message {id: $id})
         OPTIONAL MATCH (m)-[:REPLY_OF*1..${ROOT_WALK_MAX_HOPS}]->(rootAncestor:Post)
         WITH coalesce(rootAncestor, m) AS root
         MATCH (root)-[:HAS_CREATOR]->(author:Person)
         RETURN root.id AS rootId, author.id AS authorId`,
        { id: message.id },
      );
    }

    return { rowCount: recent.length };
  }

  async function IS3(personId: string) {
    const rows = await runRows<{ id: string }>(
      getSession(),
      // CYPHER 5: see IS2's identical fix above — same equality-matched-node-
      // then-Expand shape, same planner regression, same restored seek.
      `CYPHER 5
       MATCH (:Person {id: $id})-[k:KNOWS]->(friend:Person)
       RETURN friend.id AS id, friend.firstName AS firstName, friend.lastName AS lastName,
              k.since AS since
       ORDER BY since DESC, friend.id ASC`,
      { id: personId },
    );
    return { rowCount: rows.length };
  }

  async function IS4(message: MessageRef) {
    const rows = await runRows<{ content: string; creationDate: string }>(
      getSession(),
      "MATCH (m:Message {id: $id}) RETURN m.content AS content, m.creationDate AS creationDate",
      { id: message.id },
    );
    return { rowCount: rows.length };
  }

  async function IS5(message: MessageRef) {
    const rows = await runRows<{
      id: string;
      firstName: string;
      lastName: string;
    }>(
      getSession(),
      `MATCH (:Message {id: $id})-[:HAS_CREATOR]->(author:Person)
       RETURN author.id AS id, author.firstName AS firstName, author.lastName AS lastName`,
      { id: message.id },
    );
    return { rowCount: rows.length };
  }

  async function IS6(message: MessageRef) {
    const rows = await runRows<{
      id: string;
      firstName: string;
      lastName: string;
    }>(
      getSession(),
      `MATCH (m:Message {id: $id})
       OPTIONAL MATCH (m)-[:REPLY_OF*1..${ROOT_WALK_MAX_HOPS}]->(rootAncestor:Post)
       WITH coalesce(rootAncestor, m) AS root
       MATCH (f:Forum)-[:CONTAINER_OF]->(root)
       MATCH (moderator:Person {id: f.moderatorId})
       RETURN moderator.id AS id, moderator.firstName AS firstName, moderator.lastName AS lastName`,
      { id: message.id },
    );
    return { rowCount: rows.length };
  }

  async function IS7(message: MessageRef) {
    const session = getSession();
    const parentAuthorRows = await runRows<{ id: string }>(
      session,
      "MATCH (:Message {id: $id})-[:HAS_CREATOR]->(author:Person) RETURN author.id AS id",
      { id: message.id },
    );
    const parentAuthorId = parentAuthorRows[0]?.id;

    const replies = await runRows<{
      id: string;
      content: string;
      creationDate: string;
      authorId: string;
      firstName: string;
      lastName: string;
    }>(
      session,
      `MATCH (reply:Comment)-[:REPLY_OF]->(:Message {id: $id})
       MATCH (reply)-[:HAS_CREATOR]->(author:Person)
       RETURN reply.id AS id, reply.content AS content, reply.creationDate AS creationDate,
              author.id AS authorId, author.firstName AS firstName, author.lastName AS lastName
       ORDER BY reply.creationDate DESC, author.id ASC`,
      { id: message.id },
    );
    const replyAuthorIds = [...new Set(replies.map((row) => row.authorId))];

    // Not counted toward rowCount, but must actually run for realistic timing.
    if (parentAuthorId !== undefined && replyAuthorIds.length > 0) {
      await runRows<{ id: string }>(
        session,
        // CYPHER 5: see IS2's identical fix above.
        `CYPHER 5
         MATCH (:Person {id: $authorId})-[:KNOWS]->(friend:Person)
         WHERE friend.id IN $replyAuthorIds
         RETURN friend.id AS id`,
        { authorId: parentAuthorId, replyAuthorIds },
      );
    }

    return { rowCount: replies.length };
  }

  return { IS1, IS2, IS3, IS4, IS5, IS6, IS7 };
}

// ---- Factory ----

export const createNeo4jEngine: SnbEngineFactory = async (
  options,
): Promise<SnbEngineHandle> => {
  const containerName = `typegraph-bench-snb-neo4j-${process.pid}-${Date.now()}`;
  const dataVolume = `${containerName}-data`;
  let driver: Driver | undefined;
  let session: Session | undefined;

  function requireSession(): Session {
    if (session === undefined) {
      throw new Error(
        "Neo4j engine's queries were invoked before load() completed.",
      );
    }
    return session;
  }

  async function cleanup(): Promise<void> {
    await session?.close().catch(() => undefined);
    await driver?.close().catch(() => undefined);
    await spawnCapture("docker", ["rm", "-f", containerName]).catch(
      () => undefined,
    );
    await spawnCapture("docker", ["volume", "rm", "-f", dataVolume]).catch(
      () => undefined,
    );
  }

  return {
    name: "neo4j",
    fairness:
      `${NEO4J_IMAGE}, imperative docker container (named volume for /data, ` +
      "tmpfs for /logs + /tmp, harness-allocated port, NEO4J_AUTH=none); " +
      "bulk load stages the LDBC CSVs into neo4j-admin's own CSV header " +
      "conventions and runs `neo4j-admin database import full` OFFLINE " +
      "(one-off docker run against the same named volume, before the " +
      "server starts) for both smoke and SF1 — Neo4j's own documented " +
      "bulk-load path above roughly 10M records into an empty database, " +
      "replacing the batched online `UNWIND ... IN TRANSACTIONS` writes " +
      "this driver used previously; unique constraints on Person/Message/" +
      "Post/Comment/Forum(id), awaited ONLINE after the server starts (the " +
      "offline import resolves relationships by id directly, so these " +
      "aren't needed until IS1-IS7 query time; no Message(creationDate) " +
      "index — a query-plan audit confirmed it's never used); heap/page-" +
      "cache sized from the memory actually visible " +
      "to the Docker daemon via `neo4j-admin server memory-recommendation` " +
      "(heuristic fallback if that command is unavailable), not a flat " +
      "2g/2g constant; official LDBC SNB Interactive v1 Cypher for " +
      "IS1-IS7, using native multi-label (:Message:Post/:Message:Comment) " +
      "polymorphism instead of TypeGraph's ontological supertype " +
      "workaround.",
    async load() {
      try {
        const memorySettings = await resolveNeo4jMemorySettings(options.log);

        const stageDir = await mkdtemp(
          join(tmpdir(), "typegraph-bench-snb-neo4j-"),
        );
        // `mkdtemp` creates the directory `0700` (owner-only) — traversable
        // only by the host process's own uid. The offline import below reads
        // this directory from inside the neo4j-admin container as its own
        // `neo4j` user (a different uid), which otherwise fails with
        // "Folder /import is not accessible for user: neo4j" — discovered by
        // actually running the import, not assumed. Widening to `0755`
        // (world-traversable/readable, still not writable) is enough; the
        // container never writes back into `/import`.
        await chmod(stageDir, 0o755);
        let pools: SnbIdPools;
        try {
          pools = await stageSnbDatasetForNeo4jImport(
            stageDir,
            options.datasetRoot,
            options.log,
          );
          await runNeo4jAdminImport(stageDir, dataVolume, options.log);
        } finally {
          await rm(stageDir, { recursive: true, force: true });
        }

        const port = await freePort();
        await runNeo4jContainer(
          containerName,
          dataVolume,
          port,
          memorySettings,
        );
        driver = neo4j.driver(`bolt://127.0.0.1:${port}`);
        await waitForNeo4jBolt(containerName, driver);
        session = driver.session({ database: NEO4J_DATABASE });
        await ensureSchema(session);
        return pools;
      } catch (error) {
        await cleanup();
        throw error;
      }
    },
    queries: createNeo4jQueries(requireSession),
    async close() {
      await cleanup();
    },
  };
};
