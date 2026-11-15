import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../src";
import { projectBackendWithout } from "../src/backend/derive-backend";
import { generatePostgresDDL } from "../src/backend/drizzle/ddl";
import { createPostgresBackend } from "../src/backend/postgres";
import {
  countSchemaKindRows,
  schemaKindHasRows,
} from "../src/backend/schema-kind-emptiness";
import { createLocalSqliteBackend } from "../src/backend/sqlite/local";
import type { GraphBackend } from "../src/backend/types";
import { initializeSchema } from "../src/schema/manager";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", {
  schema: z.object({ label: z.string() }),
});

function durableGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {
      knows: {
        type: knows,
        from: [Person],
        to: [Person],
        matchIdentity: { name: "knows-label", fields: ["label"] },
      },
    },
  });
}

async function seedTombstonedEdge(
  backend: GraphBackend,
  graphId: string,
): Promise<void> {
  await backend.insertEdge({
    graphId,
    id: "legacy-edge",
    kind: "knows",
    fromKind: "Person",
    fromId: "alice",
    toKind: "Person",
    toId: "bob",
    props: { label: "friend" },
  });
  await backend.deleteEdge({ graphId, kind: "knows", id: "legacy-edge" });
}

async function expectAdoptionRefusal(
  backend: GraphBackend,
  graphId: string,
): Promise<void> {
  await seedTombstonedEdge(backend, graphId);
  const withoutGeneralPreflight = projectBackendWithout(backend, [
    "commitSchemaVersionWithPreflight",
  ]);

  await expect(
    initializeSchema(withoutGeneralPreflight, durableGraph(graphId)),
  ).rejects.toMatchObject({
    details: {
      reason: "edge-match-identity-rekey",
      edgeKinds: ["knows"],
    },
  });
  await expect(backend.getActiveSchema(graphId)).resolves.toBeUndefined();
}

describe("schema kind emptiness", () => {
  it("counts tombstones during preflight-less identity adoption on both dialects", async () => {
    const sqlite = createLocalSqliteBackend();
    try {
      await expectAdoptionRefusal(
        sqlite.backend,
        "schema_emptiness_sqlite_tombstone",
      );
    } finally {
      await sqlite.backend.close();
    }

    const client = await PGlite.create();
    await client.exec(generatePostgresDDL().join("\n\n"));
    const postgres = createPostgresBackend(drizzlePglite(client), {
      vector: false,
    });
    try {
      await expectAdoptionRefusal(
        postgres,
        "schema_emptiness_postgres_tombstone",
      );
    } finally {
      await client.close();
    }
  });
});

const PROBE_GRAPH_ID = "emptiness_probe";

function spyBackend(rowCount: number) {
  return {
    countNodesByKind: vi.fn(() => Promise.resolve(rowCount)),
    countEdgesByKind: vi.fn(() => Promise.resolve(rowCount)),
  };
}

describe("schemaKindHasRows", () => {
  it("asks a node count to stop at one row", async () => {
    const backend = spyBackend(1);

    const hasRows = await schemaKindHasRows(backend, PROBE_GRAPH_ID, {
      entity: "node",
      kind: "Person",
      rows: "nonDeleted",
    });

    expect(hasRows).toBe(true);
    expect(backend.countNodesByKind).toHaveBeenCalledExactlyOnceWith({
      graphId: PROBE_GRAPH_ID,
      kind: "Person",
      excludeDeleted: true,
      temporalMode: "includeEnded",
      limit: 1,
    });
    expect(backend.countEdgesByKind).not.toHaveBeenCalled();
  });

  it("asks an edge count to stop at one row, over every row when told to", async () => {
    const backend = spyBackend(0);

    const hasRows = await schemaKindHasRows(backend, PROBE_GRAPH_ID, {
      entity: "edge",
      kind: "knows",
      rows: "all",
    });

    expect(hasRows).toBe(false);
    expect(backend.countEdgesByKind).toHaveBeenCalledExactlyOnceWith({
      graphId: PROBE_GRAPH_ID,
      kind: "knows",
      excludeDeleted: false,
      temporalMode: "includeTombstones",
      limit: 1,
    });
  });
});

describe("countSchemaKindRows", () => {
  it("sends no limit unless one is given", async () => {
    const backend = spyBackend(7);

    const count = await countSchemaKindRows(backend, PROBE_GRAPH_ID, {
      entity: "node",
      kind: "Person",
      rows: "all",
    });

    expect(count).toBe(7);
    expect(backend.countNodesByKind).toHaveBeenCalledExactlyOnceWith({
      graphId: PROBE_GRAPH_ID,
      kind: "Person",
      excludeDeleted: false,
      temporalMode: "includeTombstones",
    });
  });
});
