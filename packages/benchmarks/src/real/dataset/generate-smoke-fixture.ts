/**
 * Generates the tiny, committed LDBC SNB "smoke" fixture at
 * `packages/benchmarks/fixtures/ldbc-snb-smoke/`. The output matches the
 * exact CsvBasic datagen directory/file/column layout `streamSnbCsvDataset`
 * (../dataset/ldbc-csv.ts) parses, so the smoke profile exercises the SAME
 * code path as a real SF1 extract — just a few dozen rows instead of 5.3M.
 *
 * Re-run with `tsx src/real/dataset/generate-smoke-fixture.ts` after
 * changing the shape below; the output is committed (small, deterministic).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "fixtures",
  "ldbc-snb-smoke",
);

const PERSON_COUNT = 30;
const KNOWS_PER_PERSON = 4;
const FORUM_COUNT = 5;
const POST_COUNT = 40;
const COMMENT_COUNT = 80;

const BASE_MILLIS = Date.UTC(2024, 0, 1);
const DAY_MILLIS = 86_400_000;

/** xorshift32 PRNG, matching the request-plan sampler's generator. */
function createRng(seed_: number): () => number {
  let seed = seed_;
  return function next(): number {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 4_294_967_295;
  };
}

const random = createRng(1337);
const below = (bound: number): number => Math.floor(random() * bound);

type CsvFile = Readonly<{ name: string; header: string; rows: string[] }>;

function csvFile(name: string, header: string): CsvFile {
  return { name, header, rows: [] };
}

async function writeCsvFile(root: string, file: CsvFile): Promise<void> {
  const body = [file.header, ...file.rows].join("\n");
  await writeFile(path.join(root, file.name), `${body}\n`, "utf8");
}

async function main(): Promise<void> {
  const dynamicDir = path.join(FIXTURE_ROOT, "dynamic");
  await mkdir(dynamicDir, { recursive: true });

  const person = csvFile(
    "person_0_0.csv",
    "id|firstName|lastName|gender|birthday|creationDate|locationIP|browserUsed",
  );
  const personIsLocatedInPlace = csvFile(
    "person_isLocatedIn_place_0_0.csv",
    "Person.id|Place.id",
  );
  const personKnowsPerson = csvFile(
    "person_knows_person_0_0.csv",
    "Person1.id|Person2.id|creationDate",
  );
  const forum = csvFile("forum_0_0.csv", "id|title|creationDate");
  const forumHasModeratorPerson = csvFile(
    "forum_hasModerator_person_0_0.csv",
    "Forum.id|Person.id",
  );
  const post = csvFile(
    "post_0_0.csv",
    "id|imageFile|creationDate|locationIP|browserUsed|language|content|length",
  );
  const postHasCreatorPerson = csvFile(
    "post_hasCreator_person_0_0.csv",
    "Post.id|Person.id",
  );
  const forumContainerOfPost = csvFile(
    "forum_containerOf_post_0_0.csv",
    "Forum.id|Post.id",
  );
  const comment = csvFile(
    "comment_0_0.csv",
    "id|creationDate|locationIP|browserUsed|content|length",
  );
  const commentHasCreatorPerson = csvFile(
    "comment_hasCreator_person_0_0.csv",
    "Comment.id|Person.id",
  );
  const commentReplyOfPost = csvFile(
    "comment_replyOf_post_0_0.csv",
    "Comment.id|Post.id",
  );
  const commentReplyOfComment = csvFile(
    "comment_replyOf_comment_0_0.csv",
    "Comment.id|Comment.id",
  );

  for (let id = 0; id < PERSON_COUNT; id += 1) {
    const created = BASE_MILLIS - below(365) * DAY_MILLIS;
    person.rows.push(
      [
        id,
        `First${id}`,
        `Last${id}`,
        id % 2 === 0 ? "male" : "female",
        BASE_MILLIS - (20_000 + below(5_000)) * DAY_MILLIS,
        created,
        `10.0.${id % 256}.${below(256)}`,
        ["Chrome", "Firefox", "Safari"][id % 3],
      ].join("|"),
    );
    personIsLocatedInPlace.rows.push([id, id % 10].join("|"));
  }

  const knowsPairs = new Set<string>();
  for (let person1 = 0; person1 < PERSON_COUNT; person1 += 1) {
    let attempts = 0;
    let added = 0;
    while (added < KNOWS_PER_PERSON && attempts < KNOWS_PER_PERSON * 10) {
      attempts += 1;
      const person2 = below(PERSON_COUNT);
      if (person2 === person1) continue;
      const low = Math.min(person1, person2);
      const high = Math.max(person1, person2);
      const key = `${low}|${high}`;
      if (knowsPairs.has(key)) continue;
      knowsPairs.add(key);
      added += 1;
      personKnowsPerson.rows.push(
        [low, high, BASE_MILLIS - below(300) * DAY_MILLIS].join("|"),
      );
    }
  }

  for (let id = 0; id < FORUM_COUNT; id += 1) {
    forum.rows.push(
      [id, `Forum ${id}`, BASE_MILLIS - below(300) * DAY_MILLIS].join("|"),
    );
    forumHasModeratorPerson.rows.push([id, below(PERSON_COUNT)].join("|"));
  }

  const postForum: number[] = [];
  for (let id = 0; id < POST_COUNT; id += 1) {
    const forumIdForPost = below(FORUM_COUNT);
    postForum.push(forumIdForPost);
    post.rows.push(
      [
        id,
        "",
        BASE_MILLIS - below(200) * DAY_MILLIS,
        `10.1.${id % 256}.${below(256)}`,
        "Chrome",
        "en",
        `smoke fixture post content ${id}`,
        20,
      ].join("|"),
    );
    postHasCreatorPerson.rows.push([id, below(PERSON_COUNT)].join("|"));
    forumContainerOfPost.rows.push([forumIdForPost, id].join("|"));
  }

  // Post and Comment share one global "Message" id space in the real LDBC
  // schema (ldbc-csv.ts formats both as `message:${id}`), so comment ids
  // must continue after the last post id rather than restart at 0 — two
  // disjoint id ranges under one prefix, never colliding.
  for (let index = 0; index < COMMENT_COUNT; index += 1) {
    const id = POST_COUNT + index;
    const replyToComment = index > 0 && random() < 0.5;
    const createdOffsetDays = 200 + below(100);
    comment.rows.push(
      [
        id,
        BASE_MILLIS - createdOffsetDays * DAY_MILLIS,
        `10.2.${id % 256}.${below(256)}`,
        "Firefox",
        `smoke fixture comment content ${id}`,
        15,
      ].join("|"),
    );
    commentHasCreatorPerson.rows.push([id, below(PERSON_COUNT)].join("|"));
    if (replyToComment) {
      commentReplyOfComment.rows.push(
        [id, POST_COUNT + below(index)].join("|"),
      );
    } else {
      commentReplyOfPost.rows.push([id, below(POST_COUNT)].join("|"));
    }
  }

  await Promise.all(
    [
      person,
      personIsLocatedInPlace,
      personKnowsPerson,
      forum,
      forumHasModeratorPerson,
      post,
      postHasCreatorPerson,
      forumContainerOfPost,
      comment,
      commentHasCreatorPerson,
      commentReplyOfPost,
      commentReplyOfComment,
    ].map((file) => writeCsvFile(dynamicDir, file)),
  );

  console.log(
    `Wrote smoke fixture to ${FIXTURE_ROOT}: ${PERSON_COUNT} persons, ` +
      `${knowsPairs.size * 2} directed knows edges, ${FORUM_COUNT} forums, ` +
      `${POST_COUNT} posts, ${COMMENT_COUNT} comments.`,
  );
}

await main();
