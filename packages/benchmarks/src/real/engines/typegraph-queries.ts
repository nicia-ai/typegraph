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
  canonicalDigest,
  compareIdsAscending,
  type MessageRef,
  type SnbQueries,
} from "./types";
import { type SnbStore } from "../schema/snb-graph";

const ROOT_WALK_MAX_HOPS = 100;

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

  return { IS1, IS2, IS3, IS4, IS5, IS6, IS7 };
}
