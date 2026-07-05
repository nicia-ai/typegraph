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

import { type MessageRef, type SnbQueries } from "./types";
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
      creationDate: ctx.reply.creationDate,
      authorId: ctx.author.id,
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
      creationDate: ctx.reply.creationDate,
      authorId: ctx.author.id,
    }))
    .orderBy("reply", "creationDate", "desc")
    .orderBy("author", "id", "asc")
    .prepare();

  async function recentMessagesByFriends(
    friendIds: readonly string[],
  ): Promise<
    readonly { id: string; creationDate: string; kind: "Post" | "Comment" }[]
  > {
    if (friendIds.length === 0) return [];

    const [posts, comments] = await Promise.all([
      store
        .query()
        .from("Person", "friend")
        .whereNode("friend", (friend) => friend.id.in(friendIds))
        .traverse("hasCreator", "e", { expand: "none", direction: "in" })
        .to("Post", "post")
        .select((ctx) => ({
          id: ctx.post.id,
          creationDate: ctx.post.creationDate,
        }))
        .orderBy("post", "creationDate", "desc")
        .orderBy("post", "id", "desc")
        .limit(10)
        .execute(),
      store
        .query()
        .from("Person", "friend")
        .whereNode("friend", (friend) => friend.id.in(friendIds))
        .traverse("hasCreator", "e", { expand: "none", direction: "in" })
        .to("Comment", "comment")
        .select((ctx) => ({
          id: ctx.comment.id,
          creationDate: ctx.comment.creationDate,
        }))
        .orderBy("comment", "creationDate", "desc")
        .orderBy("comment", "id", "desc")
        .limit(10)
        .execute(),
    ]);

    return [
      ...posts.map((row) => ({ ...row, kind: "Post" as const })),
      ...comments.map((row) => ({ ...row, kind: "Comment" as const })),
    ]
      .toSorted(
        (left, right) =>
          right.creationDate.localeCompare(left.creationDate) ||
          right.id.localeCompare(left.id),
      )
      .slice(0, 10);
  }

  async function IS1(personId: string) {
    const rows = await is1.execute({ id: personId });
    return { rowCount: rows.length };
  }

  // Real LDBC IS2: friend frontier, then a merged top-10 by creationDate
  // across the (polymorphic) Post/Comment kinds authored by those friends,
  // then the root post + root author of each of those 10 messages. This is
  // the un-batched per-message root walk (readability over the batched
  // multi-seed CTE the SQL reference driver uses — see module doc).
  async function IS2(personId: string) {
    const friends = await friendsOf.execute({ id: personId });
    const friendIds = friends.map((row) => row.personId);
    const recent = await recentMessagesByFriends(friendIds);

    for (const message of recent) {
      const rootId =
        message.kind === "Post" ?
          message.id
        : await resolveRootPostId(message.id);
      await authorOfPost.execute({ id: rootId });
    }

    return { rowCount: recent.length };
  }

  async function IS3(personId: string) {
    const rows = await friendsOf.execute({ id: personId });
    return { rowCount: rows.length };
  }

  async function IS4(message: MessageRef) {
    const rows = await (message.kind === "Post" ? is4Post : is4Comment).execute(
      {
        id: message.id,
      },
    );
    return { rowCount: rows.length };
  }

  async function IS5(message: MessageRef) {
    const rows = await (
      message.kind === "Post" ?
        authorOfPost
      : authorOfComment).execute({
      id: message.id,
    });
    return { rowCount: rows.length };
  }

  async function IS6(message: MessageRef) {
    const rootId =
      message.kind === "Post" ?
        message.id
      : await resolveRootPostId(message.id);
    const forumRows = await forumOfPost.execute({ id: rootId });
    if (forumRows.length === 0) return { rowCount: 0 };
    const moderatorRows = await personById.execute({
      id: forumRows[0]!.moderatorId,
    });
    return { rowCount: moderatorRows.length };
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

    if (parentAuthorId !== undefined && authorIds.length > 0) {
      await store
        .query()
        .from("Person", "author")
        .whereNode("author", (author) => author.id.eq(parentAuthorId))
        .traverse("knows", "e", { expand: "none" })
        .to("Person", "friend")
        .whereNode("friend", (friend) => friend.id.in(authorIds))
        .select((ctx) => ({ id: ctx.friend.id }))
        .execute();
    }

    return { rowCount: replies.length };
  }

  return { IS1, IS2, IS3, IS4, IS5, IS6, IS7 };
}
