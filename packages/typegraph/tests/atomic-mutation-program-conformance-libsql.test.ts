import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { createClient } from "@libsql/client";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  markBundledRootAtomicMutationPrograms,
  resolveAtomicMutationPrograms,
} from "../src/backend/capabilities/atomic-mutation-program";
import { runAtomicMutationProgramConformance } from "../src/backend/conformance/atomic-mutation-program";
import { createLibsqlBackend } from "../src/backend/sqlite/libsql";
import { defineGraph, defineNode } from "../src/core";
import { StaleVersionError, ValidationError } from "../src/errors";
import { migrateSchema } from "../src/schema";
import { createStoreWithSchema } from "../src/store";
import { requireDefined } from "../src/utils/presence";

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

function definePersonGraph(id: string) {
  return defineGraph({
    id,
    nodes: { Person: { type: Person } },
    edges: {},
  });
}

function defineEvolvedPersonGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      Person: {
        type: defineNode("Person", {
          schema: z.object({
            name: z.string(),
            nickname: z.string().optional(),
          }),
        }),
      },
    },
    edges: {},
  });
}

async function createFixture() {
  const temporaryDirectory = mkdtempSync(
    path.join(tmpdir(), "typegraph-semantic-conformance-"),
  );
  const client = createClient({
    url: `file:${path.join(temporaryDirectory, "graph.db")}`,
  });
  const { backend } = await createLibsqlBackend(client);
  const successGraph = definePersonGraph("semantic-conformance-success");
  const staleGraph = definePersonGraph("semantic-conformance-stale");
  const refusalGraph = definePersonGraph("semantic-conformance-refusal");
  const [[successStore], [staleStore], [refusalStore]] = await Promise.all([
    createStoreWithSchema(successGraph, backend),
    createStoreWithSchema(staleGraph, backend),
    createStoreWithSchema(refusalGraph, backend),
  ]);
  const createNodes = requireDefined(
    resolveAtomicMutationPrograms(backend)?.createNodes,
  );
  markBundledRootAtomicMutationPrograms(backend, { createNodes });

  return {
    backend,
    client,
    refusalGraph,
    refusalStore,
    staleGraph,
    staleStore,
    successGraph,
    successStore,
    close: async () => {
      await backend.close();
      client.close();
      rmSync(temporaryDirectory, { recursive: true, force: true });
    },
  };
}

async function readLivePeople(
  client: ReturnType<typeof createClient>,
  graphId: string,
): Promise<readonly (readonly [string, string])[]> {
  const result = await client.execute({
    sql: `
      SELECT id, json_extract(props, '$.name') AS name
      FROM typegraph_nodes
      WHERE graph_id = ? AND kind = ? AND deleted_at IS NULL
      ORDER BY id
    `,
    args: [graphId, "Person"],
  });
  return result.rows.map((row) => {
    if (typeof row["id"] !== "string" || typeof row["name"] !== "string") {
      throw new TypeError("Expected string node id and name columns.");
    }
    return [row["id"], row["name"]] as const;
  });
}

describe("atomic mutation program semantic conformance: libSQL", () => {
  it("proves the complete createNodes Store contract against a real engine", async () => {
    const fixture = await createFixture();
    const batch = vi.spyOn(fixture.client, "batch");

    try {
      const report = await runAtomicMutationProgramConformance({
        backend: fixture.backend,
        equal: (actual, expected) =>
          JSON.stringify(actual) === JSON.stringify(expected),
        cases: [
          {
            variant: "createNodes",
            orderedSuccess: {
              prepare: () => ({
                expectedResult: [
                  ["second", "Second"],
                  ["first", "First"],
                ],
                expectedState: [
                  ["first", "First"],
                  ["second", "Second"],
                ],
              }),
              resolveBackend: () => fixture.backend,
              execute: async () => {
                const nodes =
                  await fixture.successStore.nodes.Person.bulkCreate([
                    { id: "second", props: { name: "Second" } },
                    { id: "first", props: { name: "First" } },
                  ]);
                return nodes.map((node) => [node.id, node.name]);
              },
              observeDispatchCount: () => batch.mock.calls.length,
              observeState: () =>
                readLivePeople(fixture.client, fixture.successGraph.id),
            },
            staleFenceNoWrite: {
              prepare: async () => {
                await migrateSchema(
                  fixture.backend,
                  defineEvolvedPersonGraph(fixture.staleGraph.id),
                  1,
                );
                return { expectedState: [] };
              },
              resolveBackend: () => fixture.backend,
              execute: () =>
                fixture.staleStore.nodes.Person.bulkInsert([
                  { id: "stale", props: { name: "Stale" } },
                ]),
              observeDispatchCount: () => batch.mock.calls.length,
              observeState: () =>
                readLivePeople(fixture.client, fixture.staleGraph.id),
              errorMatches: (error) => error instanceof StaleVersionError,
            },
            semanticRefusalRollback: {
              prepare: async () => {
                await fixture.refusalStore.nodes.Person.create(
                  { name: "Existing" },
                  { id: "existing" },
                );
                return { expectedState: [["existing", "Existing"]] };
              },
              resolveBackend: () => fixture.backend,
              execute: () =>
                fixture.refusalStore.nodes.Person.bulkInsert([
                  { id: "new", props: { name: "New" } },
                  { id: "existing", props: { name: "Duplicate" } },
                ]),
              observeDispatchCount: () => batch.mock.calls.length,
              observeState: () =>
                readLivePeople(fixture.client, fixture.refusalGraph.id),
              errorMatches: (error) => error instanceof ValidationError,
            },
          },
        ],
      });

      expect(report.variants).toEqual([
        {
          variant: "createNodes",
          passed: [
            "ordered result and committed state",
            "stale fence no-write",
            "semantic refusal rollback",
          ],
        },
      ]);
    } finally {
      await fixture.close();
    }
  });
});
