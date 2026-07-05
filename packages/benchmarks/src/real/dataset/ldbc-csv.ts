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
 * Files are streamed line-by-line; lookaside maps (creator, container,
 * reply-of, moderator, city) hold numeric ids only and are released as soon
 * as the dependent entity finishes, so SF1 (5.3M rows) loads within a
 * default Node heap.
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

/** Real entity ids harvested during the load, for benchmark request sampling. */
export type SnbIdPools = Readonly<{
  persons: readonly string[];
  posts: readonly string[];
  comments: readonly string[];
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
  const persons: string[] = [];
  const posts: string[] = [];
  const comments: string[] = [];
  let rows = 0;

  const personCity = await pairMap(
    dynamicFile("person_isLocatedIn_place"),
    0,
    1,
  );
  for await (const parts of csvRows(dynamicFile("person"), 8)) {
    const id = parts[0]!;
    persons.push(personId(id));
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
      cityId: `place:${requireMapped(personCity, id, "person city")}`,
    });
  }
  personCity.clear();
  await sink.stageComplete?.();
  log(`persons: ${persons.length}`);

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

  const forumModerator = await pairMap(
    dynamicFile("forum_hasModerator_person"),
    0,
    1,
  );
  let forums = 0;
  for await (const parts of csvRows(dynamicFile("forum"), 3)) {
    const id = parts[0]!;
    forums += 1;
    rows += 1;
    await sink.forum({
      id: forumId(id),
      title: parts[1]!,
      creationDate: isoFromMillis(parts[2]),
      moderatorId: personId(
        String(requireMapped(forumModerator, id, "forum moderator")),
      ),
    });
  }
  forumModerator.clear();
  await sink.stageComplete?.();
  log(`forums: ${forums}`);

  const postCreator = await pairMap(
    dynamicFile("post_hasCreator_person"),
    0,
    1,
  );
  const postForum = await pairMap(dynamicFile("forum_containerOf_post"), 1, 0);
  for await (const parts of csvRows(dynamicFile("post"), 8)) {
    const id = parts[0]!;
    posts.push(messageId(id));
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
      toId: personId(String(requireMapped(postCreator, id, "post creator"))),
    });
    await sink.edge({
      kind: "containerOf",
      fromId: forumId(String(requireMapped(postForum, id, "post forum"))),
      toId: messageId(id),
    });
  }
  postCreator.clear();
  postForum.clear();
  await sink.stageComplete?.();
  log(`posts: ${posts.length}`);

  const commentParent = await pairMap(
    dynamicFile("comment_replyOf_post"),
    0,
    1,
  );
  const commentParentKind = new Map<string, "Post" | "Comment">(
    [...commentParent.keys()].map((comment) => [comment, "Post" as const]),
  );
  for (const [comment, parent] of await pairMap(
    dynamicFile("comment_replyOf_comment"),
    0,
    1,
  )) {
    commentParent.set(comment, parent);
    commentParentKind.set(comment, "Comment");
  }
  const commentCreator = await pairMap(
    dynamicFile("comment_hasCreator_person"),
    0,
    1,
  );
  for await (const parts of csvRows(dynamicFile("comment"), 6)) {
    const id = parts[0]!;
    const parent = requireMapped(commentParent, id, "comment parent");
    const parentKind = commentParentKind.get(id);
    if (parentKind === undefined) {
      throw new Error(
        `LDBC dataset is missing the comment parent kind mapping for id ${id}`,
      );
    }
    comments.push(messageId(id));
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
      toId: personId(
        String(requireMapped(commentCreator, id, "comment creator")),
      ),
    });
    await sink.edge({
      kind: "replyOf",
      fromId: messageId(id),
      toId: messageId(String(parent)),
      toKind: parentKind,
    });
  }
  commentParent.clear();
  commentParentKind.clear();
  commentCreator.clear();
  await sink.stageComplete?.();
  log(`comments: ${comments.length}`);

  return {
    pools: { persons, posts, comments },
    counts: {
      persons: persons.length,
      knowsDirected,
      forums,
      posts: posts.length,
      comments: comments.length,
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

/** Two-column id file as a string-keyed map; column indexes select key/value. */
async function pairMap(
  file: string,
  keyColumn: number,
  valueColumn: number,
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const columns = Math.max(keyColumn, valueColumn) + 1;
  for await (const parts of csvRows(file, columns)) {
    map.set(parts[keyColumn]!, parts[valueColumn]!);
  }
  return map;
}

function requireMapped(
  map: Map<string, string>,
  key: string,
  what: string,
): string {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error(
      `LDBC dataset is missing the ${what} mapping for id ${key}`,
    );
  }
  return value;
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
