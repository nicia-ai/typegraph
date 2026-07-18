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
 * Bulk load stages each entity/edge kind as its own CSV file, then issues a
 * `COPY <table> FROM '<path>'` per file, instead of batched `UNWIND ...
 * CREATE`. LadybugDB (Kuzu-family) stores relationships in a columnar CSR
 * (Compressed Sparse Row) adjacency structure — excellent for bulk/analytic
 * reads, but incremental `MATCH ... CREATE` edge writes rebuild that
 * structure per call, scaling roughly *cubically* with edge count (measured:
 * 2x edges -> ~8.4x time on a synthetic repro). `COPY FROM` builds the CSR
 * structure once from the whole file, which is what Kuzu/Ladybug's own docs
 * recommend for bulk loading. A relationship table with multiple FROM/TO
 * pairs (e.g. `HasCreator(FROM Post TO Person, FROM Comment TO Person)`)
 * needs one `COPY` per pair, disambiguated with `(from='Post', to='Person')`
 * — verified against the installed engine version, since Kuzu's own docs
 * disagreed with themselves on the option name (`header` vs `headers`).
 * `parallel=false` is set on every copy so a literal newline inside LDBC
 * post/comment content can't break the (default) parallel CSV reader.
 *
 * IS1-IS7 point queries are still `conn.prepare()`d once (at engine
 * construction, right after DDL) and `conn.execute()`d per request — the
 * same fairness point as TypeGraph's `.prepare()`/`.execute()` split
 * documented in `./typegraph-queries.ts`'s module doc: Neo4j caches a Cypher
 * plan by statement text server-side, so an engine driver that recompiled a
 * query per request would be paying a tax the competitors don't.
 */
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";

import { Connection, Database } from "@ladybugdb/core";
import type { PreparedStatement, QueryResult } from "@ladybugdb/core";

import {
  streamSnbCsvDataset,
  type SnbCommentRow,
  type SnbForumRow,
  type SnbIdPools,
  type SnbPersonRow,
  type SnbPostRow,
} from "../dataset/ldbc-csv";
import {
  BFS3_HOPS,
  canonicalDigest,
  compareIdsAscending,
  compareMessageRecencyDesc,
  degreeResult,
  IC13_MAX_HOPS,
  IC9_MAX_DATE,
  IC_MESSAGE_LIMIT,
  type MessageRef,
  type PersonPair,
  reachableSetResult,
  shortestPathDistanceResult,
  type SnbCapabilityGaps,
  type SnbEngineFactory,
  type SnbEngineHandle,
  type SnbQueries,
  unsupportedQuery,
} from "./types";

/**
 * LadybugDB (Kùzu family) gaps: no whole-graph algorithm surface. WCC and
 * whole-component BFS/SSSP have no native primitive, and its variable-length
 * paths are capped at 30 hops and path-enumerate — so these are declared
 * unsupported rather than run as an unbounded, exploding query.
 */
const LADYBUG_UNSUPPORTED: SnbCapabilityGaps = {
  IC14: "weighted shortest path (Kuzu WSHORTEST) not wired for this lane",
  GA_WCC: "no connected-components primitive",
  GA_BFS: "no whole-component BFS (variable-length paths cap at 30 hops)",
  GA_SSSP: "no whole-component SSSP (variable-length paths cap at 30 hops)",
};

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

/** Read every row out of a (possibly multi-statement) query result. */
async function rowsOf(
  result: QueryResult | QueryResult[],
): Promise<readonly Record<string, unknown>[]> {
  const queryResult = Array.isArray(result) ? result.at(-1) : result;
  if (queryResult === undefined) return [];
  return (await queryResult.getAll()) as Record<string, unknown>[];
}

/**
 * `|` rather than the default `,`: LDBC post/comment/forum-title content is
 * natural-language text, which contains commas constantly but a literal
 * pipe almost never — so staging on `|` avoids quoting nearly every large
 * text field. This isn't just cosmetic: a properly double-quote-escaped
 * comma-containing field was observed to break Ladybug's CSV parser when it
 * landed near an internal ~1MB read-buffer boundary in a large file (a
 * small isolated repro of the exact same line parsed fine — only the real,
 * multi-megabyte file reproduced it), so minimizing how often quoting is
 * needed at all is the practical mitigation, not just a style choice.
 */
const CSV_DELIMITER = "|";

/**
 * RFC4180-style CSV field escaping: quote-wrap and double any embedded
 * quote whenever the field contains the delimiter, a quote, or a newline.
 * Ladybug's CSV reader treats a bare empty string as NULL by default, which
 * matches every optional LDBC field this loader ever emits.
 */
function csvField(value: string): string {
  return /[|"\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(fields: readonly string[]): string {
  return `${fields.map(csvField).join(CSV_DELIMITER)}\n`;
}

/** Streams rows to a staging CSV file for a later `COPY ... FROM` load. */
function createCsvStager<T>(
  filePath: string,
  header: readonly string[],
  toFields: (row: T) => readonly string[],
): Readonly<{
  write: (row: T) => Promise<void>;
  finish: () => Promise<void>;
}> {
  const stream = createWriteStream(filePath, { encoding: "utf-8" });
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

type RelCopyOptions = Readonly<{ from: string; to: string }>;

/** `COPY <table> FROM '<path>' (...)` for a node table staged by createCsvStager. */
async function copyNodeTable(
  conn: Connection,
  table: string,
  filePath: string,
): Promise<void> {
  await conn.query(
    `COPY ${table} FROM '${filePath}' ` +
      `(header=true, parallel=false, delim='${CSV_DELIMITER}');`,
  );
}

/**
 * `COPY <table> FROM '<path>' (..., from=..., to=...)` for a relationship
 * table — the `from`/`to` pair disambiguates which of a multi-pair rel
 * table's declared endpoints this file's rows belong to (e.g. `HasCreator`
 * has both `FROM Post TO Person` and `FROM Comment TO Person`).
 */
async function copyRelTable(
  conn: Connection,
  table: string,
  filePath: string,
  pair: RelCopyOptions,
): Promise<void> {
  await conn.query(
    `COPY ${table} FROM '${filePath}' ` +
      `(header=true, parallel=false, delim='${CSV_DELIMITER}', ` +
      `from='${pair.from}', to='${pair.to}');`,
  );
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

type LoadStagers = Readonly<{
  person: ReturnType<typeof createCsvStager<SnbPersonRow>>;
  forum: ReturnType<typeof createCsvStager<SnbForumRow>>;
  post: ReturnType<typeof createCsvStager<SnbPostRow>>;
  comment: ReturnType<typeof createCsvStager<SnbCommentRow>>;
  knows: ReturnType<typeof createCsvStager<KnowsInsertRow>>;
  hasCreatorFromPost: ReturnType<typeof createCsvStager<EdgeInsertRow>>;
  hasCreatorFromComment: ReturnType<typeof createCsvStager<EdgeInsertRow>>;
  containerOf: ReturnType<typeof createCsvStager<EdgeInsertRow>>;
  replyOfToPost: ReturnType<typeof createCsvStager<EdgeInsertRow>>;
  replyOfToComment: ReturnType<typeof createCsvStager<EdgeInsertRow>>;
}>;

type KnowsInsertRow = Readonly<{ fromId: string; toId: string; since: string }>;
type EdgeInsertRow = Readonly<{ fromId: string; toId: string }>;

function createLoadStagers(stageDir: string): LoadStagers {
  const path = (name: string) => join(stageDir, `${name}.csv`);
  return {
    person: createCsvStager<SnbPersonRow>(
      path("person"),
      [
        "id",
        "firstName",
        "lastName",
        "gender",
        "birthday",
        "creationDate",
        "locationIp",
        "browserUsed",
        "cityId",
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
      path("forum"),
      ["id", "title", "creationDate", "moderatorId"],
      (row) => [row.id, row.title, row.creationDate, row.moderatorId],
    ),
    post: createCsvStager<SnbPostRow>(
      path("post"),
      ["id", "content", "creationDate"],
      (row) => [row.id, row.content, row.creationDate],
    ),
    comment: createCsvStager<SnbCommentRow>(
      path("comment"),
      ["id", "content", "creationDate"],
      (row) => [row.id, row.content, row.creationDate],
    ),
    knows: createCsvStager<KnowsInsertRow>(
      path("knows"),
      ["fromId", "toId", "since"],
      (row) => [row.fromId, row.toId, row.since],
    ),
    hasCreatorFromPost: createCsvStager<EdgeInsertRow>(
      path("has-creator-from-post"),
      ["fromId", "toId"],
      (row) => [row.fromId, row.toId],
    ),
    hasCreatorFromComment: createCsvStager<EdgeInsertRow>(
      path("has-creator-from-comment"),
      ["fromId", "toId"],
      (row) => [row.fromId, row.toId],
    ),
    containerOf: createCsvStager<EdgeInsertRow>(
      path("container-of"),
      ["fromId", "toId"],
      (row) => [row.fromId, row.toId],
    ),
    replyOfToPost: createCsvStager<EdgeInsertRow>(
      path("reply-of-to-post"),
      ["fromId", "toId"],
      (row) => [row.fromId, row.toId],
    ),
    replyOfToComment: createCsvStager<EdgeInsertRow>(
      path("reply-of-to-comment"),
      ["fromId", "toId"],
      (row) => [row.fromId, row.toId],
    ),
  };
}

async function loadSnbDataset(
  conn: Connection,
  stageDir: string,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  const stagers = createLoadStagers(stageDir);

  // `stageComplete` fires exactly 5 times, in this fixed order (see
  // `streamSnbCsvDataset` in `../dataset/ldbc-csv.ts`): persons, knows,
  // forums, posts, comments. Each handler below finishes that stage's CSV
  // file(s), then COPYs them — nodes before the edges referencing them,
  // matching the dependency ordering `COPY` requires (endpoint tables must
  // already be populated).
  const stageHandlers: readonly (() => Promise<void>)[] = [
    async () => {
      await stagers.person.finish();
      await copyNodeTable(conn, "Person", join(stageDir, "person.csv"));
    },
    async () => {
      await stagers.knows.finish();
      await copyRelTable(conn, "Knows", join(stageDir, "knows.csv"), {
        from: "Person",
        to: "Person",
      });
    },
    async () => {
      await stagers.forum.finish();
      await copyNodeTable(conn, "Forum", join(stageDir, "forum.csv"));
    },
    async () => {
      await stagers.post.finish();
      await copyNodeTable(conn, "Post", join(stageDir, "post.csv"));
      await stagers.hasCreatorFromPost.finish();
      await copyRelTable(
        conn,
        "HasCreator",
        join(stageDir, "has-creator-from-post.csv"),
        { from: "Post", to: "Person" },
      );
      await stagers.containerOf.finish();
      await copyRelTable(
        conn,
        "ContainerOf",
        join(stageDir, "container-of.csv"),
        { from: "Forum", to: "Post" },
      );
    },
    async () => {
      await stagers.comment.finish();
      await copyNodeTable(conn, "Comment", join(stageDir, "comment.csv"));
      await stagers.hasCreatorFromComment.finish();
      await copyRelTable(
        conn,
        "HasCreator",
        join(stageDir, "has-creator-from-comment.csv"),
        { from: "Comment", to: "Person" },
      );
      await stagers.replyOfToPost.finish();
      await copyRelTable(
        conn,
        "ReplyOf",
        join(stageDir, "reply-of-to-post.csv"),
        { from: "Comment", to: "Post" },
      );
      await stagers.replyOfToComment.finish();
      await copyRelTable(
        conn,
        "ReplyOf",
        join(stageDir, "reply-of-to-comment.csv"),
        { from: "Comment", to: "Comment" },
      );
    },
  ];
  let stageIndex = 0;
  async function stageComplete(): Promise<void> {
    const handler = stageHandlers[stageIndex];
    stageIndex += 1;
    if (handler === undefined) {
      throw new Error(
        `LadybugDB loader received more stageComplete() calls (${stageIndex}) than expected (${stageHandlers.length}).`,
      );
    }
    await handler();
  }

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
            return row.fromKind === "Post" ?
                stagers.hasCreatorFromPost.write({
                  fromId: row.fromId,
                  toId: row.toId,
                })
              : stagers.hasCreatorFromComment.write({
                  fromId: row.fromId,
                  toId: row.toId,
                });
          case "containerOf":
            return stagers.containerOf.write({
              fromId: row.fromId,
              toId: row.toId,
            });
          case "replyOf":
            return row.toKind === "Post" ?
                stagers.replyOfToPost.write({
                  fromId: row.fromId,
                  toId: row.toId,
                })
              : stagers.replyOfToComment.write({
                  fromId: row.fromId,
                  toId: row.toId,
                });
        }
      },
      stageComplete,
    },
    log,
  );

  if (stageIndex !== stageHandlers.length) {
    throw new Error(
      `LadybugDB loader expected ${stageHandlers.length} stageComplete() calls, got ${stageIndex}.`,
    );
  }

  return result.pools;
}

async function createQueries(conn: Connection): Promise<SnbQueries> {
  const is1Statement = await conn.prepare(
    "MATCH (p:Person) WHERE p.id = $id RETURN p.firstName AS firstName, p.lastName AS lastName, " +
      "p.birthday AS birthday, p.locationIp AS locationIp, p.browserUsed AS browserUsed, " +
      "p.cityId AS cityId, p.gender AS gender, p.creationDate AS creationDate;",
  );
  const personByIdStatement = await conn.prepare(
    "MATCH (p:Person) WHERE p.id = $id RETURN p.id AS id, p.firstName AS firstName, p.lastName AS lastName;",
  );
  const friendsWithSinceStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})-[e:Knows]->(friend:Person) RETURN friend.id AS id, " +
      "friend.firstName AS firstName, friend.lastName AS lastName, e.since AS since " +
      "ORDER BY e.since DESC, friend.id ASC;",
  );
  // Native ORDER BY/LIMIT restored, matching the official query's own
  // `ORDER BY messageCreationDate DESC, messageId ASC LIMIT 10` (applied
  // before the root-post-author walk) — this schema splits Post/Comment
  // into separate node types, so IS2's true top 10 across the union comes
  // from fetching *each* type's own top 10 (dataset/ldbc-csv.ts's
  // zero-padded ids make this native ordering numerically correct, not
  // just lexicographic) and merging in recentMessagesOfPerson below: see
  // that function's doc for why "top 10 of (top 10 posts ∪ top 10
  // comments)" is provably equal to the true top 10 regardless of
  // candidate-pool or tie-cluster size, while transferring at most 20 rows.
  const postsByPersonStatement = await conn.prepare(
    "MATCH (person:Person {id: $id})<-[:HasCreator]-(post:Post) " +
      "RETURN post.id AS id, post.content AS content, post.creationDate AS creationDate " +
      "ORDER BY post.creationDate DESC, post.id ASC LIMIT 10;",
  );
  const commentsByPersonStatement = await conn.prepare(
    "MATCH (person:Person {id: $id})<-[:HasCreator]-(comment:Comment) " +
      "RETURN comment.id AS id, comment.content AS content, comment.creationDate AS creationDate " +
      "ORDER BY comment.creationDate DESC, comment.id ASC LIMIT 10;",
  );
  const is4PostStatement = await conn.prepare(
    "MATCH (m:Post {id: $id}) RETURN m.content AS content, m.creationDate AS creationDate;",
  );
  const is4CommentStatement = await conn.prepare(
    "MATCH (m:Comment {id: $id}) RETURN m.content AS content, m.creationDate AS creationDate;",
  );
  const authorOfPostStatement = await conn.prepare(
    "MATCH (m:Post {id: $id})-[:HasCreator]->(author:Person) " +
      "RETURN author.id AS id, author.firstName AS firstName, author.lastName AS lastName;",
  );
  const authorOfCommentStatement = await conn.prepare(
    "MATCH (m:Comment {id: $id})-[:HasCreator]->(author:Person) " +
      "RETURN author.id AS id, author.firstName AS firstName, author.lastName AS lastName;",
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
    "MATCH (f:Forum)-[:ContainerOf]->(post:Post) WHERE post.id = $id " +
      "RETURN f.id AS forumId, f.title AS forumTitle, f.moderatorId AS moderatorId;",
  );
  const repliesOfPostStatement = await conn.prepare(
    "MATCH (reply:Comment)-[:ReplyOf]->(m:Post {id: $id}) MATCH (reply)-[:HasCreator]->(author:Person) " +
      "RETURN reply.id AS id, reply.content AS content, reply.creationDate AS creationDate, " +
      "author.id AS authorId, author.firstName AS authorFirstName, author.lastName AS authorLastName " +
      "ORDER BY reply.creationDate DESC, author.id ASC;",
  );
  const repliesOfCommentStatement = await conn.prepare(
    "MATCH (reply:Comment)-[:ReplyOf]->(m:Comment {id: $id}) MATCH (reply)-[:HasCreator]->(author:Person) " +
      "RETURN reply.id AS id, reply.content AS content, reply.creationDate AS creationDate, " +
      "author.id AS authorId, author.firstName AS authorFirstName, author.lastName AS authorLastName " +
      "ORDER BY reply.creationDate DESC, author.id ASC;",
  );
  const knowsCheckStatement = await conn.prepare(
    "MATCH (author:Person {id: $authorId})-[:Knows]->(friend:Person) WHERE friend.id IN $ids " +
      "RETURN friend.id AS id;",
  );
  // IC13 traversal: native SHORTEST recursive-rel path over `Knows`;
  // `length(e)` is the hop count, and no path within the cap returns zero
  // rows (verified empirically). Knows is loaded in both directions, so the
  // directed pattern reaches the same set an undirected one would.
  const shortestPathStatement = await conn.prepare(
    `MATCH (source:Person {id: $sourceId})-[e:Knows* SHORTEST 1..${IC13_MAX_HOPS}]->(target:Person {id: $targetId}) ` +
      "RETURN length(e) AS distance;",
  );
  // BFS3 traversal: distinct persons within BFS3_HOPS hops of a seed, seed
  // excluded. The seed value is bound under two names ($id, $seedId) so the
  // prepared statement never relies on a single param being referenced twice.
  const neighborhoodStatement = await conn.prepare(
    `MATCH (:Person {id: $id})-[:Knows*1..${BFS3_HOPS}]->(friend:Person) WHERE friend.id <> $seedId ` +
      "RETURN DISTINCT friend.id AS id;",
  );
  // IC2: friends' most recent messages (top-K-of-union split, see IC2 fn).
  // Multi-hop patterns are split into separate MATCH clauses — the direction-
  // changing single-path form (`->...<-`) trips Ladybug's binder.
  const ic2PostsStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})-[:Knows]->(friend:Person) " +
      "MATCH (friend)<-[:HasCreator]-(post:Post) " +
      "RETURN friend.id AS friendId, friend.firstName AS friendFirstName, friend.lastName AS friendLastName, " +
      "post.id AS id, post.content AS content, post.creationDate AS creationDate " +
      `ORDER BY post.creationDate DESC, post.id DESC LIMIT ${IC_MESSAGE_LIMIT};`,
  );
  const ic2CommentsStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})-[:Knows]->(friend:Person) " +
      "MATCH (friend)<-[:HasCreator]-(comment:Comment) " +
      "RETURN friend.id AS friendId, friend.firstName AS friendFirstName, friend.lastName AS friendLastName, " +
      "comment.id AS id, comment.content AS content, comment.creationDate AS creationDate " +
      `ORDER BY comment.creationDate DESC, comment.id DESC LIMIT ${IC_MESSAGE_LIMIT};`,
  );
  // IC8: recent replies to the person's own messages (replies to Posts and to
  // Comments are disjoint).
  const ic8RepliesToPostsStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})<-[:HasCreator]-(post:Post) " +
      "MATCH (post)<-[:ReplyOf]-(reply:Comment) " +
      "MATCH (reply)-[:HasCreator]->(author:Person) " +
      "RETURN author.id AS authorId, author.firstName AS authorFirstName, author.lastName AS authorLastName, " +
      "reply.id AS id, reply.content AS content, reply.creationDate AS creationDate " +
      `ORDER BY reply.creationDate DESC, reply.id DESC LIMIT ${IC_MESSAGE_LIMIT};`,
  );
  const ic8RepliesToCommentsStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})<-[:HasCreator]-(message:Comment) " +
      "MATCH (message)<-[:ReplyOf]-(reply:Comment) " +
      "MATCH (reply)-[:HasCreator]->(author:Person) " +
      "RETURN author.id AS authorId, author.firstName AS authorFirstName, author.lastName AS authorLastName, " +
      "reply.id AS id, reply.content AS content, reply.creationDate AS creationDate " +
      `ORDER BY reply.creationDate DESC, reply.id DESC LIMIT ${IC_MESSAGE_LIMIT};`,
  );
  // IC9: friends+FoF (2-hop knows, self excluded) messages before the cutoff.
  // DISTINCT collapses the duplicate (fof, message) rows a multi-path
  // variable-length match produces, so the LIMIT sees distinct messages.
  const ic9PostsStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})-[:Knows*1..2]->(fof:Person) " +
      "MATCH (fof)<-[:HasCreator]-(post:Post) " +
      "WHERE fof.id <> $seedId AND post.creationDate < $maxDate " +
      "RETURN DISTINCT fof.id AS creatorId, fof.firstName AS creatorFirstName, fof.lastName AS creatorLastName, " +
      "post.id AS id, post.content AS content, post.creationDate AS creationDate " +
      // ORDER BY the projected aliases, not `post.*`: after RETURN DISTINCT the
      // `post` variable leaves scope, so `ORDER BY post.creationDate` fails
      // Ladybug's binder ("Variable post is not in scope").
      `ORDER BY creationDate DESC, id DESC LIMIT ${IC_MESSAGE_LIMIT};`,
  );
  const ic9CommentsStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})-[:Knows*1..2]->(fof:Person) " +
      "MATCH (fof)<-[:HasCreator]-(comment:Comment) " +
      "WHERE fof.id <> $seedId AND comment.creationDate < $maxDate " +
      "RETURN DISTINCT fof.id AS creatorId, fof.firstName AS creatorFirstName, fof.lastName AS creatorLastName, " +
      "comment.id AS id, comment.content AS content, comment.creationDate AS creationDate " +
      `ORDER BY creationDate DESC, id DESC LIMIT ${IC_MESSAGE_LIMIT};`,
  );
  const degreeStatement = await conn.prepare(
    "MATCH (p:Person {id: $id})-[:Knows]->(:Person) RETURN count(*) AS degree;",
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
    return root["id"] as string;
  }

  async function recentMessagesOfPerson(personId: string): Promise<
    readonly Readonly<{
      id: string;
      content: string;
      creationDate: string;
      kind: "Post" | "Comment";
    }>[]
  > {
    const [posts, comments] = await Promise.all([
      rowsOf(await conn.execute(postsByPersonStatement, { id: personId })),
      rowsOf(await conn.execute(commentsByPersonStatement, { id: personId })),
    ]);

    // Official IS2 tie-break is creationDate DESC, messageId ASC. Each
    // input list is already that engine's own top 10 for its type (native
    // ORDER BY/LIMIT above); re-sorting this small (<=20 row) merged set
    // with the numeric-aware comparator guarantees the final order is
    // identical across engines regardless of native collation differences
    // (see compareIdsAscending's doc).
    return [
      ...posts.map((row) => ({
        id: row["id"] as string,
        content: row["content"] as string,
        creationDate: row["creationDate"] as string,
        kind: "Post" as const,
      })),
      ...comments.map((row) => ({
        id: row["id"] as string,
        content: row["content"] as string,
        creationDate: row["creationDate"] as string,
        kind: "Comment" as const,
      })),
    ]
      .toSorted(
        (left, right) =>
          right.creationDate.localeCompare(left.creationDate) ||
          compareIdsAscending(left.id, right.id),
      )
      .slice(0, 10);
  }

  async function IS1(personId: string) {
    const rows = await rowsOf(
      await conn.execute(is1Statement, { id: personId }),
    );
    return { rowCount: rows.length, digest: canonicalDigest(rows) };
  }

  // Official LDBC IS2: the given person's own last 10 messages (creationDate
  // DESC, id ASC), then the root post + root author of each of those 10
  // messages — merged and re-sliced in JS rather than a single Cypher UNION,
  // because Ladybug scopes a trailing `ORDER BY ... LIMIT` to only the last
  // UNION branch, not the union as a whole (verified against the installed
  // engine). Previously this traversed to friends first and measured
  // messages *they* authored — a materially different (and heavier)
  // workload than the official query, which reads directly off the given
  // person.
  async function IS2(personId: string) {
    const recent = await recentMessagesOfPerson(personId);

    const canonicalRows = [];
    for (const message of recent) {
      const rootId =
        message.kind === "Post" ?
          message.id
        : await resolveRootPostId(message.id);
      const authorRows = await rowsOf(
        await conn.execute(authorOfPostStatement, { id: rootId }),
      );
      const author = authorRows[0];
      canonicalRows.push({
        messageId: message.id,
        content: message.content,
        creationDate: message.creationDate,
        postId: rootId,
        personId: author?.["id"],
        firstName: author?.["firstName"],
        lastName: author?.["lastName"],
      });
    }

    return {
      rowCount: recent.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IS3(personId: string) {
    const rows = await rowsOf(
      await conn.execute(friendsWithSinceStatement, { id: personId }),
    );
    // Cypher's own id tie-break above is a plain string compare; re-sorted
    // here with a numeric-aware comparator (see compareIdsAscending's doc)
    // for cross-engine digest consistency. Canonical field is `personId`
    // (matching the official LDBC output name and every other engine's
    // digest), not this query's own `id` alias.
    const canonicalRows = rows
      .toSorted(
        (left, right) =>
          (right["since"] as string).localeCompare(left["since"] as string) ||
          compareIdsAscending(left["id"] as string, right["id"] as string),
      )
      .map((row) => ({
        personId: row["id"],
        firstName: row["firstName"],
        lastName: row["lastName"],
        since: row["since"],
      }));
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IS4(message: MessageRef) {
    const statement =
      message.kind === "Post" ? is4PostStatement : is4CommentStatement;
    const rows = await rowsOf(
      await conn.execute(statement, { id: message.id }),
    );
    return { rowCount: rows.length, digest: canonicalDigest(rows) };
  }

  async function IS5(message: MessageRef) {
    const statement =
      message.kind === "Post" ?
        authorOfPostStatement
      : authorOfCommentStatement;
    const rows = await rowsOf(
      await conn.execute(statement, { id: message.id }),
    );
    return { rowCount: rows.length, digest: canonicalDigest(rows) };
  }

  async function IS6(message: MessageRef) {
    const rootId =
      message.kind === "Post" ?
        message.id
      : await resolveRootPostId(message.id);
    const forumRows = await rowsOf(
      await conn.execute(forumOfPostStatement, { id: rootId }),
    );
    const forum = forumRows[0];
    const moderatorId = forum?.["moderatorId"] as string | undefined;
    if (moderatorId === undefined) {
      return { rowCount: 0, digest: canonicalDigest([]) };
    }
    const moderatorRows = await rowsOf(
      await conn.execute(personByIdStatement, { id: moderatorId }),
    );
    const moderator = moderatorRows[0];
    const canonicalRow = {
      forumId: forum!["forumId"],
      forumTitle: forum!["forumTitle"],
      moderatorId,
      moderatorFirstName: moderator?.["firstName"],
      moderatorLastName: moderator?.["lastName"],
    };
    return {
      rowCount: moderatorRows.length,
      digest: canonicalDigest([canonicalRow]),
    };
  }

  async function IS7(message: MessageRef) {
    const parentAuthorStatement =
      message.kind === "Post" ?
        authorOfPostStatement
      : authorOfCommentStatement;
    const parentAuthorRows = await rowsOf(
      await conn.execute(parentAuthorStatement, { id: message.id }),
    );
    const parentAuthorId = parentAuthorRows[0]?.["id"] as string | undefined;

    const repliesStatement =
      message.kind === "Post" ?
        repliesOfPostStatement
      : repliesOfCommentStatement;
    const replies = await rowsOf(
      await conn.execute(repliesStatement, { id: message.id }),
    );
    const authorIds = [
      ...new Set(replies.map((row) => row["authorId"] as string)),
    ];

    let knowsAuthorIds = new Set<string>();
    if (parentAuthorId !== undefined && authorIds.length > 0) {
      const knowsRows = await rowsOf(
        await conn.execute(knowsCheckStatement, {
          authorId: parentAuthorId,
          ids: authorIds,
        }),
      );
      knowsAuthorIds = new Set(knowsRows.map((row) => row["id"] as string));
    }

    // Cypher's own id tie-break above is a plain string compare; re-sorted
    // here with a numeric-aware comparator (see compareIdsAscending's doc)
    // for cross-engine digest consistency.
    const canonicalRows = replies
      .toSorted(
        (left, right) =>
          (right["creationDate"] as string).localeCompare(
            left["creationDate"] as string,
          ) ||
          compareIdsAscending(
            left["authorId"] as string,
            right["authorId"] as string,
          ),
      )
      .map((reply) => ({
        commentId: reply["id"],
        content: reply["content"],
        creationDate: reply["creationDate"],
        replyAuthorId: reply["authorId"],
        replyAuthorFirstName: reply["authorFirstName"],
        replyAuthorLastName: reply["authorLastName"],
        replyAuthorKnowsOriginalMessageAuthor: knowsAuthorIds.has(
          reply["authorId"] as string,
        ),
      }));

    return {
      rowCount: replies.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IC13(pair: PersonPair) {
    const rows = await rowsOf(
      await conn.execute(shortestPathStatement, {
        sourceId: pair.sourceId,
        targetId: pair.targetId,
      }),
    );
    const distance = rows[0]?.distance;
    return shortestPathDistanceResult(
      distance === undefined ? undefined : Number(distance),
    );
  }

  async function BFS3(personId: string) {
    const rows = await rowsOf(
      await conn.execute(neighborhoodStatement, {
        id: personId,
        seedId: personId,
      }),
    );
    return reachableSetResult(rows.map((row) => String(row.id)));
  }

  async function IC2(personId: string) {
    const [posts, comments] = await Promise.all([
      rowsOf(await conn.execute(ic2PostsStatement, { id: personId })),
      rowsOf(await conn.execute(ic2CommentsStatement, { id: personId })),
    ]);
    const canonicalRows = [...posts, ...comments]
      .map((row) => ({
        friendId: String(row.friendId),
        friendFirstName: String(row.friendFirstName),
        friendLastName: String(row.friendLastName),
        id: String(row.id),
        content: String(row.content),
        creationDate: String(row.creationDate),
      }))
      .toSorted((left, right) => compareMessageRecencyDesc(left, right))
      .slice(0, IC_MESSAGE_LIMIT)
      .map((row) => ({
        friendId: row.friendId,
        friendFirstName: row.friendFirstName,
        friendLastName: row.friendLastName,
        messageId: row.id,
        messageContent: row.content,
        messageCreationDate: row.creationDate,
      }));
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IC8(personId: string) {
    const [toPosts, toComments] = await Promise.all([
      rowsOf(await conn.execute(ic8RepliesToPostsStatement, { id: personId })),
      rowsOf(
        await conn.execute(ic8RepliesToCommentsStatement, { id: personId }),
      ),
    ]);
    const canonicalRows = [...toPosts, ...toComments]
      .map((row) => ({
        authorId: String(row.authorId),
        authorFirstName: String(row.authorFirstName),
        authorLastName: String(row.authorLastName),
        id: String(row.id),
        content: String(row.content),
        creationDate: String(row.creationDate),
      }))
      .toSorted((left, right) => compareMessageRecencyDesc(left, right))
      .slice(0, IC_MESSAGE_LIMIT)
      .map((row) => ({
        replyAuthorId: row.authorId,
        replyAuthorFirstName: row.authorFirstName,
        replyAuthorLastName: row.authorLastName,
        commentId: row.id,
        commentContent: row.content,
        commentCreationDate: row.creationDate,
      }));
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IC9(personId: string) {
    const params = {
      id: personId,
      seedId: personId,
      maxDate: IC9_MAX_DATE,
    };
    const [posts, comments] = await Promise.all([
      rowsOf(await conn.execute(ic9PostsStatement, params)),
      rowsOf(await conn.execute(ic9CommentsStatement, params)),
    ]);
    const canonicalRows = [...posts, ...comments]
      .map((row) => ({
        creatorId: String(row.creatorId),
        creatorFirstName: String(row.creatorFirstName),
        creatorLastName: String(row.creatorLastName),
        id: String(row.id),
        content: String(row.content),
        creationDate: String(row.creationDate),
      }))
      .toSorted((left, right) => compareMessageRecencyDesc(left, right))
      .slice(0, IC_MESSAGE_LIMIT)
      .map((row) => ({
        personId: row.creatorId,
        personFirstName: row.creatorFirstName,
        personLastName: row.creatorLastName,
        messageId: row.id,
        messageContent: row.content,
        messageCreationDate: row.creationDate,
      }));
    return {
      rowCount: canonicalRows.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function GA_DEGREE(personId: string) {
    const rows = await rowsOf(
      await conn.execute(degreeStatement, { id: personId }),
    );
    return degreeResult(Number(rows[0]?.degree ?? 0));
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
    IC14: unsupportedQuery("IC14"),
    GA_WCC: unsupportedQuery("GA_WCC"),
    GA_BFS: unsupportedQuery("GA_BFS"),
    GA_SSSP: unsupportedQuery("GA_SSSP"),
  };
}

export const createLadybugEngine: SnbEngineFactory = async (
  options,
): Promise<SnbEngineHandle> => {
  const tempDir = await mkdtemp(join(tmpdir(), "typegraph-bench-snb-ladybug-"));
  const stageDir = join(tempDir, "stage");
  const database = new Database(join(tempDir, "graph.lbug"));
  const conn = new Connection(database);

  // DDL/statement preparation can throw after the database is already
  // open; without this, a failure here would leak the temp directory and
  // native database handle the caller never gets an `SnbEngineHandle` to
  // close().
  try {
    await mkdir(stageDir, { recursive: true });
    await createSchema(conn);
    const queries = await createQueries(conn);

    return {
      name: "ladybugdb",
      fairness:
        "in-process @ladybugdb/core (Kuzu-family embedded engine), no Docker; bulk load stages " +
        "each entity/edge kind to a CSV file and issues one COPY FROM per file (Ladybug's CSR " +
        "adjacency structure scales badly with incremental MATCH+CREATE edge writes — COPY FROM " +
        "builds it once from the whole file); IS1-IS7 point queries run through " +
        "conn.prepare()+execute() (cached query plan reused per request), matching TypeGraph's " +
        ".prepare()/.execute() split and Neo4j's server-side statement cache.",
      unsupported: LADYBUG_UNSUPPORTED,
      async load() {
        return await loadSnbDataset(
          conn,
          stageDir,
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
