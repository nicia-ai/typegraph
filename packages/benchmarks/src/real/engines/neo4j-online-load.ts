/**
 * Online load path for a Neo4j server the harness did not start
 * (`TYPEGRAPH_BENCH_NEO4J_URL`). The container path loads with an offline
 * `neo4j-admin database import full` into an empty volume before the server
 * starts, which an already-running server cannot do, so this path writes the
 * same graph (`./neo4j-graph-shape.ts`) through the driver in batched
 * `UNWIND $rows` transactions.
 *
 * Nodes are written as they stream. Relationships are spooled to local NDJSON
 * files and written only after every node exists, because the LDBC streams
 * can name a relationship endpoint before its node row arrives (a reply's
 * parent comment can come later in the comment file), and a `MATCH` against a
 * node that is not there yet would silently create nothing. Every batch also
 * checks the server's own counters: a batch that created fewer nodes or
 * relationships than it had rows fails the load, the online counterpart of
 * the offline importer's refusal of dangling relationships.
 *
 * The uniqueness constraints (`ensureSchema` in `./neo4j.ts`) are created
 * before this load runs, so each relationship's endpoint lookups are index
 * seeks. Query time then sees exactly the constraints the offline path
 * creates after its import, so query latencies stay comparable; load times do
 * not, and the run header names the load path.
 */
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createInterface } from "node:readline";

import { type Session } from "neo4j-driver";

import {
  type SnbEdgeRow,
  type SnbIdPools,
  streamSnbCsvDataset,
} from "../dataset/ldbc-csv";
import {
  NEO4J_EDGE_KINDS,
  NEO4J_NODE_KINDS,
  type Neo4jEdgeKind,
  type Neo4jNodeKind,
  type Neo4jNodeRow,
  nodeValues,
} from "./neo4j-graph-shape";

/** Rows per write transaction. */
export const ONLINE_LOAD_BATCH_ROWS = 10_000;

const NODE_KIND_ORDER: readonly Neo4jNodeKind[] = [
  "person",
  "forum",
  "post",
  "comment",
];
const EDGE_KIND_ORDER: readonly Neo4jEdgeKind[] = [
  "knows",
  "hasCreator",
  "containerOf",
  "replyOf",
];

/** `UNWIND $rows AS row CREATE (:Label {prop: row.prop, ...})` for one node kind. */
export function nodeCreateStatement(kind: Neo4jNodeKind): string {
  const shape = NEO4J_NODE_KINDS[kind];
  const properties = shape.properties
    .map((property) => `${property}: row.${property}`)
    .join(", ");
  return `UNWIND $rows AS row CREATE (:${shape.labels.join(":")} {${properties}})`;
}

/**
 * `UNWIND $rows AS row MATCH (a) MATCH (b) CREATE (a)-[:TYPE]->(b)` for one
 * relationship kind, matching each endpoint by `id` on a constrained label.
 */
export function edgeCreateStatement(kind: Neo4jEdgeKind): string {
  const shape = NEO4J_EDGE_KINDS[kind];
  const properties: readonly string[] = shape.properties;
  const propertyMap =
    properties.length === 0 ?
      ""
    : ` {${properties.map((property) => `${property}: row.${property}`).join(", ")}}`;
  return (
    `UNWIND $rows AS row ` +
    `MATCH (a:${shape.fromLabel} {id: row.fromId}) ` +
    `MATCH (b:${shape.toLabel} {id: row.toId}) ` +
    `CREATE (a)-[:${shape.type}${propertyMap}]->(b)`
  );
}

/** A relationship row as spooled and sent: endpoint ids plus its properties. */
export type OnlineEdgeRow = Readonly<Record<string, string>>;

/** The spooled form of one streamed LDBC edge, keyed by its relationship kind. */
export function toOnlineEdgeRow(
  row: SnbEdgeRow,
): Readonly<{ kind: Neo4jEdgeKind; row: OnlineEdgeRow }> {
  switch (row.kind) {
    case "knows": {
      return {
        kind: "knows",
        row: { fromId: row.fromId, toId: row.toId, since: row.createdAt },
      };
    }
    case "hasCreator":
    case "containerOf":
    case "replyOf": {
      return { kind: row.kind, row: { fromId: row.fromId, toId: row.toId } };
    }
  }
}

/**
 * Throws unless a batch's write created one entity per row. `created` is the
 * server's own counter for the statement.
 */
export function assertBatchCreatedEveryRow(
  what: string,
  rows: number,
  created: number,
): void {
  if (created !== rows) {
    throw new Error(
      `Neo4j online load: a ${what} batch of ${rows} rows created ${created}; ` +
        "an endpoint did not match or a row was dropped, so the loaded graph would not be the dataset.",
    );
  }
}

type CounterName = "nodesCreated" | "relationshipsCreated";

async function writeBatch(
  session: Session,
  statement: string,
  rows: readonly Readonly<Record<string, string>>[],
  counter: CounterName,
  what: string,
): Promise<void> {
  const summary = await session.executeWrite(async (tx) =>
    tx.run(statement, { rows }).summary(),
  );
  assertBatchCreatedEveryRow(
    what,
    rows.length,
    summary.counters.updates()[counter],
  );
}

type NodeBatcher = Readonly<{
  push: (row: Neo4jNodeRow) => Promise<void>;
  flush: () => Promise<void>;
  count: () => number;
}>;

function createNodeBatcher(session: Session, kind: Neo4jNodeKind): NodeBatcher {
  const statement = nodeCreateStatement(kind);
  const properties: readonly string[] = NEO4J_NODE_KINDS[kind].properties;
  let buffer: Readonly<Record<string, string>>[] = [];
  let written = 0;

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    await writeBatch(session, statement, rows, "nodesCreated", kind);
    written += rows.length;
  }

  return {
    async push(row) {
      // Only the shape's properties are sent, in the same form the offline
      // CSV stages them, so both paths store identical nodes.
      const values = nodeValues(kind, row);
      buffer.push(
        Object.fromEntries(
          properties.map((property, index) => [property, values[index]!]),
        ),
      );
      if (buffer.length >= ONLINE_LOAD_BATCH_ROWS) await flush();
    },
    flush,
    count: () => written,
  };
}

type EdgeSpool = Readonly<{
  path: string;
  write: (row: OnlineEdgeRow) => Promise<void>;
  finish: () => Promise<void>;
}>;

function createEdgeSpool(path: string): EdgeSpool {
  const stream = createWriteStream(path, { encoding: "utf-8" });
  return {
    path,
    async write(row) {
      if (!stream.write(`${JSON.stringify(row)}\n`)) {
        await once(stream, "drain");
      }
    },
    async finish() {
      stream.end();
      await once(stream, "finish");
    },
  };
}

async function writeSpooledEdges(
  session: Session,
  kind: Neo4jEdgeKind,
  path: string,
): Promise<number> {
  const statement = edgeCreateStatement(kind);
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });
  let batch: OnlineEdgeRow[] = [];
  let written = 0;
  for await (const line of lines) {
    if (line === "") continue;
    batch.push(JSON.parse(line) as OnlineEdgeRow);
    if (batch.length >= ONLINE_LOAD_BATCH_ROWS) {
      await writeBatch(session, statement, batch, "relationshipsCreated", kind);
      written += batch.length;
      batch = [];
    }
  }
  if (batch.length > 0) {
    await writeBatch(session, statement, batch, "relationshipsCreated", kind);
    written += batch.length;
  }
  return written;
}

/**
 * Streams the LDBC dataset into `session`'s database. The database must
 * already be empty and carry the uniqueness constraints; see the module doc.
 */
export async function loadSnbDatasetOnline(
  session: Session,
  datasetRoot: string,
  log: (message: string) => void,
): Promise<SnbIdPools> {
  const spoolDir = await mkdtemp(
    join(tmpdir(), "typegraph-bench-snb-neo4j-edges-"),
  );
  try {
    const nodes = Object.fromEntries(
      NODE_KIND_ORDER.map((kind) => [kind, createNodeBatcher(session, kind)]),
    ) as Record<Neo4jNodeKind, NodeBatcher>;
    const spools = Object.fromEntries(
      EDGE_KIND_ORDER.map((kind) => [
        kind,
        createEdgeSpool(join(spoolDir, `${kind}.ndjson`)),
      ]),
    ) as Record<Neo4jEdgeKind, EdgeSpool>;

    async function flushNodes(): Promise<void> {
      for (const kind of NODE_KIND_ORDER) {
        await nodes[kind].flush();
      }
    }

    const result = await streamSnbCsvDataset(
      datasetRoot,
      {
        person: (row) => nodes.person.push(row),
        forum: (row) => nodes.forum.push(row),
        post: (row) => nodes.post.push(row),
        comment: (row) => nodes.comment.push(row),
        edge: (row) => {
          const spooled = toOnlineEdgeRow(row);
          return spools[spooled.kind].write(spooled.row);
        },
        stageComplete: flushNodes,
      },
      log,
    );
    await flushNodes();
    for (const kind of EDGE_KIND_ORDER) {
      await spools[kind].finish();
    }
    log(
      `online load: nodes written (${NODE_KIND_ORDER.map((kind) => `${kind}=${nodes[kind].count()}`).join(", ")})`,
    );

    for (const kind of EDGE_KIND_ORDER) {
      const written = await writeSpooledEdges(session, kind, spools[kind].path);
      log(
        `online load: ${NEO4J_EDGE_KINDS[kind].type} relationships=${written}`,
      );
    }
    return result.pools;
  } finally {
    await rm(spoolDir, { recursive: true, force: true });
  }
}
