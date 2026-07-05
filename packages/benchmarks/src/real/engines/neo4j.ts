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
 * Load path: batched `UNWIND $rows AS row CALL { WITH row ... } IN
 * TRANSACTIONS OF 5000 ROWS` writes for every node/relationship kind (ported
 * from the sibling braiddb project's `scripts/snb-neo4j.ts`
 * `runInTransactions` helper), for BOTH the smoke and SF1 profiles. The
 * offline `neo4j-admin database import` bulk loader braiddb uses for its
 * SF1 profile is deliberately NOT implemented here — batched Bolt UNWIND is
 * an accepted, documented trade-off for this first driver; admin-import is
 * a possible future optimization if SF1 load time turns out to be
 * prohibitive.
 *
 * Container construction happens inside `load()` (not the factory), so
 * `loadMs` reflects the full Neo4j setup cost the same way braiddb's
 * reference driver measures it, fairly comparable to the other engines.
 */
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
const NEO4J_HEAP_SIZE = "2g";
const NEO4J_PAGECACHE_SIZE = "2g";

const CONTAINER_READY_TIMEOUT_MS = 120_000;
const CONTAINER_POLL_INTERVAL_MS = 1_000;

const LOAD_BATCH_SIZE = 5_000;
const ROOT_WALK_MAX_HOPS = 100;
const IS2_MESSAGE_LIMIT = 10;

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
    `NEO4J_server_memory_heap_initial__size=${NEO4J_HEAP_SIZE}`,
    "-e",
    `NEO4J_server_memory_heap_max__size=${NEO4J_HEAP_SIZE}`,
    "-e",
    `NEO4J_server_memory_pagecache_size=${NEO4J_PAGECACHE_SIZE}`,
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
 * Unique constraints on Person/Message/Forum(id) plus a Message(creationDate)
 * index, awaited ONLINE before any relationship is wired — so every
 * MATCH-by-id below is index-backed, matching the pk btrees the SQL-backed
 * engines get (same-index fairness, docs/design/benchmark-program-plan.md).
 */
async function ensureSchema(session: Session): Promise<void> {
  await session.run(
    "CREATE CONSTRAINT snb_person_id IF NOT EXISTS FOR (p:Person) REQUIRE p.id IS UNIQUE",
  );
  await session.run(
    "CREATE CONSTRAINT snb_message_id IF NOT EXISTS FOR (m:Message) REQUIRE m.id IS UNIQUE",
  );
  await session.run(
    "CREATE CONSTRAINT snb_forum_id IF NOT EXISTS FOR (f:Forum) REQUIRE f.id IS UNIQUE",
  );
  await session.run(
    "CREATE INDEX snb_message_creation_date IF NOT EXISTS FOR (m:Message) ON (m.creationDate)",
  );
  await session.run("CALL db.awaitIndexes(600)");
}

// ---- Bulk load: batched UNWIND ... CALL {} IN TRANSACTIONS ----

/**
 * Buffers rows and flushes them as one `UNWIND $rows AS row CALL { WITH row
 * <innerStatement> } IN TRANSACTIONS OF N ROWS` write per batch. `CALL { }
 * IN TRANSACTIONS` requires an implicit (auto-commit) transaction, so
 * `flush` always runs through `session.run` directly, never inside an
 * explicit driver transaction.
 */
function createBatcher<T>(
  session: Session,
  innerStatement: string,
  size: number = LOAD_BATCH_SIZE,
): Readonly<{ push: (row: T) => Promise<void>; finish: () => Promise<void> }> {
  let buffer: T[] = [];

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    await session.run(
      `UNWIND $rows AS row
       CALL {
         WITH row
         ${innerStatement}
       } IN TRANSACTIONS OF ${size} ROWS`,
      { rows },
    );
  }

  return {
    async push(row: T): Promise<void> {
      buffer.push(row);
      if (buffer.length >= size) await flush();
    },
    finish: flush,
  };
}

type KnowsEdgeRow = Readonly<{
  fromId: string;
  toId: string;
  createdAt: string;
}>;
type PlainEdgeRow = Readonly<{ fromId: string; toId: string }>;

/**
 * Streams the LDBC CSVs into Neo4j via batched UNWIND writes, flushing every
 * batcher at each `stageComplete` call — not just at the very end — because
 * a later stage's edges (e.g. `containerOf` from the posts stage) reference
 * nodes from earlier stages, and nothing else guarantees those are durably
 * written first. Mirrors `./typegraph-load.ts`'s `flushAll` discipline
 * exactly, adapted to Cypher writes instead of `bulkInsert`.
 */
async function loadSnbDatasetIntoNeo4j(
  session: Session,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  const persons = createBatcher<SnbPersonRow>(
    session,
    `CREATE (:Person {
       id: row.id, firstName: row.firstName, lastName: row.lastName, gender: row.gender,
       birthday: row.birthday, creationDate: row.creationDate, locationIp: row.locationIp,
       browserUsed: row.browserUsed, cityId: row.cityId
     })`,
  );
  const forums = createBatcher<SnbForumRow>(
    session,
    `CREATE (:Forum {
       id: row.id, title: row.title, creationDate: row.creationDate, moderatorId: row.moderatorId
     })`,
  );
  const posts = createBatcher<SnbPostRow>(
    session,
    "CREATE (:Message:Post {id: row.id, content: row.content, creationDate: row.creationDate})",
  );
  const comments = createBatcher<SnbCommentRow>(
    session,
    "CREATE (:Message:Comment {id: row.id, content: row.content, creationDate: row.creationDate})",
  );
  const knowsEdges = createBatcher<KnowsEdgeRow>(
    session,
    `MATCH (a:Person {id: row.fromId}), (b:Person {id: row.toId})
     CREATE (a)-[:KNOWS {since: row.createdAt}]->(b)`,
  );
  // hasCreator/replyOf edges reference either a Post or a Comment on one
  // side; matching by the shared `:Message` label (see module doc) means one
  // batcher handles both concrete kinds, unlike the TypeGraph loader's
  // kind-specific edge streams.
  const hasCreatorEdges = createBatcher<PlainEdgeRow>(
    session,
    `MATCH (m:Message {id: row.fromId}), (p:Person {id: row.toId})
     CREATE (m)-[:HAS_CREATOR]->(p)`,
  );
  const containerOfEdges = createBatcher<PlainEdgeRow>(
    session,
    `MATCH (f:Forum {id: row.fromId}), (post:Post {id: row.toId})
     CREATE (f)-[:CONTAINER_OF]->(post)`,
  );
  const replyOfEdges = createBatcher<PlainEdgeRow>(
    session,
    `MATCH (c:Comment {id: row.fromId}), (parent:Message {id: row.toId})
     CREATE (c)-[:REPLY_OF]->(parent)`,
  );

  async function flushAll(): Promise<void> {
    await persons.finish();
    await forums.finish();
    await posts.finish();
    await comments.finish();
    await knowsEdges.finish();
    await hasCreatorEdges.finish();
    await containerOfEdges.finish();
    await replyOfEdges.finish();
  }

  const result = await streamSnbCsvDataset(
    datasetRoot,
    {
      person: (row) => persons.push(row),
      forum: (row) => forums.push(row),
      post: (row) => posts.push(row),
      comment: (row) => comments.push(row),
      edge: (row) => {
        switch (row.kind) {
          case "knows":
            return knowsEdges.push(row);
          case "hasCreator":
            return hasCreatorEdges.push(row);
          case "containerOf":
            return containerOfEdges.push(row);
          case "replyOf":
            return replyOfEdges.push(row);
        }
      },
      stageComplete: flushAll,
    },
    log,
  );

  await flushAll();

  return result.pools;
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
      "MATCH (:Person {id: $id})-[:KNOWS]->(friend:Person) RETURN friend.id AS id",
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
      `MATCH (:Person {id: $id})-[k:KNOWS]->(friend:Person)
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
        `MATCH (:Person {id: $authorId})-[:KNOWS]->(friend:Person)
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
      "unique constraints on Person/Message/Forum(id) plus a " +
      "Message(creationDate) index, awaited ONLINE before relationship " +
      "wiring; batched `UNWIND ... CALL { } IN TRANSACTIONS OF 5000 ROWS` " +
      "bulk load for both smoke and SF1 (no offline neo4j-admin import); " +
      "official LDBC SNB Interactive v1 Cypher for IS1-IS7, using native " +
      "multi-label (:Message:Post/:Message:Comment) polymorphism instead of " +
      "TypeGraph's ontological supertype workaround.",
    async load() {
      try {
        const port = await freePort();
        await runNeo4jContainer(containerName, dataVolume, port);
        driver = neo4j.driver(`bolt://127.0.0.1:${port}`);
        await waitForNeo4jBolt(containerName, driver);
        session = driver.session({ database: NEO4J_DATABASE });
        await ensureSchema(session);
        return await loadSnbDatasetIntoNeo4j(
          session,
          options.datasetRoot,
          options.log,
        );
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
