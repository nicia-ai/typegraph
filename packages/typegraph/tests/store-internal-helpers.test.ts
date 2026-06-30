import { type SQL, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { gateFulltext } from "../src/backend/drizzle/contribution-materializations";
import {
  createBackendOverlay,
  type EdgeRow,
  type GraphBackend,
  type HardDeleteNodeParams,
  type InsertEdgeParams,
  type InsertNodeParams,
  type NodeRow,
  type TransactionBackend,
  wrapWithManagedClose,
} from "../src/backend/types";
import { asRecordedInstant } from "../src/core/temporal";
import { ConfigurationError } from "../src/errors";
import {
  createRecordedReadBinding,
  createSqlSchema,
} from "../src/query/compiler/schema";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../src/query/sql-intent";
import { getEdgeRowsByIds } from "../src/store/edge-fetch";
import {
  edgeInsertDispatch,
  type InsertDispatch,
  nodeInsertDispatch,
  runInsertBatch,
  runInsertBatchReturning,
  runInsertNoReturn,
} from "../src/store/insert-dispatch";
import { getNodeRowsByIds } from "../src/store/node-fetch";
import { createRecordedBackend } from "../src/store/recorded-capture";
import { recordedBindParamBudget } from "../src/store/recorded-capture/relations";
import { createRecordedReadService } from "../src/store/recorded-read-service";
import { getRowsByIds } from "../src/store/row-fetch";

type TestRow = Readonly<{ id: string; value: number }>;
type TestParams = Readonly<{ id: string; value: number }>;

const TIMESTAMP = "2026-01-01T00:00:00.000Z";

function nodeRow(id: string): NodeRow {
  return {
    graph_id: "graph",
    kind: "Person",
    id,
    props: "{}",
    version: 1,
    valid_from: undefined,
    valid_to: undefined,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    deleted_at: undefined,
  };
}

function edgeRow(id: string): EdgeRow {
  return {
    graph_id: "graph",
    id,
    kind: "knows",
    from_kind: "Person",
    from_id: "from",
    to_kind: "Person",
    to_id: "to",
    props: "{}",
    valid_from: undefined,
    valid_to: undefined,
    created_at: TIMESTAMP,
    updated_at: TIMESTAMP,
    deleted_at: undefined,
  };
}

class PrototypeInsertBackend {
  readonly calls: string[] = [];

  insertNode(params: InsertNodeParams): Promise<NodeRow> {
    this.calls.push(`insertNode:${params.id}`);
    return Promise.resolve(nodeRow(params.id));
  }

  insertNodeNoReturn(params: InsertNodeParams): Promise<void> {
    this.calls.push(`insertNodeNoReturn:${params.id}`);
    return Promise.resolve();
  }

  insertNodesBatch(params: readonly InsertNodeParams[]): Promise<void> {
    this.calls.push(
      `insertNodesBatch:${params.map((parameter) => parameter.id).join(",")}`,
    );
    return Promise.resolve();
  }

  insertNodesBatchReturning(
    params: readonly InsertNodeParams[],
  ): Promise<readonly NodeRow[]> {
    this.calls.push(
      `insertNodesBatchReturning:${params.map((parameter) => parameter.id).join(",")}`,
    );
    return Promise.resolve(params.map((parameter) => nodeRow(parameter.id)));
  }

  insertEdge(params: InsertEdgeParams): Promise<EdgeRow> {
    this.calls.push(`insertEdge:${params.id}`);
    return Promise.resolve(edgeRow(params.id));
  }

  insertEdgeNoReturn(params: InsertEdgeParams): Promise<void> {
    this.calls.push(`insertEdgeNoReturn:${params.id}`);
    return Promise.resolve();
  }

  insertEdgesBatch(params: readonly InsertEdgeParams[]): Promise<void> {
    this.calls.push(
      `insertEdgesBatch:${params.map((parameter) => parameter.id).join(",")}`,
    );
    return Promise.resolve();
  }

  insertEdgesBatchReturning(
    params: readonly InsertEdgeParams[],
  ): Promise<readonly EdgeRow[]> {
    this.calls.push(
      `insertEdgesBatchReturning:${params.map((parameter) => parameter.id).join(",")}`,
    );
    return Promise.resolve(params.map((parameter) => edgeRow(parameter.id)));
  }
}

class PrototypeReadBackend {
  readonly nodes = new Map([["node-a", nodeRow("node-a")]]);
  readonly edges = new Map([["edge-a", edgeRow("edge-a")]]);

  getNode(
    _graphId: string,
    _kind: string,
    id: string,
  ): Promise<NodeRow | undefined> {
    return Promise.resolve(this.nodes.get(id));
  }

  getNodes(
    _graphId: string,
    _kind: string,
    ids: readonly string[],
  ): Promise<readonly NodeRow[]> {
    return Promise.resolve(
      ids
        .map((id) => this.nodes.get(id))
        .filter((row): row is NodeRow => row !== undefined),
    );
  }

  getEdge(_graphId: string, id: string): Promise<EdgeRow | undefined> {
    return Promise.resolve(this.edges.get(id));
  }

  getEdges(
    _graphId: string,
    ids: readonly string[],
  ): Promise<readonly EdgeRow[]> {
    return Promise.resolve(
      ids
        .map((id) => this.edges.get(id))
        .filter((row): row is EdgeRow => row !== undefined),
    );
  }
}

class PrototypeRawBackend {
  readonly dialect = "sqlite";
  readonly calls: string[] = [];

  execute<T>(_query: unknown): Promise<readonly T[]> {
    this.calls.push("execute");
    return Promise.resolve([]);
  }

  executeRaw<T>(
    sqlText: string,
    _params: readonly unknown[],
  ): Promise<readonly T[]> {
    this.calls.push(`executeRaw:${sqlText}`);
    return Promise.resolve([{ value: this.calls.length } as T]);
  }
}

class PrototypeGraphBackend {
  readonly #marker = "prototype";
  readonly calls: string[] = [];
  readonly dialect = "sqlite";

  get capabilities(): GraphBackend["capabilities"] {
    return {
      transactions: true,
      windowFunctions: true,
      returning: true,
    };
  }

  get tableNames(): GraphBackend["tableNames"] {
    return createSqlSchema().tables;
  }

  execute<T>(_query: SQL): Promise<readonly T[]> {
    this.calls.push(`execute:${this.#marker}`);
    return Promise.resolve([]);
  }

  executeRaw<T>(
    sqlText: string,
    _params: readonly unknown[],
  ): Promise<readonly T[]> {
    this.calls.push(`executeRaw:${this.#marker}:${sqlText}`);
    return Promise.resolve([]);
  }

  executeStatement(_query: SQL): Promise<void> {
    this.calls.push(`executeStatement:${this.#marker}`);
    return Promise.resolve();
  }

  hardDeleteNode(params: HardDeleteNodeParams): Promise<void> {
    this.calls.push(`hardDeleteNode:${this.#marker}:${params.id}`);
    return Promise.resolve();
  }

  compileSql(
    _query: SQL,
  ): Readonly<{ sql: string; params: readonly unknown[] }> {
    this.calls.push(`compileSql:${this.#marker}`);
    return { sql: "SELECT 1", params: [] };
  }

  close(): Promise<void> {
    this.calls.push(`close:${this.#marker}`);
    return Promise.resolve();
  }
}

function nodeParams(id: string): InsertNodeParams {
  return { graphId: "graph", kind: "Person", id, props: {} };
}

function edgeParams(id: string): InsertEdgeParams {
  return {
    graphId: "graph",
    id,
    kind: "knows",
    fromKind: "Person",
    fromId: "from",
    toKind: "Person",
    toId: "to",
    props: {},
  };
}

describe("getRowsByIds", () => {
  it("uses the batch reader when present and preserves the caller id list", async () => {
    const calls: string[][] = [];
    const rows = await getRowsByIds<TestRow>(["a", "a", "b"], {
      batch: (ids) => {
        calls.push([...ids]);
        return Promise.resolve([
          { id: "a", value: 1 },
          { id: "b", value: 2 },
        ]);
      },
      one: (id) => Promise.resolve({ id, value: 99 }),
    });

    expect(calls).toEqual([["a", "a", "b"]]);
    expect([...rows.values()]).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ]);
  });

  it("deduplicates fallback single reads and omits missing rows", async () => {
    const calls: string[] = [];
    const rows = await getRowsByIds<TestRow>(["a", "a", "missing"], {
      one: (id) => {
        calls.push(id);
        return Promise.resolve(id === "missing" ? undefined : { id, value: 1 });
      },
    });

    expect(calls).toEqual(["a", "missing"]);
    expect([...rows.values()]).toEqual([{ id: "a", value: 1 }]);
  });
});

describe("insert dispatch", () => {
  it("prefers no-return and batch primitives when available", async () => {
    const calls: string[] = [];
    const dispatch: InsertDispatch<TestParams, TestRow> = {
      one: (params) => {
        calls.push(`one:${params.id}`);
        return Promise.resolve(params);
      },
      oneNoReturn: (params) => {
        calls.push(`oneNoReturn:${params.id}`);
        return Promise.resolve();
      },
      batch: (params) => {
        calls.push(
          `batch:${params.map((parameter) => parameter.id).join(",")}`,
        );
        return Promise.resolve();
      },
    };

    await runInsertNoReturn(dispatch, { id: "a", value: 1 });
    await runInsertBatch(dispatch, [
      { id: "b", value: 2 },
      { id: "c", value: 3 },
    ]);

    expect(calls).toEqual(["oneNoReturn:a", "batch:b,c"]);
  });

  it("falls back to required single inserts and preserves returning order", async () => {
    const dispatch: InsertDispatch<TestParams, TestRow> = {
      one: (params) => Promise.resolve(params),
    };

    await expect(
      runInsertBatch(dispatch, [
        { id: "a", value: 1 },
        { id: "b", value: 2 },
      ]),
    ).resolves.toBeUndefined();
    await expect(
      runInsertBatchReturning(dispatch, [
        { id: "c", value: 3 },
        { id: "d", value: 4 },
      ]),
    ).resolves.toEqual([
      { id: "c", value: 3 },
      { id: "d", value: 4 },
    ]);
  });

  it("preserves this-binding for prototype backend insert helpers", async () => {
    const backend = new PrototypeInsertBackend();
    const graphBackend = backend as unknown as GraphBackend;

    await runInsertNoReturn(nodeInsertDispatch(graphBackend), nodeParams("n1"));
    await runInsertBatch(nodeInsertDispatch(graphBackend), [
      nodeParams("n2"),
      nodeParams("n3"),
    ]);
    await runInsertBatchReturning(nodeInsertDispatch(graphBackend), [
      nodeParams("n4"),
    ]);
    await runInsertNoReturn(edgeInsertDispatch(graphBackend), edgeParams("e1"));
    await runInsertBatch(edgeInsertDispatch(graphBackend), [
      edgeParams("e2"),
      edgeParams("e3"),
    ]);
    await runInsertBatchReturning(edgeInsertDispatch(graphBackend), [
      edgeParams("e4"),
    ]);

    expect(backend.calls).toEqual([
      "insertNodeNoReturn:n1",
      "insertNodesBatch:n2,n3",
      "insertNodesBatchReturning:n4",
      "insertEdgeNoReturn:e1",
      "insertEdgesBatch:e2,e3",
      "insertEdgesBatchReturning:e4",
    ]);
  });
});

describe("row fetch dispatch", () => {
  it("preserves this-binding for prototype backend batch readers", async () => {
    const backend = new PrototypeReadBackend() as unknown as GraphBackend;

    const nodes = await getNodeRowsByIds(backend, "graph", "Person", [
      "node-a",
    ]);
    const edges = await getEdgeRowsByIds(backend, "graph", ["edge-a"]);

    expect(nodes.get("node-a")?.id).toBe("node-a");
    expect(edges.get("edge-a")?.id).toBe("edge-a");
  });
});

describe("recorded read dispatch", () => {
  it("preserves this-binding for prototype backend executeRaw", async () => {
    const backend = new PrototypeRawBackend();
    const service = createRecordedReadService({
      graphId: "graph",
      backend: backend as unknown as GraphBackend,
      recordedReadBinding: createRecordedReadBinding(createSqlSchema()),
      mapRecordedNodeRow: (row) => row as unknown as NodeRow,
      mapRecordedEdgeRow: (row) => row as unknown as EdgeRow,
    });
    const recordedBackend = service.backendForCoordinate(
      {
        valid: { mode: "current" },
        recorded: { asOf: asRecordedInstant("2026-01-01T00:00:00.000Z") },
      },
      "test-recorded-read",
    );

    const rows = await recordedBackend.executeRaw!<{ value: number }>(
      "SELECT 1",
      [],
    );

    expect(rows).toEqual([{ value: 1 }]);
    expect(backend.calls).toEqual(["executeRaw:SELECT 1"]);
  });
});

describe("backend overlay wrappers", () => {
  it("delegates prototype methods with private state through generic overlays", async () => {
    const backend = new PrototypeGraphBackend();
    const overlay = createBackendOverlay(backend as unknown as GraphBackend, {
      executeStatement(_query: SQL): Promise<void> {
        backend.calls.push("overlay:executeStatement");
        return Promise.resolve();
      },
    });

    await overlay.execute(asCompiledRowsSql(sql`SELECT 1`));
    await overlay.executeStatement!(
      asCompiledStatementSql(sql`UPDATE ignored SET value = 1`),
    );
    await overlay.close();

    expect(backend.calls).toEqual([
      "execute:prototype",
      "overlay:executeStatement",
      "close:prototype",
    ]);
  });

  it("preserves prototype backend methods on managed-close wrappers", async () => {
    const backend = new PrototypeGraphBackend();
    const teardownCalls: string[] = [];
    const managed = wrapWithManagedClose(
      backend as unknown as GraphBackend,
      () => {
        teardownCalls.push("teardown");
      },
    );

    await managed.execute(asCompiledRowsSql(sql`SELECT 1`));
    await managed.close();
    await managed.close();

    expect(teardownCalls).toEqual(["teardown"]);
    expect(backend.calls).toEqual(["execute:prototype", "close:prototype"]);
  });

  it("preserves prototype backend methods on recorded capture wrappers", async () => {
    const backend = new PrototypeGraphBackend();
    const recorded = createRecordedBackend(
      backend as unknown as GraphBackend,
      createSqlSchema(),
    );

    await recorded.execute(asCompiledRowsSql(sql`SELECT 1`));
    await recorded.close();
    await expect(
      recorded.executeStatement!(
        asCompiledStatementSql(sql`UPDATE ignored SET value = 1`),
      ),
    ).rejects.toThrow("backend.executeStatement is not available");

    expect(backend.calls).toEqual(["execute:prototype", "close:prototype"]);
  });

  it("preserves prototype backend methods on recorded read wrappers", async () => {
    const backend = new PrototypeGraphBackend();
    const service = createRecordedReadService({
      graphId: "graph",
      backend: backend as unknown as GraphBackend,
      recordedReadBinding: createRecordedReadBinding(createSqlSchema()),
      mapRecordedNodeRow: (row) => row as unknown as NodeRow,
      mapRecordedEdgeRow: (row) => row as unknown as EdgeRow,
    });
    const recordedBackend = service.backendForCoordinate(
      {
        valid: { mode: "current" },
        recorded: { asOf: asRecordedInstant("2026-01-01T00:00:00.000Z") },
      },
      "test-recorded-read",
    );

    await recordedBackend.execute(asCompiledRowsSql(sql`SELECT 1`));
    recordedBackend.compileSql!(sql`SELECT 1`);
    await recordedBackend.close();

    expect(backend.calls).toEqual([
      "execute:prototype",
      "compileSql:prototype",
      "close:prototype",
    ]);
  });

  it("preserves prototype backend methods on fulltext transaction gates", async () => {
    const backend = new PrototypeGraphBackend();
    const assertedGraphIds: string[] = [];
    const gated = gateFulltext(
      backend as unknown as TransactionBackend,
      (graphId) => {
        assertedGraphIds.push(graphId);
        return Promise.resolve();
      },
    );

    await gated.execute(asCompiledRowsSql(sql`SELECT 1`));
    await gated.hardDeleteNode({
      graphId: "graph",
      kind: "Person",
      id: "person-1",
    });

    expect(assertedGraphIds).toEqual(["graph"]);
    expect(backend.calls).toEqual([
      "execute:prototype",
      "hardDeleteNode:prototype:person-1",
    ]);
  });
});

describe("recorded capture helpers", () => {
  it("throws a TypeGraph configuration error for invalid bind budgets", () => {
    expect(() =>
      recordedBindParamBudget({
        capabilities: {
          transactions: true,
          windowFunctions: true,
          maxBindParameters: 0,
        },
      }),
    ).toThrow(ConfigurationError);
  });
});
