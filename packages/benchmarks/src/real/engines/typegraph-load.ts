/**
 * Streams LDBC SNB rows into a TypeGraph store via `bulkInsert` — the
 * documented production bulk-load path (batched, not one `create()` per
 * row). Shared between the SQLite and PostgreSQL engine drivers.
 */
import {
  streamSnbCsvDataset,
  type SnbCommentRow,
  type SnbEdgeRow,
  type SnbForumRow,
  type SnbIdPools,
  type SnbPersonRow,
  type SnbPostRow,
} from "../dataset/ldbc-csv";
import { type SnbStore } from "../schema/snb-graph";

type KnowsEdgeRow = Extract<SnbEdgeRow, { kind: "knows" }>;
type HasCreatorEdgeRow = Extract<SnbEdgeRow, { kind: "hasCreator" }>;
type ContainerOfEdgeRow = Extract<SnbEdgeRow, { kind: "containerOf" }>;
type ReplyOfEdgeRow = Extract<SnbEdgeRow, { kind: "replyOf" }>;

const BATCH_SIZE = 2_000;

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

export async function loadSnbDataset(
  store: SnbStore,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  const persons = createBatcher<SnbPersonRow>(BATCH_SIZE, (batch) =>
    store.nodes.Person.bulkInsert(
      batch.map(({ id, ...props }) => ({ id, props })),
    ),
  );
  const forums = createBatcher<SnbForumRow>(BATCH_SIZE, (batch) =>
    store.nodes.Forum.bulkInsert(
      batch.map(({ id, ...props }) => ({ id, props })),
    ),
  );
  const posts = createBatcher<SnbPostRow>(BATCH_SIZE, (batch) =>
    store.nodes.Post.bulkInsert(
      batch.map(({ id, ...props }) => ({ id, props })),
    ),
  );
  const comments = createBatcher<SnbCommentRow>(BATCH_SIZE, (batch) =>
    store.nodes.Comment.bulkInsert(
      batch.map(({ id, ...props }) => ({ id, props })),
    ),
  );
  const knowsEdges = createBatcher<KnowsEdgeRow>(BATCH_SIZE, (batch) =>
    store.edges.knows.bulkInsert(
      batch.map((row) => ({
        from: { kind: "Person" as const, id: row.fromId },
        to: { kind: "Person" as const, id: row.toId },
        props: { since: row.createdAt },
      })),
    ),
  );
  const hasCreatorEdges = createBatcher<HasCreatorEdgeRow>(
    BATCH_SIZE,
    (batch) =>
      store.edges.hasCreator.bulkInsert(
        batch.map((row) => ({
          from: { kind: row.fromKind, id: row.fromId },
          to: { kind: "Person" as const, id: row.toId },
          props: {},
        })),
      ),
  );
  const containerOfEdges = createBatcher<ContainerOfEdgeRow>(
    BATCH_SIZE,
    (batch) =>
      store.edges.containerOf.bulkInsert(
        batch.map((row) => ({
          from: { kind: "Forum" as const, id: row.fromId },
          to: { kind: "Post" as const, id: row.toId },
          props: {},
        })),
      ),
  );
  const replyOfEdges = createBatcher<ReplyOfEdgeRow>(BATCH_SIZE, (batch) =>
    store.edges.replyOf.bulkInsert(
      batch.map((row) => ({
        from: { kind: "Comment" as const, id: row.fromId },
        to: { kind: row.toKind, id: row.toId },
        props: {},
      })),
    ),
  );

  // Flushing every batcher at each stage boundary (not just at the very
  // end) guarantees a stage's nodes are durably written before the next
  // stage's edges can reference them — batchers otherwise fill in lockstep
  // WITHIN a stage (safe) but drift freely ACROSS stages (e.g. a
  // `containerOf` edge batch reaching 2000 before every `Forum` has).
  async function flushAll(): Promise<void> {
    await persons.finish();
    await forums.finish();
    await posts.finish();
    await comments.finish();
    await knowsEdges.finish();
    await hasCreatorEdges.finish();
    await containerOfEdges.finish();
    await replyOfEdges.finish();
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
            return knowsEdges.push(row);
          case "hasCreator":
            return hasCreatorEdges.push(row);
          case "containerOf":
            return containerOfEdges.push(row);
          case "replyOf":
            return replyOfEdges.push(row);
        }
      },
      stageComplete: flushAll,
    },
    log,
  );

  await flushAll();

  return result.pools;
}
