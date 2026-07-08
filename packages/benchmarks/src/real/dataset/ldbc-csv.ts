/**
 * Streaming reader for official LDBC SNB Interactive v1 datagen output
 * (CsvBasic serializer, LongDateFormatter epoch-millis dates). Adapted from
 * the sibling braiddb project's `scripts/ldbc-csv.ts`, retargeted to emit
 * TypeGraph node/edge rows (Person/Forum/Post/Comment nodes; knows /
 * hasCreator / containerOf / replyOf edges) instead of BraidDB relational
 * table rows — the graph structure the relational mapping otherwise hides
 * inside foreign-key columns becomes real edges here, matching this
 * program's TypeGraph node/edge schema
 * (docs/design/benchmark-program-plan.md, Lane 1).
 *
 * The datagen stores each undirected `knows` edge once (from < to); this
 * loader materializes both directions so a `from = person` traversal sees
 * the full friend list, matching every other engine driver in this program.
 *
 * Files are streamed line-by-line. Every "which person created this post"
 * style relationship is resolved with a zip-join against the companion
 * relationship file (`readZippedRow` / `assertZipStreamExhausted` below)
 * instead of a lookaside `Map` — empirically verified (row-by-row, against
 * both the real SF1 datagen fixture and the committed smoke fixture) that
 * CsvBasic datagen output, and the committed smoke fixture generator, always
 * emit a relationship file in the same row order as its driving entity file.
 * A zip join needs only the current row of each file in memory, so peak
 * memory no longer scales with total row count — the old lookaside-map
 * approach held one Map entry per Post/Comment in the *entire* dataset until
 * that entity's whole stream finished, which OOM'd a real SF10 run (~10M
 * posts, ~20M+ comments) around 4.2GB. If the row-order assumption is ever
 * violated — different datagen configuration, a corrupt file — the zip join
 * throws immediately instead of silently mis-joining rows.
 *
 * `SnbIdPools` (harvested ids for benchmark request sampling) is similarly
 * bounded: `request-plan.ts` only ever draws a small, fixed number of
 * random picks per query type, so each pool is a fixed-size reservoir
 * sample (Algorithm R) rather than every id in the dataset.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

export type SnbPersonRow = Readonly<{
  id: string;
  firstName: string;
  lastName: string;
  gender: string;
  /** YYYY-MM-DD */
  birthday: string;
  creationDate: string;
  locationIp: string;
  browserUsed: string;
  cityId: string;
}>;

export type SnbForumRow = Readonly<{
  id: string;
  title: string;
  creationDate: string;
  moderatorId: string;
}>;

export type SnbPostRow = Readonly<{
  id: string;
  content: string;
  creationDate: string;
}>;

export type SnbCommentRow = Readonly<{
  id: string;
  content: string;
  creationDate: string;
}>;

/**
 * One graph edge, discriminated by kind. `fromId`/`toId` are fully-formatted
 * ids (e.g. `person:123`) ready to hand to any engine's edge-create call.
 */
export type SnbEdgeRow =
  | Readonly<{ kind: "knows"; fromId: string; toId: string; createdAt: string }>
  | Readonly<{
      kind: "hasCreator";
      fromId: string;
      fromKind: "Post" | "Comment";
      toId: string;
    }>
  | Readonly<{ kind: "containerOf"; fromId: string; toId: string }>
  | Readonly<{
      kind: "replyOf";
      fromId: string;
      toId: string;
      toKind: "Post" | "Comment";
    }>;

export type SnbRowSink = Readonly<{
  person: (row: SnbPersonRow) => Promise<void>;
  forum: (row: SnbForumRow) => Promise<void>;
  post: (row: SnbPostRow) => Promise<void>;
  comment: (row: SnbCommentRow) => Promise<void>;
  edge: (row: SnbEdgeRow) => Promise<void>;
  /**
   * Called after each entity stage (persons, knows, forums, posts, comments)
   * finishes streaming, before the next stage's edges can reference it.
   * A batching sink MUST flush every pending buffer here — buffers fill in
   * lockstep within a stage (safe), but nothing otherwise guarantees e.g.
   * every `Forum` is flushed before a `containerOf` edge from the posts
   * stage references it.
   */
  stageComplete?: () => Promise<void>;
}>;

/**
 * Ids harvested during the load, for benchmark request sampling. Each field
 * is a bounded reservoir sample (Algorithm R, up to `ID_SAMPLE_POOL_SIZE`
 * ids) drawn uniformly from the full stream, NOT the full set of ids in the
 * dataset: `request-plan.ts` only ever draws a small, fixed number of
 * random picks per query type, so retaining every id (millions, at LDBC
 * SF10 scale) would be wasted memory. `counts` carries the true totals
 * (unaffected by the reservoir bound) for reporting.
 */
export type SnbIdPools = Readonly<{
  persons: readonly string[];
  posts: readonly string[];
  comments: readonly string[];
  counts: Readonly<{ persons: number; posts: number; comments: number }>;
}>;

export type SnbCsvLoadResult = Readonly<{
  pools: SnbIdPools;
  counts: Readonly<{
    persons: number;
    knowsDirected: number;
    forums: number;
    posts: number;
    comments: number;
    rows: number;
  }>;
}>;

/** True when `root` looks like extracted CsvBasic datagen output. */
export async function isSnbDatagenDirectory(root: string): Promise<boolean> {
  try {
    return (await stat(path.join(root, "dynamic", "person_0_0.csv"))).isFile();
  } catch {
    return false;
  }
}

const personId = (id: string): string => `person:${id}`;
const forumId = (id: string): string => `forum:${id}`;
const messageId = (id: string): string => `message:${id}`;

/**
 * Fixed-capacity reservoir sample (Algorithm R): after `offer` has been
 * called any number of times, `values()` holds a uniform random sample of
 * up to `capacity` of the offered items, in O(capacity) memory regardless
 * of how many items were offered.
 */
function createReservoirSampler<T>(
  capacity: number,
  random: () => number,
): Readonly<{ offer: (item: T) => void; values: () => readonly T[] }> {
  const reservoir: T[] = [];
  let seen = 0;
  return {
    offer(item: T): void {
      seen += 1;
      if (reservoir.length < capacity) {
        reservoir.push(item);
        return;
      }
      const index = Math.floor(random() * seen);
      if (index < capacity) {
        reservoir[index] = item;
      }
    },
    values: () => reservoir,
  };
}

/**
 * xorshift32 PRNG, matching the generator used by `request-plan.ts` and this
 * program's other benchmark seeders (each keeps its own small copy rather
 * than sharing a module — established convention in this package). Fixed
 * seed: the reservoir sample must be identical across every engine's
 * independent load of the same dataset (every engine streams the same files
 * in the same order), not just internally consistent within one run.
 */
function createRng(seed_: number): () => number {
  let seed = seed_;
  return function next(): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_295;
  };
}

/** Reservoir capacity, comfortably above any realistic `--requests-per-query`. */
const ID_SAMPLE_POOL_SIZE = 10_000;
const ID_SAMPLE_SEED = 1_469_598_103;

/**
 * Stream the datagen CSVs under `root` (containing `dynamic/`) into `sink`
 * as Person/Forum/Post/Comment node rows plus knows/hasCreator/containerOf/
 * replyOf edge rows.
 */
export async function streamSnbCsvDataset(
  root: string,
  sink: SnbRowSink,
  log: (message: string) => void = () => undefined,
): Promise<SnbCsvLoadResult> {
  const dynamicFile = (name: string) =>
    path.join(root, "dynamic", `${name}_0_0.csv`);
  const sampleRandom = createRng(ID_SAMPLE_SEED);
  const personSample = createReservoirSampler<string>(
    ID_SAMPLE_POOL_SIZE,
    sampleRandom,
  );
  const postSample = createReservoirSampler<string>(
    ID_SAMPLE_POOL_SIZE,
    sampleRandom,
  );
  const commentSample = createReservoirSampler<string>(
    ID_SAMPLE_POOL_SIZE,
    sampleRandom,
  );
  let personCount = 0;
  let postCount = 0;
  let commentCount = 0;
  let rows = 0;

  const personCityRows = csvRows(dynamicFile("person_isLocatedIn_place"), 2);
  for await (const parts of csvRows(dynamicFile("person"), 8)) {
    const id = parts[0]!;
    const cityRow = await readZippedRow(
      personCityRows,
      0,
      id,
      "person_isLocatedIn_place",
    );
    personSample.offer(personId(id));
    personCount += 1;
    rows += 1;
    await sink.person({
      id: personId(id),
      firstName: parts[1]!,
      lastName: parts[2]!,
      gender: parts[3]!,
      birthday: isoFromMillis(parts[4]).slice(0, 10),
      creationDate: isoFromMillis(parts[5]),
      locationIp: parts[6]!,
      browserUsed: parts[7]!,
      cityId: `place:${cityRow[1]}`,
    });
  }
  await assertZipStreamExhausted(
    personCityRows,
    "person_isLocatedIn_place",
    "person",
  );
  await sink.stageComplete?.();
  log(`persons: ${personCount}`);

  let knowsDirected = 0;
  for await (const parts of csvRows(dynamicFile("person_knows_person"), 3)) {
    const createdAt = isoFromMillis(parts[2]);
    for (const [from, to] of [
      [parts[0]!, parts[1]!],
      [parts[1]!, parts[0]!],
    ] as const) {
      knowsDirected += 1;
      rows += 1;
      await sink.edge({
        kind: "knows",
        fromId: personId(from),
        toId: personId(to),
        createdAt,
      });
    }
  }
  await sink.stageComplete?.();
  log(`knows edges (directed): ${knowsDirected}`);

  const forumModeratorRows = csvRows(
    dynamicFile("forum_hasModerator_person"),
    2,
  );
  let forums = 0;
  for await (const parts of csvRows(dynamicFile("forum"), 3)) {
    const id = parts[0]!;
    const moderatorRow = await readZippedRow(
      forumModeratorRows,
      0,
      id,
      "forum_hasModerator_person",
    );
    forums += 1;
    rows += 1;
    await sink.forum({
      id: forumId(id),
      title: parts[1]!,
      creationDate: isoFromMillis(parts[2]),
      moderatorId: personId(moderatorRow[1]!),
    });
  }
  await assertZipStreamExhausted(
    forumModeratorRows,
    "forum_hasModerator_person",
    "forum",
  );
  await sink.stageComplete?.();
  log(`forums: ${forums}`);

  const postCreatorRows = csvRows(dynamicFile("post_hasCreator_person"), 2);
  const postForumRows = csvRows(dynamicFile("forum_containerOf_post"), 2);
  for await (const parts of csvRows(dynamicFile("post"), 8)) {
    const id = parts[0]!;
    const creatorRow = await readZippedRow(
      postCreatorRows,
      0,
      id,
      "post_hasCreator_person",
    );
    // forum_containerOf_post is `Forum.id|Post.id` — the zip key is column 1.
    const forumRow = await readZippedRow(
      postForumRows,
      1,
      id,
      "forum_containerOf_post",
    );
    postSample.offer(messageId(id));
    postCount += 1;
    rows += 1;
    await sink.post({
      id: messageId(id),
      // Image posts have empty content; keep the imageFile reference so
      // fulltext-shaped fields are never empty across the whole corpus.
      content: parts[6] !== "" ? parts[6]! : parts[1]!,
      creationDate: isoFromMillis(parts[2]),
    });
    await sink.edge({
      kind: "hasCreator",
      fromId: messageId(id),
      fromKind: "Post",
      toId: personId(creatorRow[1]!),
    });
    await sink.edge({
      kind: "containerOf",
      fromId: forumId(forumRow[0]!),
      toId: messageId(id),
    });
  }
  await assertZipStreamExhausted(
    postCreatorRows,
    "post_hasCreator_person",
    "post",
  );
  await assertZipStreamExhausted(
    postForumRows,
    "forum_containerOf_post",
    "post",
  );
  await sink.stageComplete?.();
  log(`posts: ${postCount}`);

  // Every comment replies to exactly one thing — a Post or another
  // Comment — recorded in one of two disjoint relationship files. Each
  // file, restricted to the comments it covers, preserves comment.csv's row
  // order (verified empirically, like the other zip joins above), so a
  // 3-way merge — advance whichever companion cursor's buffered row matches
  // the current comment id — resolves parent + kind with only one buffered
  // row per companion file, instead of a Map holding every comment in the
  // dataset.
  const postParentRows = csvRows(dynamicFile("comment_replyOf_post"), 2);
  const commentParentRows = csvRows(dynamicFile("comment_replyOf_comment"), 2);
  const commentCreatorRows = csvRows(
    dynamicFile("comment_hasCreator_person"),
    2,
  );
  let nextPostParent = await postParentRows.next();
  let nextCommentParent = await commentParentRows.next();

  for await (const parts of csvRows(dynamicFile("comment"), 6)) {
    const id = parts[0]!;
    let parent: string;
    let parentKind: "Post" | "Comment";
    if (!nextPostParent.done && nextPostParent.value[0] === id) {
      parent = nextPostParent.value[1]!;
      parentKind = "Post";
      nextPostParent = await postParentRows.next();
    } else if (!nextCommentParent.done && nextCommentParent.value[0] === id) {
      parent = nextCommentParent.value[1]!;
      parentKind = "Comment";
      nextCommentParent = await commentParentRows.next();
    } else {
      throw new Error(
        `LDBC dataset row-order alignment assumption violated: comment ${id} is not ` +
          "the next row in either comment_replyOf_post or comment_replyOf_comment " +
          "(datagen output no longer emits relationship files in entity row order).",
      );
    }
    const creatorRow = await readZippedRow(
      commentCreatorRows,
      0,
      id,
      "comment_hasCreator_person",
    );

    commentSample.offer(messageId(id));
    commentCount += 1;
    rows += 1;
    await sink.comment({
      id: messageId(id),
      content: parts[4]!,
      creationDate: isoFromMillis(parts[1]),
    });
    await sink.edge({
      kind: "hasCreator",
      fromId: messageId(id),
      fromKind: "Comment",
      toId: personId(creatorRow[1]!),
    });
    await sink.edge({
      kind: "replyOf",
      fromId: messageId(id),
      toId: messageId(parent),
      toKind: parentKind,
    });
  }
  if (!nextPostParent.done || !nextCommentParent.done) {
    throw new Error(
      "comment_replyOf_post/comment_replyOf_comment has more rows than comment " +
        "— the row-order alignment assumption is violated",
    );
  }
  await assertZipStreamExhausted(
    commentCreatorRows,
    "comment_hasCreator_person",
    "comment",
  );
  await sink.stageComplete?.();
  log(`comments: ${commentCount}`);

  return {
    pools: {
      persons: personSample.values(),
      posts: postSample.values(),
      comments: commentSample.values(),
      counts: {
        persons: personCount,
        posts: postCount,
        comments: commentCount,
      },
    },
    counts: {
      persons: personCount,
      knowsDirected,
      forums,
      posts: postCount,
      comments: commentCount,
      rows,
    },
  };
}

/** Pipe-delimited rows of `file`, header skipped, field count enforced. */
async function* csvRows(
  file: string,
  expectedFields: number,
): AsyncGenerator<string[]> {
  const lines = createInterface({
    input: createReadStream(file, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let lineNumber = 0;
  for await (const line of lines) {
    lineNumber += 1;
    if (lineNumber === 1 || line.length === 0) continue;
    const parts = line.split("|");
    if (parts.length !== expectedFields) {
      throw new Error(
        `${file}:${lineNumber}: expected ${expectedFields} fields, found ${parts.length}`,
      );
    }
    yield parts;
  }
}

/**
 * Reads the next row of a companion relationship stream and asserts its
 * `keyColumn` matches `expectedId` — the id from the driving entity stream
 * at this same position. Relies on the row-order alignment documented at
 * the top of this file; throws immediately (rather than silently
 * mis-joining) if a mismatch is ever found.
 */
async function readZippedRow(
  companionRows: AsyncGenerator<string[]>,
  keyColumn: number,
  expectedId: string,
  file: string,
): Promise<string[]> {
  const { value, done } = await companionRows.next();
  if (done || value === undefined) {
    throw new Error(
      `${file}: expected a row zip-joined to id ${expectedId}, but the stream ended first ` +
        "— the row-order alignment assumption is violated",
    );
  }
  const actualId = value[keyColumn];
  if (actualId !== expectedId) {
    throw new Error(
      `${file}: row-order alignment assumption violated — expected id ${expectedId} ` +
        `zip-joined at this position, found ${actualId}`,
    );
  }
  return value;
}

/** Asserts a zip-joined companion stream has no rows left over. */
async function assertZipStreamExhausted(
  companionRows: AsyncGenerator<string[]>,
  file: string,
  drivingFile: string,
): Promise<void> {
  const { done } = await companionRows.next();
  if (!done) {
    throw new Error(
      `${file} has more rows than ${drivingFile} — the row-order alignment ` +
        "assumption is violated",
    );
  }
}

function isoFromMillis(value: string | undefined): string {
  const millis = Number(value);
  if (!Number.isFinite(millis)) {
    throw new Error(
      `expected epoch-millis date, found ${JSON.stringify(value)}`,
    );
  }
  return new Date(millis).toISOString();
}
