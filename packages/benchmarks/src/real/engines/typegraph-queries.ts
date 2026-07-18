/**
 * IS1-IS7 implemented through the TypeGraph query builder — shared between
 * the SQLite and PostgreSQL engine drivers, since only backend construction
 * differs between them. This is the product under test: no hand-written
 * SQL anywhere in this file (docs/design/benchmark-program-plan.md).
 *
 * Point-lookup steps are `.prepare()`d once (with `param()` placeholders)
 * and `.execute()`d per request, matching how Neo4j caches a Cypher plan by
 * statement text and LadybugDB caches a prepared statement — without this,
 * TypeGraph would unfairly pay a per-request compile cost the competitors
 * don't. Steps whose shape genuinely varies per request (a variable-length
 * `IN` list) are executed fresh; that variability is inherent to the query,
 * not a TypeGraph-specific tax.
 */
import { param } from "@nicia-ai/typegraph";

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
  KNOWS_WEIGHT_PROPERTY,
  type MessageRef,
  type PersonPair,
  reachableSetResult,
  shortestPathDistanceResult,
  weightedShortestPathResult,
  type SnbQueries,
  ssspResult,
} from "./types";
import { type SnbStore } from "../schema/snb-graph";

const ROOT_WALK_MAX_HOPS = 100;

/**
 * Transaction-scoped `work_mem` for the iterative graph algorithms. As of
 * typegraph#285 the library no longer defaults this — an unset value inherits
 * the server's `work_mem` (Postgres' 4MB default), which forces the
 * label-propagation / BFS working tables to spill to disk on the SF1 `knows`
 * graph. Setting it back to 64MB restores the previous behavior and is the
 * fair server-config choice for a benchmark host. A documented no-op on
 * SQLite, so it is safe on this shared (SQLite + Postgres) query path.
 */
const ALGORITHM_WORKING_MEMORY = "64MB";

export function createSnbQueries(store: SnbStore): SnbQueries {
  const personById = store
    .query()
    .from("Person", "p")
    .whereNode("p", (person) => person.id.eq(param("id")))
    .select((ctx) => ({
      id: ctx.p.id,
      firstName: ctx.p.firstName,
      lastName: ctx.p.lastName,
    }))
    .prepare();

  const is1 = store
    .query()
    .from("Person", "p")
    .whereNode("p", (person) => person.id.eq(param("id")))
    .select((ctx) => ({
      firstName: ctx.p.firstName,
      lastName: ctx.p.lastName,
      birthday: ctx.p.birthday,
      locationIp: ctx.p.locationIp,
      browserUsed: ctx.p.browserUsed,
      cityId: ctx.p.cityId,
      gender: ctx.p.gender,
      creationDate: ctx.p.creationDate,
    }))
    .prepare();

  const friendsOf = store
    .query()
    .from("Person", "p")
    .whereNode("p", (person) => person.id.eq(param("id")))
    .traverse("knows", "e", { expand: "none" })
    .to("Person", "friend")
    .select((ctx) => ({
      personId: ctx.friend.id,
      firstName: ctx.friend.firstName,
      lastName: ctx.friend.lastName,
      since: ctx.e.since,
    }))
    .prepare();

  const is4Post = store
    .query()
    .from("Post", "m")
    .whereNode("m", (message) => message.id.eq(param("id")))
    .select((ctx) => ({
      content: ctx.m.content,
      creationDate: ctx.m.creationDate,
    }))
    .prepare();
  const is4Comment = store
    .query()
    .from("Comment", "m")
    .whereNode("m", (message) => message.id.eq(param("id")))
    .select((ctx) => ({
      content: ctx.m.content,
      creationDate: ctx.m.creationDate,
    }))
    .prepare();

  const authorOfPost = store
    .query()
    .from("Post", "m")
    .whereNode("m", (message) => message.id.eq(param("id")))
    .traverse("hasCreator", "e", { expand: "none" })
    .to("Person", "creator")
    .select((ctx) => ({
      id: ctx.creator.id,
      firstName: ctx.creator.firstName,
      lastName: ctx.creator.lastName,
    }))
    .prepare();
  const authorOfComment = store
    .query()
    .from("Comment", "m")
    .whereNode("m", (message) => message.id.eq(param("id")))
    .traverse("hasCreator", "e", { expand: "none" })
    .to("Person", "creator")
    .select((ctx) => ({
      id: ctx.creator.id,
      firstName: ctx.creator.firstName,
      lastName: ctx.creator.lastName,
    }))
    .prepare();

  // Reply-chain root walk: replyOf is polymorphic (Comment -> Post | Comment),
  // so the recursive traversal targets the `Message` ontological supertype
  // via includeSubClasses and returns the WHOLE ancestor chain with depth;
  // the root is the max-depth row (a Post, since Post has no outgoing
  // replyOf edge and the walk cannot continue past it).
  const replyOfAncestors = store
    .query()
    .from("Comment", "c")
    .whereNode("c", (comment) => comment.id.eq(param("id")))
    .traverse("replyOf", "e", { expand: "none" })
    .recursive({
      minHops: 1,
      maxHops: ROOT_WALK_MAX_HOPS,
      cyclePolicy: "prevent",
      depth: "d",
    })
    .to("Message", "root", { includeSubClasses: true })
    .select((ctx) => ({ id: ctx.root.id, depth: ctx.d }))
    .prepare();

  async function resolveRootPostId(commentId: string): Promise<string> {
    const ancestors = await replyOfAncestors.execute({ id: commentId });
    if (ancestors.length === 0) {
      throw new Error(
        `replyOf root walk found no ancestors for comment ${commentId}`,
      );
    }
    return ancestors.reduce((deepest, row) =>
      row.depth > deepest.depth ? row : deepest,
    ).id;
  }

  const forumOfPost = store
    .query()
    .from("Post", "post")
    .whereNode("post", (post) => post.id.eq(param("id")))
    .traverse("containerOf", "e", { expand: "none", direction: "in" })
    .to("Forum", "f")
    .select((ctx) => ({
      forumId: ctx.f.id,
      title: ctx.f.title,
      moderatorId: ctx.f.moderatorId,
    }))
    .prepare();

  const repliesOfPost = store
    .query()
    .from("Post", "p")
    .whereNode("p", (post) => post.id.eq(param("id")))
    .traverse("replyOf", "e", { expand: "none", direction: "in" })
    .to("Comment", "reply")
    .traverse("hasCreator", "e2", { expand: "none" })
    .to("Person", "author")
    .select((ctx) => ({
      id: ctx.reply.id,
      content: ctx.reply.content,
      creationDate: ctx.reply.creationDate,
      authorId: ctx.author.id,
      authorFirstName: ctx.author.firstName,
      authorLastName: ctx.author.lastName,
    }))
    .orderBy("reply", "creationDate", "desc")
    .orderBy("author", "id", "asc")
    .prepare();
  const repliesOfComment = store
    .query()
    .from("Comment", "p")
    .whereNode("p", (comment) => comment.id.eq(param("id")))
    .traverse("replyOf", "e", { expand: "none", direction: "in" })
    .to("Comment", "reply")
    .traverse("hasCreator", "e2", { expand: "none" })
    .to("Person", "author")
    .select((ctx) => ({
      id: ctx.reply.id,
      content: ctx.reply.content,
      creationDate: ctx.reply.creationDate,
      authorId: ctx.author.id,
      authorFirstName: ctx.author.firstName,
      authorLastName: ctx.author.lastName,
    }))
    .orderBy("reply", "creationDate", "desc")
    .orderBy("author", "id", "asc")
    .prepare();

  // Official LDBC IS2 fetches the *given* person's own messages
  // (`(:Person {id})<-[:HAS_CREATOR]-(message)`), not friends' — this
  // benchmark's implementations previously traversed to friends first,
  // measuring a materially different (and heavier) workload. Fixed shape
  // (single person id, not a variable-length list), so — unlike the old
  // friend-list join — these are genuinely prepare()-able.
  //
  // Native `ORDER BY ... LIMIT 10` restored (matching the official query's
  // own `ORDER BY messageCreationDate DESC, messageId ASC LIMIT 10`,
  // applied before the root-post-author walk) — this schema splits
  // Post/Comment into separate node types, so IS2's true top 10 across the
  // union is derived by fetching *each* type's own top 10 (this file's
  // `ID_PAD_WIDTH`-zero-padded ids, see dataset/ldbc-csv.ts, make this
  // native ordering numerically correct, not just lexicographic) and
  // merging in `recentMessagesOfPerson` below: any message ranking in the
  // true top 10 of the union can have at most 9 messages of its own type
  // ranked above it, so it's necessarily in that type's own top 10 too —
  // this makes "top 10 of (top 10 posts ∪ top 10 comments)" provably equal
  // to the true top 10, for any candidate-pool size or tie-cluster size,
  // while transferring at most 20 rows regardless of how many messages the
  // person has actually authored.
  const recentPostsOfPerson = store
    .query()
    .from("Person", "author")
    .whereNode("author", (person) => person.id.eq(param("id")))
    .traverse("hasCreator", "e", { expand: "none", direction: "in" })
    .to("Post", "post")
    .select((ctx) => ({
      id: ctx.post.id,
      content: ctx.post.content,
      creationDate: ctx.post.creationDate,
    }))
    .orderBy("post", "creationDate", "desc")
    .orderBy("post", "id", "asc")
    .limit(10)
    .prepare();
  const recentCommentsOfPerson = store
    .query()
    .from("Person", "author")
    .whereNode("author", (person) => person.id.eq(param("id")))
    .traverse("hasCreator", "e", { expand: "none", direction: "in" })
    .to("Comment", "comment")
    .select((ctx) => ({
      id: ctx.comment.id,
      content: ctx.comment.content,
      creationDate: ctx.comment.creationDate,
    }))
    .orderBy("comment", "creationDate", "desc")
    .orderBy("comment", "id", "asc")
    .limit(10)
    .prepare();

  async function recentMessagesOfPerson(personId: string): Promise<
    readonly {
      id: string;
      content: string;
      creationDate: string;
      kind: "Post" | "Comment";
    }[]
  > {
    const [posts, comments] = await Promise.all([
      recentPostsOfPerson.execute({ id: personId }),
      recentCommentsOfPerson.execute({ id: personId }),
    ]);

    // Official IS2 tie-break is creationDate DESC, messageId ASC. Each
    // input list is already that engine's own top 10 for its type (native
    // ORDER BY/LIMIT above); re-sorting this small (<=20 row) merged set
    // with the numeric-aware comparator guarantees the final order is
    // identical across engines regardless of native collation differences
    // (see compareIdsAscending's doc).
    return [
      ...posts.map((row) => ({ ...row, kind: "Post" as const })),
      ...comments.map((row) => ({ ...row, kind: "Comment" as const })),
    ]
      .toSorted(
        (left, right) =>
          right.creationDate.localeCompare(left.creationDate) ||
          compareIdsAscending(left.id, right.id),
      )
      .slice(0, 10);
  }

  async function IS1(personId: string) {
    const rows = await is1.execute({ id: personId });
    return { rowCount: rows.length, digest: canonicalDigest(rows) };
  }

  // Official LDBC IS2: the given person's own last 10 messages (creationDate
  // DESC, id ASC), then the root post + root author of each of those 10
  // messages. This is the un-batched per-message root walk (readability
  // over the batched multi-seed CTE the SQL reference driver uses — see
  // module doc).
  async function IS2(personId: string) {
    const recent = await recentMessagesOfPerson(personId);

    const canonicalRows = [];
    for (const message of recent) {
      const rootId =
        message.kind === "Post" ?
          message.id
        : await resolveRootPostId(message.id);
      const authorRows = await authorOfPost.execute({ id: rootId });
      const author = authorRows[0];
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

    return {
      rowCount: recent.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  async function IS3(personId: string) {
    const rows = await friendsOf.execute({ id: personId });
    // Official IS3 ordering is friendshipCreationDate DESC, personId ASC.
    const sorted = rows.toSorted(
      (left, right) =>
        right.since.localeCompare(left.since) ||
        compareIdsAscending(left.personId, right.personId),
    );
    return { rowCount: sorted.length, digest: canonicalDigest(sorted) };
  }

  async function IS4(message: MessageRef) {
    const rows = await (message.kind === "Post" ? is4Post : is4Comment).execute(
      {
        id: message.id,
      },
    );
    return { rowCount: rows.length, digest: canonicalDigest(rows) };
  }

  async function IS5(message: MessageRef) {
    const rows = await (
      message.kind === "Post" ?
        authorOfPost
      : authorOfComment).execute({
      id: message.id,
    });
    return { rowCount: rows.length, digest: canonicalDigest(rows) };
  }

  async function IS6(message: MessageRef) {
    const rootId =
      message.kind === "Post" ?
        message.id
      : await resolveRootPostId(message.id);
    const forumRows = await forumOfPost.execute({ id: rootId });
    if (forumRows.length === 0) {
      return { rowCount: 0, digest: canonicalDigest([]) };
    }
    const forum = forumRows[0]!;
    const moderatorRows = await personById.execute({
      id: forum.moderatorId,
    });
    const moderator = moderatorRows[0];
    const canonicalRow = {
      forumId: forum.forumId,
      forumTitle: forum.title,
      moderatorId: forum.moderatorId,
      moderatorFirstName: moderator?.firstName,
      moderatorLastName: moderator?.lastName,
    };
    return {
      rowCount: moderatorRows.length,
      digest: canonicalDigest([canonicalRow]),
    };
  }

  async function IS7(message: MessageRef) {
    const parentAuthorRows = await (
      message.kind === "Post" ?
        authorOfPost
      : authorOfComment).execute({ id: message.id });
    const parentAuthorId = parentAuthorRows[0]?.id;

    const replies = await (
      message.kind === "Post" ?
        repliesOfPost
      : repliesOfComment).execute({
      id: message.id,
    });
    const authorIds = [...new Set(replies.map((row) => row.authorId))];

    let knowsAuthorIds = new Set<string>();
    if (parentAuthorId !== undefined && authorIds.length > 0) {
      const knowsRows = await store
        .query()
        .from("Person", "author")
        .whereNode("author", (author) => author.id.eq(parentAuthorId))
        .traverse("knows", "e", { expand: "none" })
        .to("Person", "friend")
        .whereNode("friend", (friend) => friend.id.in(authorIds))
        .select((ctx) => ({ id: ctx.friend.id }))
        .execute();
      knowsAuthorIds = new Set(knowsRows.map((row) => row.id));
    }

    // Official IS7 ordering is commentCreationDate DESC, replyAuthorId ASC.
    const canonicalRows = replies
      .toSorted(
        (left, right) =>
          right.creationDate.localeCompare(left.creationDate) ||
          compareIdsAscending(left.authorId, right.authorId),
      )
      .map((reply) => ({
        commentId: reply.id,
        content: reply.content,
        creationDate: reply.creationDate,
        replyAuthorId: reply.authorId,
        replyAuthorFirstName: reply.authorFirstName,
        replyAuthorLastName: reply.authorLastName,
        replyAuthorKnowsOriginalMessageAuthor: knowsAuthorIds.has(
          reply.authorId,
        ),
      }));

    return {
      rowCount: replies.length,
      digest: canonicalDigest(canonicalRows),
    };
  }

  // IC13 (traversal): shortest-path hop distance between two persons over the
  // `knows` graph, via TypeGraph's native `shortestPath` — the correct
  // targeted primitive for this question, matching every other engine's
  // targeted BFS pathfinder. `knows` is loaded in both directions (see
  // dataset/ldbc-csv.ts), so `direction: "out"` is undirected reachability.
  //
  // KNOWN LIMITATION (typegraph#271): `shortestPath`/`reachable`/`neighbors`
  // compile to a recursive CTE that enumerates paths (UNION ALL, per-path
  // cycle check), not a set-based BFS — cost grows ~7x per hop regardless of
  // the reachable-set size, so this is infeasible past ~4-5 hops on a dense
  // graph (measured: 44s for one pair at maxHops=8 on the 31-person smoke
  // fixture). IC13 therefore cannot run on TypeGraph at realistic `knows`
  // distances until that algorithm is reworked; this driver is written for
  // the fixed API and will run once the CTE does per-node dedup.
  async function IC13(pair: PersonPair) {
    const path = await store.algorithms.shortestPath(
      pair.sourceId,
      pair.targetId,
      {
        edges: ["knows"],
        maxHops: IC13_MAX_HOPS,
        direction: "out",
        workingMemory: ALGORITHM_WORKING_MEMORY,
      },
    );
    return shortestPathDistanceResult(path?.depth);
  }

  // IC14 (traversal): the minimum-total-weight route between two persons over
  // `knows`, where each edge carries the synthetic `weight` materialized at
  // load. Exercises TypeGraph's weightedShortestPath (#288) — a cost-ordered
  // Dijkstra on the D2 iterative substrate, so it takes the same 64MB
  // work_mem as the other iterative algorithms. No competitor runs this
  // (see the per-engine capability gaps), so it is a SQLite-vs-Postgres
  // comparison of the weighted-path primitive.
  async function IC14(pair: PersonPair) {
    const path = await store.algorithms.weightedShortestPath(
      pair.sourceId,
      pair.targetId,
      {
        edges: ["knows"],
        weightProperty: KNOWS_WEIGHT_PROPERTY,
        direction: "out",
        workingMemory: ALGORITHM_WORKING_MEMORY,
      },
    );
    return weightedShortestPathResult(path?.totalWeight);
  }

  // BFS3 (traversal): the distinct persons within BFS3_HOPS hops of a seed
  // over `knows`, via the native neighborhood algorithm (source excluded by
  // contract). Same undirected-via-bidirectional-edges reasoning as IC13.
  async function BFS3(personId: string) {
    const reached = await store.algorithms.neighbors(personId, {
      edges: ["knows"],
      depth: BFS3_HOPS,
      direction: "out",
      workingMemory: ALGORITHM_WORKING_MEMORY,
    });
    return reachableSetResult(reached.map((node) => node.id));
  }

  // IC2 (complex read): the given person's friends' most recent messages.
  // Post/Comment are split node types, so — like IS2 — the true top-K across
  // the union is the top-K of (top-K posts ∪ top-K comments): any message in
  // the true top-K has at most K-1 messages of its own type above it, so it
  // is in that type's own top-K. Each side carries its friend (creator).
  const ic2Posts = store
    .query()
    .from("Person", "p")
    .whereNode("p", (person) => person.id.eq(param("id")))
    .traverse("knows", "k", { expand: "none" })
    .to("Person", "friend")
    .traverse("hasCreator", "hc", { expand: "none", direction: "in" })
    .to("Post", "post")
    .select((ctx) => ({
      friendId: ctx.friend.id,
      friendFirstName: ctx.friend.firstName,
      friendLastName: ctx.friend.lastName,
      id: ctx.post.id,
      content: ctx.post.content,
      creationDate: ctx.post.creationDate,
    }))
    .orderBy("post", "creationDate", "desc")
    .orderBy("post", "id", "desc")
    .limit(IC_MESSAGE_LIMIT)
    .prepare();
  const ic2Comments = store
    .query()
    .from("Person", "p")
    .whereNode("p", (person) => person.id.eq(param("id")))
    .traverse("knows", "k", { expand: "none" })
    .to("Person", "friend")
    .traverse("hasCreator", "hc", { expand: "none", direction: "in" })
    .to("Comment", "comment")
    .select((ctx) => ({
      friendId: ctx.friend.id,
      friendFirstName: ctx.friend.firstName,
      friendLastName: ctx.friend.lastName,
      id: ctx.comment.id,
      content: ctx.comment.content,
      creationDate: ctx.comment.creationDate,
    }))
    .orderBy("comment", "creationDate", "desc")
    .orderBy("comment", "id", "desc")
    .limit(IC_MESSAGE_LIMIT)
    .prepare();

  async function IC2(personId: string) {
    const [posts, comments] = await Promise.all([
      ic2Posts.execute({ id: personId }),
      ic2Comments.execute({ id: personId }),
    ]);
    const canonicalRows = [...posts, ...comments]
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

  // IC8 (complex read): the most recent replies to the given person's own
  // messages. Replies to Posts and replies to Comments are disjoint (a reply
  // targets exactly one message), so the same top-K-of-union split as IC2
  // applies. A reply is always a Comment; carry its author.
  const ic8RepliesToPosts = store
    .query()
    .from("Person", "p")
    .whereNode("p", (person) => person.id.eq(param("id")))
    .traverse("hasCreator", "hc1", { expand: "none", direction: "in" })
    .to("Post", "post")
    .traverse("replyOf", "ro", { expand: "none", direction: "in" })
    .to("Comment", "reply")
    .traverse("hasCreator", "hc2", { expand: "none" })
    .to("Person", "author")
    .select((ctx) => ({
      authorId: ctx.author.id,
      authorFirstName: ctx.author.firstName,
      authorLastName: ctx.author.lastName,
      id: ctx.reply.id,
      content: ctx.reply.content,
      creationDate: ctx.reply.creationDate,
    }))
    .orderBy("reply", "creationDate", "desc")
    .orderBy("reply", "id", "desc")
    .limit(IC_MESSAGE_LIMIT)
    .prepare();
  const ic8RepliesToComments = store
    .query()
    .from("Person", "p")
    .whereNode("p", (person) => person.id.eq(param("id")))
    .traverse("hasCreator", "hc1", { expand: "none", direction: "in" })
    .to("Comment", "message")
    .traverse("replyOf", "ro", { expand: "none", direction: "in" })
    .to("Comment", "reply")
    .traverse("hasCreator", "hc2", { expand: "none" })
    .to("Person", "author")
    .select((ctx) => ({
      authorId: ctx.author.id,
      authorFirstName: ctx.author.firstName,
      authorLastName: ctx.author.lastName,
      id: ctx.reply.id,
      content: ctx.reply.content,
      creationDate: ctx.reply.creationDate,
    }))
    .orderBy("reply", "creationDate", "desc")
    .orderBy("reply", "id", "desc")
    .limit(IC_MESSAGE_LIMIT)
    .prepare();

  async function IC8(personId: string) {
    const [toPosts, toComments] = await Promise.all([
      ic8RepliesToPosts.execute({ id: personId }),
      ic8RepliesToComments.execute({ id: personId }),
    ]);
    const canonicalRows = [...toPosts, ...toComments]
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

  // IC9 (complex read): the most recent messages by the person's friends and
  // friends-of-friends (2-hop `knows`, source excluded) created before
  // IC9_MAX_DATE. Resolve the 2-hop person set first (bounded, `neighbors`
  // handles depth 2 fine — it's the deep traversals that hit typegraph#271),
  // then their messages, filtered + top-K per message type and merged.
  async function ic9MessagesOf(
    kind: "Post" | "Comment",
    personIds: readonly string[],
  ) {
    return store
      .query()
      .from("Person", "creator")
      .whereNode("creator", (creator) => creator.id.in(personIds))
      .traverse("hasCreator", "hc", { expand: "none", direction: "in" })
      .to(kind, "message")
      .whereNode("message", (message) => message.creationDate.lt(IC9_MAX_DATE))
      .select((ctx) => ({
        creatorId: ctx.creator.id,
        creatorFirstName: ctx.creator.firstName,
        creatorLastName: ctx.creator.lastName,
        id: ctx.message.id,
        content: ctx.message.content,
        creationDate: ctx.message.creationDate,
      }))
      .orderBy("message", "creationDate", "desc")
      .orderBy("message", "id", "desc")
      .limit(IC_MESSAGE_LIMIT)
      .execute();
  }

  async function IC9(personId: string) {
    const fof = await store.algorithms.neighbors(personId, {
      edges: ["knows"],
      depth: 2,
      direction: "out",
      workingMemory: ALGORITHM_WORKING_MEMORY,
    });
    const fofIds = fof.map((node) => node.id);
    if (fofIds.length === 0) {
      return { rowCount: 0, digest: canonicalDigest([]) };
    }
    const [posts, comments] = await Promise.all([
      ic9MessagesOf("Post", fofIds),
      ic9MessagesOf("Comment", fofIds),
    ]);
    const canonicalRows = [...posts, ...comments]
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

  // GA_DEGREE (algorithm): the seed's `knows` degree via the native primitive.
  async function GA_DEGREE(seedPersonId: string) {
    const degree = await store.algorithms.degree(seedPersonId, {
      edges: ["knows"],
      direction: "out",
    });
    return degreeResult(degree);
  }

  // GA_BFS / GA_SSSP (algorithms): whole-component reachability / shortest-path
  // depths from the seed via `reachable`. Correct, but declared unsupported by
  // the SQLite/Postgres factories until typegraph#271 lands — `reachable`
  // path-enumerates, so at GA_MAX_HOPS on a dense graph it is infeasible today.
  // The code is written for the fixed (set-based BFS) API so this flips on with
  // a one-line factory change post-fix.
  async function GA_BFS(seedPersonId: string) {
    const reached = await store.algorithms.reachable(seedPersonId, {
      edges: ["knows"],
      maxHops: GA_MAX_HOPS,
      direction: "out",
      workingMemory: ALGORITHM_WORKING_MEMORY,
    });
    const reachedCount = reached.filter(
      (node) => node.id !== seedPersonId,
    ).length;
    return bfsReachResult(reachedCount);
  }
  async function GA_SSSP(seedPersonId: string) {
    const reached = await store.algorithms.reachable(seedPersonId, {
      edges: ["knows"],
      maxHops: GA_MAX_HOPS,
      direction: "out",
      workingMemory: ALGORITHM_WORKING_MEMORY,
    });
    const others = reached.filter((node) => node.id !== seedPersonId);
    const depthSum = others.reduce((sum, node) => sum + node.depth, 0);
    return ssspResult(others.length, depthSum);
  }

  // GA_WCC (algorithm): weakly connected components of the `knows` social graph
  // via TypeGraph's native exact WCC (label-min on the D2 iterative substrate;
  // typegraph#272). Restrict the induced subgraph to Person so unrelated SNB
  // entities are neither seeded nor returned as singleton components.
  async function GA_WCC(_seedPersonId: string) {
    const memberships = await store.algorithms.weaklyConnectedComponents({
      edges: ["knows"],
      nodeKinds: ["Person"],
      workingMemory: ALGORITHM_WORKING_MEMORY,
    });
    const sizeByComponent = new Map<string, number>();
    for (const membership of memberships) {
      sizeByComponent.set(
        JSON.stringify([membership.componentKind, membership.componentId]),
        membership.size,
      );
    }
    return componentSizesResult([...sizeByComponent.values()]);
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
    IC14,
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
