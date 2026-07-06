/**
 * TypeGraph schema for the LDBC SNB Interactive short-read benchmark (Lane
 * 1). Node/edge kinds per the approved plan
 * (docs/design/benchmark-program-plan.md): Person/Forum/Post/Comment nodes,
 * knows/hasCreator/containerOf/replyOf edges.
 *
 * `Message` is an ontological supertype of Post and Comment — it is never
 * itself instantiated (no node is ever created with kind "Message"; it
 * costs zero storage). It exists solely so the `replyOf` reply chain, whose
 * target is polymorphic (a Comment replies to either a Post or another
 * Comment), can be walked with a single recursive query via
 * `includeSubClasses`, instead of hand-rolled per-kind SQL. `Forum`'s
 * moderator is a plain `moderatorId` field rather than a fifth edge kind —
 * the plan enumerates exactly four edge kinds, and IS6's "moderator of a
 * forum" is a single point read by id either way.
 */
import {
  createStore,
  defineEdge,
  defineGraph,
  defineNode,
  subClassOf,
} from "@nicia-ai/typegraph";
import { defineNodeIndex } from "@nicia-ai/typegraph/indexes";
import { z } from "zod";

const Person = defineNode("Person", {
  schema: z.object({
    firstName: z.string(),
    lastName: z.string(),
    gender: z.string(),
    /** YYYY-MM-DD */
    birthday: z.string(),
    creationDate: z.string(),
    locationIp: z.string(),
    browserUsed: z.string(),
    /** Foreign string key into the (unmodeled) LDBC Place hierarchy. */
    cityId: z.string(),
  }),
});

const Forum = defineNode("Forum", {
  schema: z.object({
    title: z.string(),
    creationDate: z.string(),
    /** Plain FK field — see module doc for why this isn't a graph edge. */
    moderatorId: z.string(),
  }),
});

const Post = defineNode("Post", {
  schema: z.object({
    content: z.string(),
    creationDate: z.string(),
  }),
});

const Comment = defineNode("Comment", {
  schema: z.object({
    content: z.string(),
    creationDate: z.string(),
  }),
});

/** Ontological supertype only — see module doc. Never instantiated. */
const Message = defineNode("Message", {
  schema: z.object({}),
});

const knows = defineEdge("knows", {
  schema: z.object({
    since: z.string(),
  }),
});

const hasCreator = defineEdge("hasCreator");

const containerOf = defineEdge("containerOf");

const replyOf = defineEdge("replyOf");

/**
 * Composite covering index matching the competitors' `message(creator_id,
 * creation_date desc, id desc)` index (see the braiddb reference driver):
 * IS2's "last 10 messages by a friend" is served from the index's sorted
 * suffix instead of scanning every message by a friend.
 */
const postByCreationDateIndex = defineNodeIndex(Post, {
  fields: ["creationDate"],
});
const commentByCreationDateIndex = defineNodeIndex(Comment, {
  fields: ["creationDate"],
});

/**
 * Passed to `createSqliteTables`/`createPostgresTables` at table-creation
 * time (matching packages/benchmarks/src/backend.ts's `perfIndexes`
 * convention) — `defineGraph` itself doesn't take an indexes option.
 */
export const snbIndexes = [postByCreationDateIndex, commentByCreationDateIndex];

export const snbGraph = defineGraph({
  id: "snb_interactive",
  nodes: {
    Person: { type: Person },
    Forum: { type: Forum },
    Post: { type: Post },
    Comment: { type: Comment },
    Message: { type: Message },
  },
  edges: {
    knows: { type: knows, from: [Person], to: [Person] },
    hasCreator: { type: hasCreator, from: [Post, Comment], to: [Person] },
    containerOf: { type: containerOf, from: [Forum], to: [Post] },
    // `Message` must be listed alongside its concrete subclasses here (not
    // just declared via `ontology` below) for `.to("Message", alias, {
    // includeSubClasses: true })` to type-check — matching how
    // `examples/03-subclass-hierarchy.ts` lists a supertype directly in an
    // edge's `to` array next to its subclasses.
    replyOf: { type: replyOf, from: [Comment], to: [Post, Comment, Message] },
  },
  ontology: [subClassOf(Post, Message), subClassOf(Comment, Message)],
});

type SnbGraph = typeof snbGraph;
export type SnbStore = ReturnType<typeof createStore<SnbGraph>>;
