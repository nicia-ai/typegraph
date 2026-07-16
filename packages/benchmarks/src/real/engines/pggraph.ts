/**
 * Evokoa pgGraph engine driver — a PostgreSQL extension that builds a derived
 * CSR graph index over ordinary SQL tables and exposes traversal/pathfinding
 * as `graph.*` SQL functions (docs.evokoa.com/pggraph). It is NOT a storage
 * engine of its own: PostgreSQL stays the system of record, so this driver
 * loads the LDBC dataset into its own normalized relational tables, registers
 * the `person` node table + `knows` edge with pgGraph, and builds the index.
 *
 * That split is the whole point of adding pgGraph to this program: the IS1-IS7
 * short reads are plain SQL over those tables (pgGraph's CSR index is idle for
 * point/1-hop reads — the honest result is that pgGraph ~= a tuned Postgres
 * here), while the two traversal queries exercise the extension's actual
 * value: IC13 via `graph.shortest_path`, BFS3 via `graph.traverse`.
 *
 * Launches its own throwaway container from the pgGraph extension image the
 * same imperative way the TypeGraph/PostgreSQL and Neo4j drivers launch
 * theirs (docs/design/benchmark-program-plan.md). `knows` is registered
 * `bidirectional := true` so the CSR is undirected — `graph.shortest_path`
 * has no per-call direction argument, and the dataset already materializes
 * both directions, so this matches every other engine's undirected knows.
 */
import { Client, Pool, type PoolClient } from "pg";

import {
  streamSnbCsvDataset,
  type SnbCommentRow,
  type SnbForumRow,
  type SnbIdPools,
  type SnbPersonRow,
  type SnbPostRow,
} from "../dataset/ldbc-csv";
import { PGGRAPH_IMAGE } from "../harness/doctor";
import { freePort, spawnCapture } from "../harness/process";
import {
  BFS3_HOPS,
  bfsReachResult,
  canonicalDigest,
  compareIdsAscending,
  compareMessageRecencyDesc,
  componentSizesResult,
  degreeResult,
  GA_MAX_HOPS,
  IC13_MAX_HOPS,
  IC9_MAX_DATE,
  IC_MESSAGE_LIMIT,
  type MessageRef,
  type PersonPair,
  reachableSetResult,
  shortestPathDistanceResult,
  type SnbEngineFactory,
  type SnbEngineHandle,
  type SnbQueries,
  ssspResult,
} from "./types";

const PERSON_TABLE = "public.person";
const IS2_MESSAGE_LIMIT = 10;
const ROOT_WALK_MAX_HOPS = 100;

/**
 * PostgreSQL caps a single statement at 65535 bind parameters. Each batched
 * multi-row INSERT stays well under that by choosing a row count from the
 * table's column count — a fixed budget rather than a per-table magic number.
 */
const BIND_PARAM_BUDGET = 50_000;

// The pgGraph image self-provisions a database named `graph` (its bundled
// pg_cron is hard-configured to `cron.database_name = graph`) and preloads the
// extension via its own container command. Overriding `POSTGRES_DB`, or
// replacing the command (e.g. appending `-c fsync=off`), breaks its init
// scripts and the container exits — so this launcher passes only
// `POSTGRES_PASSWORD` and connects to the `graph` database as `postgres`.
const PGGRAPH_DB = "graph";
const PGGRAPH_USER = "postgres";
const PGGRAPH_PASSWORD = "bench";

type PgGraphContainer = Readonly<{
  connectionString: string;
  close: () => Promise<void>;
}>;

async function startPgGraphContainer(): Promise<PgGraphContainer> {
  const port = await freePort();
  const name = `typegraph-bench-snb-pggraph-${process.pid}-${Date.now()}`;
  await spawnCapture("docker", [
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `127.0.0.1:${port}:5432`,
    "-e",
    `POSTGRES_PASSWORD=${PGGRAPH_PASSWORD}`,
    PGGRAPH_IMAGE,
  ]);
  const connectionString = `postgresql://${PGGRAPH_USER}:${PGGRAPH_PASSWORD}@127.0.0.1:${port}/${PGGRAPH_DB}`;
  const close = async (): Promise<void> => {
    await spawnCapture("docker", ["rm", "-f", name]).catch(() => undefined);
  };
  try {
    await waitForPgGraphReady(connectionString);
  } catch (error) {
    await close();
    throw error;
  }
  return { connectionString, close };
}

// The image runs a temporary init server (unix-socket only) before restarting
// the real one on TCP; connecting to the `graph` database over TCP only
// succeeds once that final server is up, so this loop is a genuine readiness
// gate, not a race against the init phase.
async function waitForPgGraphReady(connectionString: string): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await client.connect();
      await client.query("SELECT 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
  throw new Error(
    `pgGraph container did not become ready within 90s: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}

const SCHEMA_DDL = [
  `CREATE TABLE person (
     id text PRIMARY KEY,
     first_name text, last_name text, gender text, birthday text,
     creation_date text, location_ip text, browser_used text, city_id text
   )`,
  `CREATE TABLE forum (
     id text PRIMARY KEY, title text, creation_date text, moderator_id text
   )`,
  `CREATE TABLE post (id text PRIMARY KEY, content text, creation_date text)`,
  `CREATE TABLE comment (id text PRIMARY KEY, content text, creation_date text)`,
  `CREATE TABLE knows (from_id text, to_id text, since text)`,
  `CREATE TABLE has_creator (message_id text, message_kind text, person_id text)`,
  `CREATE TABLE container_of (forum_id text, post_id text)`,
  `CREATE TABLE reply_of (child_id text, parent_id text, parent_kind text)`,
] as const;

// Created AFTER bulk load (matching every engine driver's "indexes
// materialized after load" fairness label): the point reads' access paths,
// never touched by pgGraph's own CSR index.
const POST_LOAD_INDEX_DDL = [
  `CREATE INDEX has_creator_person_idx ON has_creator (person_id, message_kind)`,
  `CREATE INDEX has_creator_message_idx ON has_creator (message_id)`,
  `CREATE INDEX container_of_post_idx ON container_of (post_id)`,
  `CREATE INDEX reply_of_parent_idx ON reply_of (parent_id)`,
  `CREATE INDEX reply_of_child_idx ON reply_of (child_id)`,
  `CREATE INDEX knows_from_idx ON knows (from_id)`,
] as const;

type Inserter = Readonly<{
  push: (values: readonly unknown[]) => Promise<void>;
  finish: () => Promise<void>;
}>;

/** Batched multi-row INSERT, sized to stay under the bind-parameter budget. */
function createInserter(
  pool: Pool,
  table: string,
  columns: readonly string[],
): Inserter {
  const rowsPerBatch = Math.max(
    1,
    Math.floor(BIND_PARAM_BUDGET / columns.length),
  );
  const columnList = columns.join(", ");
  let buffer: (readonly unknown[])[] = [];

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    const columnCount = columns.length;
    const tuples = rows
      .map((_row, rowIndex) => {
        const placeholders = columns
          .map(
            (_column, columnIndex) =>
              `$${rowIndex * columnCount + columnIndex + 1}`,
          )
          .join(", ");
        return `(${placeholders})`;
      })
      .join(", ");
    const params = rows.flatMap((row) => [...row]);
    await pool.query(
      `INSERT INTO ${table} (${columnList}) VALUES ${tuples}`,
      params,
    );
  }

  return {
    async push(values): Promise<void> {
      buffer.push(values);
      if (buffer.length >= rowsPerBatch) await flush();
    },
    finish: flush,
  };
}

async function loadPgGraphDataset(
  pool: Pool,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  const persons = createInserter(pool, "person", [
    "id",
    "first_name",
    "last_name",
    "gender",
    "birthday",
    "creation_date",
    "location_ip",
    "browser_used",
    "city_id",
  ]);
  const forums = createInserter(pool, "forum", [
    "id",
    "title",
    "creation_date",
    "moderator_id",
  ]);
  const posts = createInserter(pool, "post", [
    "id",
    "content",
    "creation_date",
  ]);
  const comments = createInserter(pool, "comment", [
    "id",
    "content",
    "creation_date",
  ]);
  const knows = createInserter(pool, "knows", ["from_id", "to_id", "since"]);
  const hasCreator = createInserter(pool, "has_creator", [
    "message_id",
    "message_kind",
    "person_id",
  ]);
  const containerOf = createInserter(pool, "container_of", [
    "forum_id",
    "post_id",
  ]);
  const replyOf = createInserter(pool, "reply_of", [
    "child_id",
    "parent_id",
    "parent_kind",
  ]);

  async function flushAll(): Promise<void> {
    await persons.finish();
    await forums.finish();
    await posts.finish();
    await comments.finish();
    await knows.finish();
    await hasCreator.finish();
    await containerOf.finish();
    await replyOf.finish();
  }

  const result = await streamSnbCsvDataset(
    datasetRoot,
    {
      person: (row: SnbPersonRow) =>
        persons.push([
          row.id,
          row.firstName,
          row.lastName,
          row.gender,
          row.birthday,
          row.creationDate,
          row.locationIp,
          row.browserUsed,
          row.cityId,
        ]),
      forum: (row: SnbForumRow) =>
        forums.push([row.id, row.title, row.creationDate, row.moderatorId]),
      post: (row: SnbPostRow) =>
        posts.push([row.id, row.content, row.creationDate]),
      comment: (row: SnbCommentRow) =>
        comments.push([row.id, row.content, row.creationDate]),
      edge: (row) => {
        switch (row.kind) {
          case "knows":
            return knows.push([row.fromId, row.toId, row.createdAt]);
          case "hasCreator":
            return hasCreator.push([row.fromId, row.fromKind, row.toId]);
          case "containerOf":
            return containerOf.push([row.fromId, row.toId]);
          case "replyOf":
            return replyOf.push([row.fromId, row.toId, row.toKind]);
        }
      },
      stageComplete: flushAll,
    },
    log,
  );

  await flushAll();
  return result.pools;
}

async function registerAndBuildGraph(
  pool: Pool,
  log: (message: string) => void,
): Promise<void> {
  // Registration, `graph.sync_mode`, and `graph.build()` all run on one
  // client: `sync_mode` is a session GUC that must be set on the same
  // connection that builds, and the whole sequence is one-shot anyway.
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS graph");
    // The dataset is static after load, so opt out of pgGraph's trigger-based
    // incremental sync (which build() would otherwise install on every
    // registered table, with a warning) — a single post-load build is all we
    // need.
    await client.query("SET graph.sync_mode = 'manual'");
    await client.query(
      "SELECT graph.add_table($1::regclass, id_column := 'id')",
      [PERSON_TABLE],
    );
    // The `knows` relationship table already carries BOTH directed rows per
    // undirected friendship (see dataset/ldbc-csv.ts), exactly like every
    // other engine's edge set — so `bidirectional := false` yields a CSR with
    // those same two directed edges per pair. `bidirectional := true` would
    // instead quadruple each pair (two rows x two directions), an unfair CSR
    // inflation. A forward (`direction := 'out'`) traversal over the two
    // directed rows is already undirected reachability.
    await client.query(
      `SELECT graph.add_edge(
         from_table := 'public.knows'::regclass,
         from_column := 'from_id',
         to_table := $1::regclass,
         to_column := 'to_id',
         label := 'knows',
         bidirectional := false
       )`,
      [PERSON_TABLE],
    );
    const build = await client.query<{
      nodes_loaded: string;
      edges_loaded: string;
    }>("SELECT nodes_loaded, edges_loaded FROM graph.build()");
    const row = build.rows[0];
    log(
      `graph.build(): ${row?.nodes_loaded ?? "?"} nodes, ${row?.edges_loaded ?? "?"} edges`,
    );
  } finally {
    client.release();
  }
}

type QueryRunner = <Row>(
  name: string,
  text: string,
  values: readonly unknown[],
) => Promise<readonly Row[]>;

function createPgGraphQueries(run: QueryRunner): SnbQueries {
  // Walks the reply chain from a comment up to its root Post via a recursive
  // CTE over `reply_of` (a plain-SQL walk — pgGraph's shortest_path is for
  // person<->person, not this tree climb). Post has no outgoing reply_of, so
  // the walk terminates at exactly one Post.
  async function resolveRootPostId(commentId: string): Promise<string> {
    const rows = await run<{ id: string }>(
      "pggraph_root_walk",
      `WITH RECURSIVE chain(id, kind, depth) AS (
         SELECT parent_id, parent_kind, 1
           FROM reply_of WHERE child_id = $1
         UNION ALL
         SELECT r.parent_id, r.parent_kind, c.depth + 1
           FROM reply_of r
           JOIN chain c ON r.child_id = c.id
          WHERE c.kind = 'Comment' AND c.depth < ${ROOT_WALK_MAX_HOPS}
       )
       SELECT id FROM chain WHERE kind = 'Post' LIMIT 1`,
      [commentId],
    );
    const rootId = rows[0]?.id;
    if (rootId === undefined) {
      throw new Error(
        `reply-chain walk found no root Post for comment ${commentId}`,
      );
    }
    return rootId;
  }

  async function authorOfRootPost(
    postId: string,
  ): Promise<{ id: string; firstName: string; lastName: string } | undefined> {
    const rows = await run<{
      id: string;
      first_name: string;
      last_name: string;
    }>(
      "pggraph_author_of_post",
      `SELECT p.id, p.first_name, p.last_name
         FROM has_creator hc
         JOIN person p ON p.id = hc.person_id
        WHERE hc.message_id = $1 AND hc.message_kind = 'Post'`,
      [postId],
    );
    const author = rows[0];
    return author === undefined ? undefined : (
        {
          id: author.id,
          firstName: author.first_name,
          lastName: author.last_name,
        }
      );
  }

  async function recentMessagesOfPerson(personId: string): Promise<
    readonly {
      id: string;
      content: string;
      creationDate: string;
      kind: "Post" | "Comment";
    }[]
  > {
    const [posts, comments] = await Promise.all([
      run<{ id: string; content: string; creation_date: string }>(
        "pggraph_recent_posts",
        `SELECT p.id, p.content, p.creation_date
           FROM has_creator hc
           JOIN post p ON p.id = hc.message_id
          WHERE hc.person_id = $1 AND hc.message_kind = 'Post'
          ORDER BY p.creation_date DESC, p.id ASC
          LIMIT ${IS2_MESSAGE_LIMIT}`,
        [personId],
      ),
      run<{ id: string; content: string; creation_date: string }>(
        "pggraph_recent_comments",
        `SELECT c.id, c.content, c.creation_date
           FROM has_creator hc
           JOIN comment c ON c.id = hc.message_id
          WHERE hc.person_id = $1 AND hc.message_kind = 'Comment'
          ORDER BY c.creation_date DESC, c.id ASC
          LIMIT ${IS2_MESSAGE_LIMIT}`,
        [personId],
      ),
    ]);
    return [
      ...posts.map((row) => ({
        id: row.id,
        content: row.content,
        creationDate: row.creation_date,
        kind: "Post" as const,
      })),
      ...comments.map((row) => ({
        id: row.id,
        content: row.content,
        creationDate: row.creation_date,
        kind: "Comment" as const,
      })),
    ]
      .toSorted(
        (left, right) =>
          right.creationDate.localeCompare(left.creationDate) ||
          compareIdsAscending(left.id, right.id),
      )
      .slice(0, IS2_MESSAGE_LIMIT);
  }

  async function IS1(personId: string) {
    const rows = await run<{
      first_name: string;
      last_name: string;
      birthday: string;
      location_ip: string;
      browser_used: string;
      city_id: string;
      gender: string;
      creation_date: string;
    }>(
      "pggraph_is1",
      `SELECT first_name, last_name, birthday, location_ip,
              browser_used, city_id, gender, creation_date
         FROM person WHERE id = $1`,
      [personId],
    );
    const canonicalRows = rows.map((row) => ({
      firstName: row.first_name,
      lastName: row.last_name,
      birthday: row.birthday,
      locationIp: row.location_ip,
      browserUsed: row.browser_used,
      cityId: row.city_id,
      gender: row.gender,
      creationDate: row.creation_date,
    }));
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IS2(personId: string) {
    const recent = await recentMessagesOfPerson(personId);
    const canonicalRows = [];
    for (const message of recent) {
      const rootId =
        message.kind === "Post" ?
          message.id
        : await resolveRootPostId(message.id);
      const author = await authorOfRootPost(rootId);
      canonicalRows.push({
        messageId: message.id,
        content: message.content,
        creationDate: message.creationDate,
        postId: rootId,
        personId: author?.id,
        firstName: author?.firstName,
        lastName: author?.lastName,
      });
    }
    return { rowCount: recent.length, digest: canonicalDigest(canonicalRows) };
  }

  async function IS3(personId: string) {
    const rows = await run<{
      person_id: string;
      first_name: string;
      last_name: string;
      since: string;
    }>(
      "pggraph_is3",
      `SELECT p.id AS person_id, p.first_name, p.last_name, k.since
         FROM knows k
         JOIN person p ON p.id = k.to_id
        WHERE k.from_id = $1`,
      [personId],
    );
    const canonicalRows = rows
      .map((row) => ({
        personId: row.person_id,
        firstName: row.first_name,
        lastName: row.last_name,
        since: row.since,
      }))
      .toSorted(
        (left, right) =>
          right.since.localeCompare(left.since) ||
          compareIdsAscending(left.personId, right.personId),
      );
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IS4(message: MessageRef) {
    const table = message.kind === "Post" ? "post" : "comment";
    const rows = await run<{ content: string; creation_date: string }>(
      `pggraph_is4_${table}`,
      `SELECT content, creation_date FROM ${table} WHERE id = $1`,
      [message.id],
    );
    const canonicalRows = rows.map((row) => ({
      content: row.content,
      creationDate: row.creation_date,
    }));
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IS5(message: MessageRef) {
    const rows = await run<{
      id: string;
      first_name: string;
      last_name: string;
    }>(
      "pggraph_is5",
      `SELECT p.id, p.first_name, p.last_name
         FROM has_creator hc
         JOIN person p ON p.id = hc.person_id
        WHERE hc.message_id = $1`,
      [message.id],
    );
    const canonicalRows = rows.map((row) => ({
      id: row.id,
      firstName: row.first_name,
      lastName: row.last_name,
    }));
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IS6(message: MessageRef) {
    const rootId =
      message.kind === "Post" ?
        message.id
      : await resolveRootPostId(message.id);
    const forumRows = await run<{
      forum_id: string;
      title: string;
      moderator_id: string;
    }>(
      "pggraph_is6_forum",
      `SELECT f.id AS forum_id, f.title, f.moderator_id
         FROM container_of co
         JOIN forum f ON f.id = co.forum_id
        WHERE co.post_id = $1`,
      [rootId],
    );
    const forum = forumRows[0];
    if (forum === undefined) {
      return { rowCount: 0, digest: canonicalDigest([]) };
    }
    const moderatorRows = await run<{
      first_name: string;
      last_name: string;
    }>(
      "pggraph_is6_moderator",
      `SELECT first_name, last_name FROM person WHERE id = $1`,
      [forum.moderator_id],
    );
    const moderator = moderatorRows[0];
    const canonicalRow = {
      forumId: forum.forum_id,
      forumTitle: forum.title,
      moderatorId: forum.moderator_id,
      moderatorFirstName: moderator?.first_name,
      moderatorLastName: moderator?.last_name,
    };
    return {
      rowCount: moderatorRows.length,
      digest: canonicalDigest([canonicalRow]),
    };
  }

  async function IS7(message: MessageRef) {
    const parentAuthorRows = await run<{ id: string }>(
      "pggraph_is7_parent_author",
      `SELECT person_id AS id FROM has_creator WHERE message_id = $1`,
      [message.id],
    );
    const parentAuthorId = parentAuthorRows[0]?.id;

    const replies = await run<{
      id: string;
      content: string;
      creation_date: string;
      author_id: string;
      first_name: string;
      last_name: string;
    }>(
      "pggraph_is7_replies",
      `SELECT c.id, c.content, c.creation_date,
              a.id AS author_id, a.first_name, a.last_name
         FROM reply_of r
         JOIN comment c ON c.id = r.child_id
         JOIN has_creator hc ON hc.message_id = c.id AND hc.message_kind = 'Comment'
         JOIN person a ON a.id = hc.person_id
        WHERE r.parent_id = $1`,
      [message.id],
    );
    const authorIds = [...new Set(replies.map((row) => row.author_id))];

    let knowsAuthorIds = new Set<string>();
    if (parentAuthorId !== undefined && authorIds.length > 0) {
      const knowsRows = await run<{ id: string }>(
        "pggraph_is7_knows",
        `SELECT to_id AS id FROM knows
          WHERE from_id = $1 AND to_id = ANY($2::text[])`,
        [parentAuthorId, authorIds],
      );
      knowsAuthorIds = new Set(knowsRows.map((row) => row.id));
    }

    const canonicalRows = replies
      .toSorted(
        (left, right) =>
          right.creation_date.localeCompare(left.creation_date) ||
          compareIdsAscending(left.author_id, right.author_id),
      )
      .map((reply) => ({
        commentId: reply.id,
        content: reply.content,
        creationDate: reply.creation_date,
        replyAuthorId: reply.author_id,
        replyAuthorFirstName: reply.first_name,
        replyAuthorLastName: reply.last_name,
        replyAuthorKnowsOriginalMessageAuthor: knowsAuthorIds.has(
          reply.author_id,
        ),
      }));

    return { rowCount: replies.length, digest: canonicalDigest(canonicalRows) };
  }

  // IC13 (traversal): shortest-path hop distance between two persons over the
  // undirected `knows` CSR. `graph.shortest_path` returns one row per node on
  // the path (source is step 0), so hops = row count - 1; an empty result
  // means no path within max_depth -> undefined distance.
  async function IC13(pair: PersonPair) {
    const rows = await run<{ node_id: string }>(
      "pggraph_ic13",
      `SELECT node_id FROM graph.shortest_path(
         $1::regclass, $2, $1::regclass, $3,
         max_depth := ${IC13_MAX_HOPS}, hydrate := false
       )`,
      [PERSON_TABLE, pair.sourceId, pair.targetId],
    );
    const distance = rows.length === 0 ? undefined : rows.length - 1;
    return shortestPathDistanceResult(distance);
  }

  // BFS3 (traversal): distinct persons within BFS3_HOPS hops of a seed over
  // `knows` via `graph.traverse`. `direction := 'out'` follows the forward CSR
  // — already undirected because both directed rows exist per pair (see
  // registerAndBuildGraph). include_start := false excludes the seed;
  // reachableSetResult de-dupes/sorts for the canonical digest.
  async function BFS3(personId: string) {
    const rows = await run<{ node_id: string }>(
      "pggraph_bfs3",
      `SELECT node_id FROM graph.traverse(
         $1::regclass, $2,
         max_depth := ${BFS3_HOPS},
         edge_types := ARRAY['knows'],
         direction := 'out',
         node_tables := ARRAY[$1::regclass::oid],
         include_start := false,
         hydrate := false,
         max_rows := 100000000
       )`,
      [PERSON_TABLE, personId],
    );
    return reachableSetResult(rows.map((row) => row.node_id));
  }

  // IC2 (complex read, plain SQL): friends' most recent messages. Post/Comment
  // are separate tables, so — like IS2 — the true top-K across the union is
  // top-K of (top-K posts ∪ top-K comments).
  async function IC2(personId: string) {
    const [posts, comments] = await Promise.all([
      run<{
        friend_id: string;
        first_name: string;
        last_name: string;
        message_id: string;
        content: string;
        creation_date: string;
      }>(
        "pggraph_ic2_posts",
        `SELECT f.id AS friend_id, f.first_name, f.last_name,
                p.id AS message_id, p.content, p.creation_date
           FROM knows k
           JOIN person f ON f.id = k.to_id
           JOIN has_creator hc ON hc.person_id = f.id AND hc.message_kind = 'Post'
           JOIN post p ON p.id = hc.message_id
          WHERE k.from_id = $1
          ORDER BY p.creation_date DESC, p.id DESC
          LIMIT ${IC_MESSAGE_LIMIT}`,
        [personId],
      ),
      run<{
        friend_id: string;
        first_name: string;
        last_name: string;
        message_id: string;
        content: string;
        creation_date: string;
      }>(
        "pggraph_ic2_comments",
        `SELECT f.id AS friend_id, f.first_name, f.last_name,
                c.id AS message_id, c.content, c.creation_date
           FROM knows k
           JOIN person f ON f.id = k.to_id
           JOIN has_creator hc ON hc.person_id = f.id AND hc.message_kind = 'Comment'
           JOIN comment c ON c.id = hc.message_id
          WHERE k.from_id = $1
          ORDER BY c.creation_date DESC, c.id DESC
          LIMIT ${IC_MESSAGE_LIMIT}`,
        [personId],
      ),
    ]);
    const canonicalRows = [...posts, ...comments]
      .map((row) => ({
        friendId: row.friend_id,
        friendFirstName: row.first_name,
        friendLastName: row.last_name,
        messageId: row.message_id,
        messageContent: row.content,
        messageCreationDate: row.creation_date,
      }))
      .toSorted((left, right) =>
        compareMessageRecencyDesc(
          { creationDate: left.messageCreationDate, id: left.messageId },
          { creationDate: right.messageCreationDate, id: right.messageId },
        ),
      )
      .slice(0, IC_MESSAGE_LIMIT);
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  // IC8 (complex read, plain SQL): recent replies to the person's own messages.
  // reply_of.parent_id is a globally-unique message id, so one query covers
  // replies to both the person's posts and comments.
  async function IC8(personId: string) {
    const rows = await run<{
      author_id: string;
      first_name: string;
      last_name: string;
      comment_id: string;
      content: string;
      creation_date: string;
    }>(
      "pggraph_ic8",
      `SELECT a.id AS author_id, a.first_name, a.last_name,
              c.id AS comment_id, c.content, c.creation_date
         FROM has_creator hc_msg
         JOIN reply_of r ON r.parent_id = hc_msg.message_id
         JOIN comment c ON c.id = r.child_id
         JOIN has_creator hc_reply ON hc_reply.message_id = c.id
         JOIN person a ON a.id = hc_reply.person_id
        WHERE hc_msg.person_id = $1
        ORDER BY c.creation_date DESC, c.id DESC
        LIMIT ${IC_MESSAGE_LIMIT}`,
      [personId],
    );
    const canonicalRows = rows
      .map((row) => ({
        replyAuthorId: row.author_id,
        replyAuthorFirstName: row.first_name,
        replyAuthorLastName: row.last_name,
        commentId: row.comment_id,
        commentContent: row.content,
        commentCreationDate: row.creation_date,
      }))
      .toSorted((left, right) =>
        compareMessageRecencyDesc(
          { creationDate: left.commentCreationDate, id: left.commentId },
          { creationDate: right.commentCreationDate, id: right.commentId },
        ),
      )
      .slice(0, IC_MESSAGE_LIMIT);
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  // IC9 (complex read): friends+FoF messages before the cutoff. The 2-hop
  // friend-of-friend set comes from pgGraph's own `graph.traverse` (the CSR
  // index at work), joined to each person's messages.
  async function ic9MessagesOf(
    label: "posts" | "comments",
    table: "post" | "comment",
    kind: "Post" | "Comment",
    personId: string,
  ) {
    return run<{
      person_id: string;
      first_name: string;
      last_name: string;
      message_id: string;
      content: string;
      creation_date: string;
    }>(
      `pggraph_ic9_${label}`,
      `SELECT pe.id AS person_id, pe.first_name, pe.last_name,
              m.id AS message_id, m.content, m.creation_date
         FROM graph.traverse(
                'public.person'::regclass, $1,
                max_depth := 2, edge_types := ARRAY['knows'], direction := 'out',
                node_tables := ARRAY['public.person'::regclass::oid],
                include_start := false, hydrate := false, max_rows := 100000000
              ) t
         JOIN has_creator hc ON hc.person_id = t.node_id AND hc.message_kind = '${kind}'
         JOIN ${table} m ON m.id = hc.message_id
         JOIN person pe ON pe.id = t.node_id
        WHERE m.creation_date < $2
        ORDER BY m.creation_date DESC, m.id DESC
        LIMIT ${IC_MESSAGE_LIMIT}`,
      [personId, IC9_MAX_DATE],
    );
  }

  async function IC9(personId: string) {
    const [posts, comments] = await Promise.all([
      ic9MessagesOf("posts", "post", "Post", personId),
      ic9MessagesOf("comments", "comment", "Comment", personId),
    ]);
    const canonicalRows = [...posts, ...comments]
      .map((row) => ({
        personId: row.person_id,
        personFirstName: row.first_name,
        personLastName: row.last_name,
        messageId: row.message_id,
        messageContent: row.content,
        messageCreationDate: row.creation_date,
      }))
      .toSorted((left, right) =>
        compareMessageRecencyDesc(
          { creationDate: left.messageCreationDate, id: left.messageId },
          { creationDate: right.messageCreationDate, id: right.messageId },
        ),
      )
      .slice(0, IC_MESSAGE_LIMIT);
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  // GA_DEGREE (algorithm): the seed's knows degree.
  async function GA_DEGREE(seedPersonId: string) {
    const rows = await run<{ degree: string }>(
      "pggraph_ga_degree",
      `SELECT count(*) AS degree FROM knows WHERE from_id = $1`,
      [seedPersonId],
    );
    return degreeResult(Number(rows[0]?.degree ?? 0));
  }

  // GA_WCC (algorithm): weakly connected components of the whole knows graph
  // via pgGraph's native `graph.connected_components` (one row per node) —
  // reduced to the multiset of component sizes. Seed-independent.
  async function GA_WCC(_seedPersonId: string) {
    const rows = await run<{ component_size: number | string }>(
      "pggraph_ga_wcc",
      `SELECT component_size
         FROM graph.connected_components()
        GROUP BY component_id, component_size`,
      [],
    );
    return componentSizesResult(rows.map((row) => Number(row.component_size)));
  }

  // GA_BFS / GA_SSSP (algorithms): whole-component reachability / shortest-path
  // depths from the seed via `graph.traverse` (BFS; `depth` is the shortest
  // distance). max_depth GA_MAX_HOPS reaches the entire component.
  async function GA_BFS(seedPersonId: string) {
    const rows = await run<{ reachable: string }>(
      "pggraph_ga_bfs",
      `SELECT count(*) AS reachable FROM graph.traverse(
         'public.person'::regclass, $1,
         max_depth := ${GA_MAX_HOPS}, edge_types := ARRAY['knows'], direction := 'out',
         node_tables := ARRAY['public.person'::regclass::oid],
         include_start := false, hydrate := false, max_rows := 100000000
       )`,
      [seedPersonId],
    );
    return bfsReachResult(Number(rows[0]?.reachable ?? 0));
  }
  async function GA_SSSP(seedPersonId: string) {
    const rows = await run<{ reachable: string; depth_sum: string | null }>(
      "pggraph_ga_sssp",
      `SELECT count(*) AS reachable, coalesce(sum(depth), 0) AS depth_sum
         FROM graph.traverse(
           'public.person'::regclass, $1,
           max_depth := ${GA_MAX_HOPS}, edge_types := ARRAY['knows'], direction := 'out',
           node_tables := ARRAY['public.person'::regclass::oid],
           include_start := false, hydrate := false, max_rows := 100000000
         )`,
      [seedPersonId],
    );
    return ssspResult(
      Number(rows[0]?.reachable ?? 0),
      Number(rows[0]?.depth_sum ?? 0),
    );
  }

  return {
    IS1,
    IS2,
    IS3,
    IS4,
    IS5,
    IS6,
    IS7,
    IC13,
    BFS3,
    IC2,
    IC8,
    IC9,
    GA_DEGREE,
    GA_WCC,
    GA_BFS,
    GA_SSSP,
  };
}

export const createPgGraphEngine: SnbEngineFactory = async (
  options,
): Promise<SnbEngineHandle> => {
  const container = await startPgGraphContainer();
  const pool = new Pool({ connectionString: container.connectionString });

  // A dedicated client held for the whole query workload so named prepared
  // statements persist (pg caches a `name`d statement per connection) — the
  // same prepare-once fairness the TypeGraph/Neo4j/Ladybug drivers get.
  let queryClient: PoolClient | undefined;

  const runQuery: QueryRunner = async (name, text, values) => {
    if (queryClient === undefined) {
      throw new Error("pgGraph queries were invoked before load() completed.");
    }
    const result = await queryClient.query({ name, text, values: [...values] });
    return result.rows;
  };

  try {
    for (const ddl of SCHEMA_DDL) {
      await pool.query(ddl);
    }

    return {
      name: "pggraph",
      fairness:
        `${PGGRAPH_IMAGE}, imperative docker container (image default config, ` +
        "graph database), node-postgres over localhost TCP; LDBC loaded into " +
        "normalized SQL tables via batched multi-row INSERT, point-read " +
        "indexes and the pgGraph CSR index (person nodes + knows edge, two " +
        "directed rows per pair) both built after bulk load with " +
        "graph.sync_mode = manual. IS1-IS7 are plain SQL (pgGraph's index is " +
        "idle for point/1-hop reads); IC13 uses graph.shortest_path and BFS3 " +
        "uses graph.traverse.",
      async load() {
        const pools = await loadPgGraphDataset(
          pool,
          options.datasetRoot,
          options.log,
        );
        for (const ddl of POST_LOAD_INDEX_DDL) {
          await pool.query(ddl);
        }
        await registerAndBuildGraph(pool, options.log);
        await pool.query("VACUUM ANALYZE");
        // Acquire the dedicated query connection only after the graph is
        // built, then warm it with a throwaway 1-hop traversal: pgGraph loads
        // the mmap'd CSR lazily per backend, so without this the first timed
        // traversal request would pay that one-off per-connection load cost.
        queryClient = await pool.connect();
        const warmSeed = pools.persons[0];
        if (warmSeed !== undefined) {
          await queryClient.query(
            `SELECT 1 FROM graph.traverse($1::regclass, $2, max_depth := 1,
               edge_types := ARRAY['knows'], direction := 'out',
               include_start := false, hydrate := false, max_rows := 1)`,
            [PERSON_TABLE, warmSeed],
          );
        }
        return pools;
      },
      queries: createPgGraphQueries(runQuery),
      async close() {
        queryClient?.release();
        await pool.end();
        await container.close();
      },
    };
  } catch (error) {
    queryClient?.release();
    await pool.end().catch(() => undefined);
    await container.close();
    throw error;
  }
};
