/**
 * LadybugDB (`@ladybugdb/core`) engine driver — the embedded pairing against
 * TypeGraph/SQLite (docs/design/benchmark-program-plan.md, Lane 1). LadybugDB
 * is an in-process, Kuzu-family property-graph database: no Docker, no
 * network, openCypher-like query language.
 *
 * Unlike the TypeGraph schema (`../schema/snb-graph`), which models the
 * polymorphic Message supertype (Post | Comment) through an ontological
 * `includeSubClasses` workaround, LadybugDB's DDL supports multi-pair
 * `CREATE REL TABLE` natively (`HasCreator(FROM Post TO Person, FROM Comment
 * TO Person)`, `ReplyOf(FROM Comment TO Post, FROM Comment TO Comment)`), so
 * no workaround is needed here — but MATCH/CREATE on the Post/Comment split
 * still requires the concrete label at each site (Ladybug's binder rejects
 * `CREATE` off a node pattern bound to more than one label), so writes and
 * reads that touch a polymorphic edge are split by kind (fromKind/toKind for
 * loading, MessageRef.kind for querying) rather than expressed once.
 *
 * Bulk load uses `conn.prepare()` once per entity/edge kind, then
 * `conn.execute(prepared, { rows: batch })` per batch — a parameterized
 * `UNWIND` over a list-of-structs param, not literal-interpolated Cypher
 * text. This sidesteps hand-escaping arbitrary LDBC post/comment content
 * (quotes, backslashes, colons) into a Cypher literal, and reuses one
 * compiled plan across every batch of a given kind instead of recompiling
 * per batch.
 *
 * IS1-IS7 point queries are likewise `conn.prepare()`d once (at engine
 * construction, right after DDL) and `conn.execute()`d per request — the
 * same fairness point as TypeGraph's `.prepare()`/`.execute()` split
 * documented in `./typegraph-queries.ts`'s module doc: Neo4j caches a Cypher
 * plan by statement text server-side, so an engine driver that recompiled a
 * query per request would be paying a tax the competitors don't.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Connection, Database } from "@ladybugdb/core";
import type {
  LbugValue,
  PreparedStatement,
  QueryResult,
} from "@ladybugdb/core";

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

const BATCH_SIZE = 2_000;

/**
 * LadybugDB's variable-length relationship pattern rejects an upper bound
 * above 30 (`Binder exception: Upper bound of rel e exceeds maximum: 30`),
 * unlike TypeGraph's `ROOT_WALK_MAX_HOPS = 100` (`./typegraph-queries.ts`).
 * LDBC SNB reply chains are shallow in practice (a handful of hops), so this
 * cap is not expected to truncate a real root walk — but it is a genuine
 * engine limit, not a chosen parameter, and is called out here so it reads
 * as a declared engine constraint rather than a silent mismatch with the
 * TypeGraph driver's constant.
 */
const ROOT_WALK_MAX_HOPS = 30;

type KnowsInsertRow = Readonly<{ fromId: string; toId: string; since: string }>;
type HasCreatorInsertRow = Readonly<{ fromId: string; toId: string }>;
type ContainerOfInsertRow = Readonly<{ fromId: string; toId: string }>;
type ReplyOfInsertRow = Readonly<{ fromId: string; toId: string }>;

/** Read every row out of a (possibly multi-statement) query result. */
async function rowsOf(
  result: QueryResult | QueryResult[],
): Promise<readonly Record<string, unknown>[]> {
  const queryResult = Array.isArray(result) ? result.at(-1) : result;
  if (queryResult === undefined) return [];
  return (await queryResult.getAll()) as Record<string, unknown>[];
}

/** Execute a prepared `UNWIND $rows AS row ...` statement over one batch. */
async function executeBatch<Row>(
  conn: Connection,
  prepared: PreparedStatement,
  rows: readonly Row[],
): Promise<void> {
  await conn.execute(prepared, { rows } as unknown as Record<
    string,
    LbugValue
  >);
}

/**
 * Buffers items and flushes in fixed-size chunks — mirrors `createBatcher`
 * in `./typegraph-load.ts` (kept local here since that helper isn't
 * exported, and its `flush` there is coupled to `SnbStore.bulkInsert`).
 */
function createBatcher<T>(
  size: number,
  flush: (batch: readonly T[]) => Promise<void>,
): Readonly<{ push: (item: T) => Promise<void>; finish: () => Promise<void> }> {
  let buffer: T[] = [];
  return {
    async push(item: T): Promise<void> {
      buffer.push(item);
      if (buffer.length >= size) {
        const toFlush = buffer;
        buffer = [];
        await flush(toFlush);
      }
    },
    async finish(): Promise<void> {
      if (buffer.length > 0) {
        const toFlush = buffer;
        buffer = [];
        await flush(toFlush);
      }
    },
  };
}

async function createSchema(conn: Connection): Promise<void> {
  await conn.query(
    "CREATE NODE TABLE Person(id STRING PRIMARY KEY, firstName STRING, lastName STRING, " +
      "gender STRING, birthday STRING, creationDate STRING, locationIp STRING, " +
      "browserUsed STRING, cityId STRING);",
  );
  await conn.query(
    "CREATE NODE TABLE Forum(id STRING PRIMARY KEY, title STRING, creationDate STRING, moderatorId STRING);",
  );
  await conn.query(
    "CREATE NODE TABLE Post(id STRING PRIMARY KEY, content STRING, creationDate STRING);",
  );
  await conn.query(
    "CREATE NODE TABLE Comment(id STRING PRIMARY KEY, content STRING, creationDate STRING);",
  );
  await conn.query(
    "CREATE REL TABLE Knows(FROM Person TO Person, since STRING);",
  );
  await conn.query(
    "CREATE REL TABLE HasCreator(FROM Post TO Person, FROM Comment TO Person);",
  );
  await conn.query("CREATE REL TABLE ContainerOf(FROM Forum TO Post);");
  await conn.query(
    "CREATE REL TABLE ReplyOf(FROM Comment TO Post, FROM Comment TO Comment);",
  );
}

type LoadStatements = Readonly<{
  insertPerson: PreparedStatement;
  insertForum: PreparedStatement;
  insertPost: PreparedStatement;
  insertComment: PreparedStatement;
  insertKnows: PreparedStatement;
  insertHasCreatorFromPost: PreparedStatement;
  insertHasCreatorFromComment: PreparedStatement;
  insertContainerOf: PreparedStatement;
  insertReplyOfToPost: PreparedStatement;
  insertReplyOfToComment: PreparedStatement;
}>;

async function prepareLoadStatements(
  conn: Connection,
): Promise<LoadStatements> {
  return {
    insertPerson: await conn.prepare(
      "UNWIND $rows AS row CREATE (:Person {id: row.id, firstName: row.firstName, " +
        "lastName: row.lastName, gender: row.gender, birthday: row.birthday, " +
        "creationDate: row.creationDate, locationIp: row.locationIp, " +
        "browserUsed: row.browserUsed, cityId: row.cityId});",
    ),
    insertForum: await conn.prepare(
      "UNWIND $rows AS row CREATE (:Forum {id: row.id, title: row.title, " +
        "creationDate: row.creationDate, moderatorId: row.moderatorId});",
    ),
    insertPost: await conn.prepare(
      "UNWIND $rows AS row CREATE (:Post {id: row.id, content: row.content, creationDate: row.creationDate});",
    ),
    insertComment: await conn.prepare(
      "UNWIND $rows AS row CREATE (:Comment {id: row.id, content: row.content, creationDate: row.creationDate});",
    ),
    insertKnows: await conn.prepare(
      "UNWIND $rows AS row MATCH (a:Person {id: row.fromId}), (b:Person {id: row.toId}) " +
        "CREATE (a)-[:Knows {since: row.since}]->(b);",
    ),
    insertHasCreatorFromPost: await conn.prepare(
      "UNWIND $rows AS row MATCH (m:Post {id: row.fromId}), (p:Person {id: row.toId}) " +
        "CREATE (m)-[:HasCreator]->(p);",
    ),
    insertHasCreatorFromComment: await conn.prepare(
      "UNWIND $rows AS row MATCH (m:Comment {id: row.fromId}), (p:Person {id: row.toId}) " +
        "CREATE (m)-[:HasCreator]->(p);",
    ),
    insertContainerOf: await conn.prepare(
      "UNWIND $rows AS row MATCH (f:Forum {id: row.fromId}), (p:Post {id: row.toId}) " +
        "CREATE (f)-[:ContainerOf]->(p);",
    ),
    insertReplyOfToPost: await conn.prepare(
      "UNWIND $rows AS row MATCH (c:Comment {id: row.fromId}), (m:Post {id: row.toId}) " +
        "CREATE (c)-[:ReplyOf]->(m);",
    ),
    insertReplyOfToComment: await conn.prepare(
      "UNWIND $rows AS row MATCH (c:Comment {id: row.fromId}), (m:Comment {id: row.toId}) " +
        "CREATE (c)-[:ReplyOf]->(m);",
    ),
  };
}

async function loadSnbDataset(
  conn: Connection,
  statements: LoadStatements,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  const persons = createBatcher<SnbPersonRow>(BATCH_SIZE, (batch) =>
    executeBatch(conn, statements.insertPerson, batch),
  );
  const forums = createBatcher<SnbForumRow>(BATCH_SIZE, (batch) =>
    executeBatch(conn, statements.insertForum, batch),
  );
  const posts = createBatcher<SnbPostRow>(BATCH_SIZE, (batch) =>
    executeBatch(conn, statements.insertPost, batch),
  );
  const comments = createBatcher<SnbCommentRow>(BATCH_SIZE, (batch) =>
    executeBatch(conn, statements.insertComment, batch),
  );
  const knows = createBatcher<KnowsInsertRow>(BATCH_SIZE, (batch) =>
    executeBatch(conn, statements.insertKnows, batch),
  );
  const hasCreatorFromPost = createBatcher<HasCreatorInsertRow>(
    BATCH_SIZE,
    (batch) => executeBatch(conn, statements.insertHasCreatorFromPost, batch),
  );
  const hasCreatorFromComment = createBatcher<HasCreatorInsertRow>(
    BATCH_SIZE,
    (batch) =>
      executeBatch(conn, statements.insertHasCreatorFromComment, batch),
  );
  const containerOf = createBatcher<ContainerOfInsertRow>(BATCH_SIZE, (batch) =>
    executeBatch(conn, statements.insertContainerOf, batch),
  );
  const replyOfToPost = createBatcher<ReplyOfInsertRow>(BATCH_SIZE, (batch) =>
    executeBatch(conn, statements.insertReplyOfToPost, batch),
  );
  const replyOfToComment = createBatcher<ReplyOfInsertRow>(
    BATCH_SIZE,
    (batch) => executeBatch(conn, statements.insertReplyOfToComment, batch),
  );

  // Flushing every batcher at each stage boundary (not just at the very
  // end) guarantees a stage's nodes are durably written before the next
  // stage's edges can reference them — see the flush-discipline note on
  // `SnbRowSink.stageComplete` in `../dataset/ldbc-csv.ts`.
  async function flushAll(): Promise<void> {
    await persons.finish();
    await forums.finish();
    await posts.finish();
    await comments.finish();
    await knows.finish();
    await hasCreatorFromPost.finish();
    await hasCreatorFromComment.finish();
    await containerOf.finish();
    await replyOfToPost.finish();
    await replyOfToComment.finish();
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
            return knows.push({
              fromId: row.fromId,
              toId: row.toId,
              since: row.createdAt,
            });
          case "hasCreator":
            return row.fromKind === "Post" ?
                hasCreatorFromPost.push({ fromId: row.fromId, toId: row.toId })
              : hasCreatorFromComment.push({
                  fromId: row.fromId,
                  toId: row.toId,
                });
          case "containerOf":
            return containerOf.push({ fromId: row.fromId, toId: row.toId });
          case "replyOf":
            return row.toKind === "Post" ?
                replyOfToPost.push({ fromId: row.fromId, toId: row.toId })
              : replyOfToComment.push({ fromId: row.fromId, toId: row.toId });
        }
      },
      stageComplete: flushAll,
    },
    log,
  );

  await flushAll();

  return result.pools;
}

async function createQueries(conn: Connection): Promise<SnbQueries> {
  const is1Statement = await conn.prepare(
    "MATCH (p:Person) WHERE p.id = $id RETURN p.firstName AS firstName, p.lastName AS lastName, " +
      "p.birthday AS birthday, p.locationIp AS locationIp, p.browserUsed AS browserUsed, " +
      "p.cityId AS cityId, p.gender AS gender, p.creationDate AS creationDate;",
  );
  const personByIdStatement = await conn.prepare(
    "MATCH (p:Person) WHERE p.id = $id RETURN p.id AS id;",
  );
  const friendIdsStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})-[:Knows]->(friend:Person) RETURN friend.id AS id;",
  );
  const friendsWithSinceStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})-[e:Knows]->(friend:Person) RETURN friend.id AS id, e.since AS since " +
      "ORDER BY e.since DESC, friend.id ASC;",
  );
  const postsByFriendsStatement = await conn.prepare(
    "MATCH (friend:Person)<-[:HasCreator]-(post:Post) WHERE friend.id IN $ids " +
      "RETURN post.id AS id, post.creationDate AS creationDate " +
      "ORDER BY post.creationDate DESC, post.id DESC LIMIT 10;",
  );
  const commentsByFriendsStatement = await conn.prepare(
    "MATCH (friend:Person)<-[:HasCreator]-(comment:Comment) WHERE friend.id IN $ids " +
      "RETURN comment.id AS id, comment.creationDate AS creationDate " +
      "ORDER BY comment.creationDate DESC, comment.id DESC LIMIT 10;",
  );
  const is4PostStatement = await conn.prepare(
    "MATCH (m:Post {id: $id}) RETURN m.content AS content, m.creationDate AS creationDate;",
  );
  const is4CommentStatement = await conn.prepare(
    "MATCH (m:Comment {id: $id}) RETURN m.content AS content, m.creationDate AS creationDate;",
  );
  const authorOfPostStatement = await conn.prepare(
    "MATCH (m:Post {id: $id})-[:HasCreator]->(author:Person) RETURN author.id AS id;",
  );
  const authorOfCommentStatement = await conn.prepare(
    "MATCH (m:Comment {id: $id})-[:HasCreator]->(author:Person) RETURN author.id AS id;",
  );
  // Terminal node type is constrained to `:Post` directly in the pattern —
  // ReplyOf can only continue through Comment nodes (Post has no outgoing
  // ReplyOf edge), so this always resolves the unique root Post without
  // needing the ancestor-chain-plus-depth workaround `./typegraph-queries.ts`
  // uses for its ontological `includeSubClasses` traversal.
  const rootWalkStatement = await conn.prepare(
    `MATCH (c:Comment {id: $id})-[:ReplyOf*1..${ROOT_WALK_MAX_HOPS}]->(root:Post) RETURN DISTINCT root.id AS id;`,
  );
  const forumOfPostStatement = await conn.prepare(
    "MATCH (f:Forum)-[:ContainerOf]->(post:Post) WHERE post.id = $id RETURN f.moderatorId AS moderatorId;",
  );
  const repliesOfPostStatement = await conn.prepare(
    "MATCH (reply:Comment)-[:ReplyOf]->(m:Post {id: $id}) MATCH (reply)-[:HasCreator]->(author:Person) " +
      "RETURN reply.id AS id, author.id AS authorId ORDER BY reply.creationDate DESC, author.id ASC;",
  );
  const repliesOfCommentStatement = await conn.prepare(
    "MATCH (reply:Comment)-[:ReplyOf]->(m:Comment {id: $id}) MATCH (reply)-[:HasCreator]->(author:Person) " +
      "RETURN reply.id AS id, author.id AS authorId ORDER BY reply.creationDate DESC, author.id ASC;",
  );
  const knowsCheckStatement = await conn.prepare(
    "MATCH (author:Person {id: $authorId})-[:Knows]->(friend:Person) WHERE friend.id IN $ids " +
      "RETURN friend.id AS id;",
  );

  async function resolveRootPostId(commentId: string): Promise<string> {
    const rows = await rowsOf(
      await conn.execute(rootWalkStatement, { id: commentId }),
    );
    const root = rows[0];
    if (root === undefined) {
      throw new Error(
        `ReplyOf root walk found no root Post for comment ${commentId}`,
      );
    }
    return root.id as string;
  }

  async function recentMessagesByFriends(friendIds: readonly string[]): Promise<
    readonly Readonly<{
      id: string;
      creationDate: string;
      kind: "Post" | "Comment";
    }>[]
  > {
    if (friendIds.length === 0) return [];

    const [posts, comments] = await Promise.all([
      rowsOf(
        await conn.execute(postsByFriendsStatement, { ids: [...friendIds] }),
      ),
      rowsOf(
        await conn.execute(commentsByFriendsStatement, { ids: [...friendIds] }),
      ),
    ]);

    return [
      ...posts.map((row) => ({
        id: row.id as string,
        creationDate: row.creationDate as string,
        kind: "Post" as const,
      })),
      ...comments.map((row) => ({
        id: row.id as string,
        creationDate: row.creationDate as string,
        kind: "Comment" as const,
      })),
    ]
      .toSorted(
        (left, right) =>
          right.creationDate.localeCompare(left.creationDate) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, 10);
  }

  async function IS1(personId: string) {
    const rows = await rowsOf(
      await conn.execute(is1Statement, { id: personId }),
    );
    return { rowCount: rows.length };
  }

  // Real LDBC IS2: friend frontier, then a merged top-10 by creationDate
  // across the (polymorphic) Post/Comment kinds authored by those friends,
  // then the root post + root author of each of those 10 messages — merged
  // and re-sliced in JS rather than a single Cypher UNION, because Ladybug
  // scopes a trailing `ORDER BY ... LIMIT` to only the last UNION branch,
  // not the union as a whole (verified against the installed engine).
  async function IS2(personId: string) {
    const friends = await rowsOf(
      await conn.execute(friendIdsStatement, { id: personId }),
    );
    const friendIds = friends.map((row) => row.id as string);
    const recent = await recentMessagesByFriends(friendIds);

    for (const message of recent) {
      const rootId =
        message.kind === "Post" ?
          message.id
        : await resolveRootPostId(message.id);
      await conn.execute(authorOfPostStatement, { id: rootId });
    }

    return { rowCount: recent.length };
  }

  async function IS3(personId: string) {
    const rows = await rowsOf(
      await conn.execute(friendsWithSinceStatement, { id: personId }),
    );
    return { rowCount: rows.length };
  }

  async function IS4(message: MessageRef) {
    const statement =
      message.kind === "Post" ? is4PostStatement : is4CommentStatement;
    const rows = await rowsOf(
      await conn.execute(statement, { id: message.id }),
    );
    return { rowCount: rows.length };
  }

  async function IS5(message: MessageRef) {
    const statement =
      message.kind === "Post" ?
        authorOfPostStatement
      : authorOfCommentStatement;
    const rows = await rowsOf(
      await conn.execute(statement, { id: message.id }),
    );
    return { rowCount: rows.length };
  }

  async function IS6(message: MessageRef) {
    const rootId =
      message.kind === "Post" ?
        message.id
      : await resolveRootPostId(message.id);
    const forumRows = await rowsOf(
      await conn.execute(forumOfPostStatement, { id: rootId }),
    );
    const moderatorId = forumRows[0]?.moderatorId as string | undefined;
    if (moderatorId === undefined) return { rowCount: 0 };
    const moderatorRows = await rowsOf(
      await conn.execute(personByIdStatement, { id: moderatorId }),
    );
    return { rowCount: moderatorRows.length };
  }

  async function IS7(message: MessageRef) {
    const parentAuthorStatement =
      message.kind === "Post" ?
        authorOfPostStatement
      : authorOfCommentStatement;
    const parentAuthorRows = await rowsOf(
      await conn.execute(parentAuthorStatement, { id: message.id }),
    );
    const parentAuthorId = parentAuthorRows[0]?.id as string | undefined;

    const repliesStatement =
      message.kind === "Post" ?
        repliesOfPostStatement
      : repliesOfCommentStatement;
    const replies = await rowsOf(
      await conn.execute(repliesStatement, { id: message.id }),
    );
    const authorIds = [
      ...new Set(replies.map((row) => row.authorId as string)),
    ];

    if (parentAuthorId !== undefined && authorIds.length > 0) {
      await conn.execute(knowsCheckStatement, {
        authorId: parentAuthorId,
        ids: authorIds,
      });
    }

    return { rowCount: replies.length };
  }

  return { IS1, IS2, IS3, IS4, IS5, IS6, IS7 };
}

export const createLadybugEngine: SnbEngineFactory = async (
  options,
): Promise<SnbEngineHandle> => {
  const tempDir = await mkdtemp(join(tmpdir(), "typegraph-bench-snb-ladybug-"));
  const database = new Database(join(tempDir, "graph.lbug"));
  const conn = new Connection(database);

  // DDL/statement preparation can throw after the database is already
  // open; without this, a failure here would leak the temp directory and
  // native database handle the caller never gets an `SnbEngineHandle` to
  // close().
  try {
    await createSchema(conn);
    const queries = await createQueries(conn);
    const loadStatements = await prepareLoadStatements(conn);

    return {
      name: "ladybugdb",
      fairness:
        "in-process @ladybugdb/core (Kuzu-family embedded engine), no Docker; bulk load via " +
        "prepared UNWIND-CREATE statements (one compiled plan per entity/edge kind, reused across " +
        `${BATCH_SIZE}-row batches); IS1-IS7 point queries run through conn.prepare()+execute() ` +
        "(cached query plan reused per request), matching TypeGraph's .prepare()/.execute() split " +
        "and Neo4j's server-side statement cache.",
      async load() {
        return await loadSnbDataset(
          conn,
          loadStatements,
          options.datasetRoot,
          options.log,
        );
      },
      queries,
      async close() {
        await conn.close();
        await database.close();
        await rm(tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await conn.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    await rm(tempDir, { recursive: true, force: true });
    throw error;
  }
};
