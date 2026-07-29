/**
 * Streams LDBC SNB rows through TypeGraph's trusted initial-import path.
 * Shared between the SQLite and PostgreSQL engine drivers.
 *
 * The source dataset is entity-stage ordered (and therefore interleaves some
 * edges before later node kinds), while graph interchange deliberately requires
 * every node chunk before every edge chunk. This adapter makes two bounded CSV
 * passes rather than retaining an SF10-sized graph in memory: nodes first, then
 * edges. A rendezvous channel applies backpressure so at most one import chunk
 * is waiting between the CSV reader and database writer.
 */
import {
  FORMAT_VERSION,
  type GraphInterchangeChunk,
  trustedImportGraphStream,
} from "@nicia-ai/typegraph/interchange";

import {
  streamSnbCsvDataset,
  type SnbCommentRow,
  type SnbEdgeRow,
  type SnbForumRow,
  type SnbIdPools,
  type SnbPersonRow,
  type SnbPostRow,
} from "../dataset/ldbc-csv";
import { synthesizeKnowsWeight } from "./types";
import type { SnbStore } from "../schema/snb-graph";

type KnowsEdgeRow = Extract<SnbEdgeRow, { kind: "knows" }>;
type HasCreatorEdgeRow = Extract<SnbEdgeRow, { kind: "hasCreator" }>;
type ContainerOfEdgeRow = Extract<SnbEdgeRow, { kind: "containerOf" }>;
type ReplyOfEdgeRow = Extract<SnbEdgeRow, { kind: "replyOf" }>;

const BATCH_SIZE = 20_000;

type PendingChunk = Readonly<{
  chunk: GraphInterchangeChunk;
  acknowledge: () => void;
  reject: (error: unknown) => void;
}>;

type WaitingConsumer = Readonly<{
  resolve: (result: IteratorResult<GraphInterchangeChunk>) => void;
  reject: (error: unknown) => void;
}>;

type ChunkChannel = AsyncIterable<GraphInterchangeChunk> &
  Readonly<{
    push: (chunk: GraphInterchangeChunk) => Promise<void>;
    close: () => void;
    fail: (error: unknown) => void;
  }>;

/** A zero-capacity async channel: producers resume only after a consumer pull. */
function createChunkChannel(): ChunkChannel {
  let pending: PendingChunk | undefined;
  let waitingConsumer: WaitingConsumer | undefined;
  let failure: unknown;
  let failed = false;
  let closed = false;

  function take(): Promise<IteratorResult<GraphInterchangeChunk>> {
    if (pending !== undefined) {
      const current = pending;
      pending = undefined;
      current.acknowledge();
      return Promise.resolve({ done: false, value: current.chunk });
    }
    if (failed) return Promise.reject(failure);
    if (closed) return Promise.resolve({ done: true, value: undefined });
    return new Promise((resolve, reject) => {
      waitingConsumer = { resolve, reject };
    });
  }

  return {
    push(chunk): Promise<void> {
      if (failed) return Promise.reject(failure);
      if (closed) {
        return Promise.reject(
          new Error("Cannot push to the closed SNB import channel."),
        );
      }
      if (waitingConsumer !== undefined) {
        const consumer = waitingConsumer;
        waitingConsumer = undefined;
        consumer.resolve({ done: false, value: chunk });
        return Promise.resolve();
      }
      if (pending !== undefined) {
        return Promise.reject(
          new Error("SNB import channel received concurrent producers."),
        );
      }
      return new Promise<void>((acknowledge, reject) => {
        pending = { chunk, acknowledge, reject };
      });
    },
    close(): void {
      if (closed || failed) return;
      closed = true;
      if (waitingConsumer !== undefined) {
        const consumer = waitingConsumer;
        waitingConsumer = undefined;
        consumer.resolve({ done: true, value: undefined });
      }
    },
    fail(error): void {
      if (closed || failed) return;
      failed = true;
      failure = error;
      if (pending !== undefined) {
        const current = pending;
        pending = undefined;
        current.reject(error);
      }
      if (waitingConsumer !== undefined) {
        const consumer = waitingConsumer;
        waitingConsumer = undefined;
        consumer.reject(error);
      }
    },
    [Symbol.asyncIterator](): AsyncIterator<GraphInterchangeChunk> {
      return { next: take };
    },
  };
}

function ignoreRow(): Promise<void> {
  return Promise.resolve();
}

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

function edgeId(row: SnbEdgeRow): string {
  switch (row.kind) {
    case "knows": {
      return `knows:${row.fromId}->${row.toId}`;
    }
    case "hasCreator": {
      return `hasCreator:${row.fromKind}:${row.fromId}->${row.toId}`;
    }
    case "containerOf": {
      return `containerOf:${row.fromId}->${row.toId}`;
    }
    case "replyOf": {
      return `replyOf:${row.fromId}->${row.toKind}:${row.toId}`;
    }
  }
}

async function produceTrustedChunks(
  channel: ChunkChannel,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  await channel.push({
    type: "header",
    header: {
      formatVersion: FORMAT_VERSION,
      exportedAt: new Date().toISOString(),
      source: {
        type: "external",
        description: "LDBC SNB benchmark trusted initial import",
      },
    },
  });

  const persons = createBatcher<SnbPersonRow>(BATCH_SIZE, (batch) =>
    channel.push({
      type: "nodes",
      nodes: batch.map(({ id, ...properties }) => ({
        kind: "Person",
        id,
        properties,
      })),
    }),
  );
  const forums = createBatcher<SnbForumRow>(BATCH_SIZE, (batch) =>
    channel.push({
      type: "nodes",
      nodes: batch.map(({ id, ...properties }) => ({
        kind: "Forum",
        id,
        properties,
      })),
    }),
  );
  const posts = createBatcher<SnbPostRow>(BATCH_SIZE, (batch) =>
    channel.push({
      type: "nodes",
      nodes: batch.map(({ id, ...properties }) => ({
        kind: "Post",
        id,
        properties,
      })),
    }),
  );
  const comments = createBatcher<SnbCommentRow>(BATCH_SIZE, (batch) =>
    channel.push({
      type: "nodes",
      nodes: batch.map(({ id, ...properties }) => ({
        kind: "Comment",
        id,
        properties,
      })),
    }),
  );

  async function flushNodes(): Promise<void> {
    await persons.finish();
    await forums.finish();
    await posts.finish();
    await comments.finish();
  }

  const nodePass = await streamSnbCsvDataset(
    datasetRoot,
    {
      person: (row) => persons.push(row),
      forum: (row) => forums.push(row),
      post: (row) => posts.push(row),
      comment: (row) => comments.push(row),
      edge: ignoreRow,
      stageComplete: flushNodes,
    },
    log,
  );
  await flushNodes();

  const knowsEdges = createBatcher<KnowsEdgeRow>(BATCH_SIZE, (batch) =>
    channel.push({
      type: "edges",
      edges: batch.map((row) => ({
        kind: row.kind,
        id: edgeId(row),
        from: { kind: "Person", id: row.fromId },
        to: { kind: "Person", id: row.toId },
        properties: {
          since: row.createdAt,
          weight: synthesizeKnowsWeight(row.fromId, row.toId),
        },
      })),
    }),
  );
  const hasCreatorEdges = createBatcher<HasCreatorEdgeRow>(
    BATCH_SIZE,
    (batch) =>
      channel.push({
        type: "edges",
        edges: batch.map((row) => ({
          kind: row.kind,
          id: edgeId(row),
          from: { kind: row.fromKind, id: row.fromId },
          to: { kind: "Person", id: row.toId },
          properties: {},
        })),
      }),
  );
  const containerOfEdges = createBatcher<ContainerOfEdgeRow>(
    BATCH_SIZE,
    (batch) =>
      channel.push({
        type: "edges",
        edges: batch.map((row) => ({
          kind: row.kind,
          id: edgeId(row),
          from: { kind: "Forum", id: row.fromId },
          to: { kind: "Post", id: row.toId },
          properties: {},
        })),
      }),
  );
  const replyOfEdges = createBatcher<ReplyOfEdgeRow>(BATCH_SIZE, (batch) =>
    channel.push({
      type: "edges",
      edges: batch.map((row) => ({
        kind: row.kind,
        id: edgeId(row),
        from: { kind: "Comment", id: row.fromId },
        to: { kind: row.toKind, id: row.toId },
        properties: {},
      })),
    }),
  );

  async function flushEdges(): Promise<void> {
    await knowsEdges.finish();
    await hasCreatorEdges.finish();
    await containerOfEdges.finish();
    await replyOfEdges.finish();
  }

  await streamSnbCsvDataset(
    datasetRoot,
    {
      person: ignoreRow,
      forum: ignoreRow,
      post: ignoreRow,
      comment: ignoreRow,
      edge: (row) => {
        switch (row.kind) {
          case "knows": {
            return knowsEdges.push(row);
          }
          case "hasCreator": {
            return hasCreatorEdges.push(row);
          }
          case "containerOf": {
            return containerOfEdges.push(row);
          }
          case "replyOf": {
            return replyOfEdges.push(row);
          }
        }
      },
      stageComplete: flushEdges,
    },
    () => undefined,
  );
  await flushEdges();

  return nodePass.pools;
}

export async function loadSnbDataset(
  store: SnbStore,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  const channel = createChunkChannel();
  const producer = produceTrustedChunks(channel, datasetRoot, log).then(
    (result) => {
      channel.close();
      return result;
    },
    (error: unknown) => {
      channel.fail(error);
      throw error;
    },
  );

  try {
    const [, pools] = await Promise.all([
      trustedImportGraphStream(store, channel),
      producer,
    ]);
    return pools;
  } catch (error) {
    channel.fail(error);
    await producer.catch(() => undefined);
    throw error;
  }
}
