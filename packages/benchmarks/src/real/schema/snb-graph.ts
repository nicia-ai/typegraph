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
 * Covering index shaped to match the actual join TypeGraph's IS2 query
 * compiles (`n.id = e.from_id` over the reverse `hasCreator` edge),
 * carrying `creationDate` alongside so that join can be served
 * index-only instead of fetching each candidate's full heap row (which
 * includes the whole `props` JSONB blob) just to read one field before
 * most candidates get discarded by the `ORDER BY ... LIMIT 10`.
 *
 * A prior version of this index was keyed by `creationDate` alone —
 * matching the competitors' `message(creator_id, creation_date desc, id
 * desc)` index in spirit, but the wrong shape for TypeGraph's compiled
 * query: that key has no `id` column, so the planner could never choose
 * it for an id-equality join and it went unused (confirmed via `EXPLAIN
 * (ANALYZE, BUFFERS)` — see reports/snb-lane1-results.md).
 *
 * A second version added `id` but still wasn't truly covering: every
 * compiled query also filters on `deleted_at`/`valid_from`/`valid_to`
 * (soft-delete + temporal-validity window), which this index didn't
 * carry — so the candidate scan still fetched the full heap row per
 * row just to evaluate those three predicates. At SF1 scale (small
 * table, page-cache-resident) that heap fetch is free; at SF10 scale
 * (30-50GB table exceeding available page cache) every one of those
 * fetches became a genuine random disk read, and with thousands of
 * candidates per IS2 call, that alone produced the real run's 51s
 * median / 142s p95 (see the IS2 investigation write-up). All three
 * system columns are now in `keySystemColumns` so the candidate scan is
 * truly index-only (`EXPLAIN QUERY PLAN` shows `USING COVERING INDEX`,
 * not `USING INDEX`).
 *
 * Declared once (against `Post`'s props schema) and shared by both
 * `Post` and `Comment` lookups: `kind` is a leading key column here, not
 * a partial `WHERE` clause, so one non-partial index over the whole
 * `typegraph_nodes` table serves an id+kind-scoped lookup for either
 * kind equally well — Comment's `creationDate` field happens to be the
 * identical shape. Declaring this twice (once per kind, as before)
 * produced two byte-identical physical indexes: pure redundant
 * write-time cost paid by every node insert (Person/Forum included,
 * even though they never benefit) for zero read-side gain.
 */
const messageByCreationDateIndex = defineNodeIndex(Post, {
  name: "snb_message_by_creation_date_covering_idx",
  keySystemColumns: ["id", "deleted_at", "valid_from", "valid_to"],
  coveringFields: ["creationDate"],
});

/**
 * Passed to `createSqliteTables`/`createPostgresTables` at table-creation
 * time (matching packages/benchmarks/src/backend.ts's `perfIndexes`
 * convention) — `defineGraph` itself doesn't take an indexes option.
 */
export const snbIndexes = [messageByCreationDateIndex];

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
