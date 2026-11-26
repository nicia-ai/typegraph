import { describe, expect, it } from "vitest";
import { z } from "zod";

import { defineEdge, defineGraph, defineNode } from "../../../src";
import { UnsupportedBackendCapabilityError } from "../../../src/errors";
import { defineGraphExtension } from "../../../src/graph-extension";
import { defineEdgeIndex, defineNodeIndex } from "../../../src/indexes";
import { type IndexDeclaration } from "../../../src/indexes/types";
import { getCommittedSchemaVersion } from "../../../src/schema";
import {
  type IntegrationLaneDriver,
  type IntegrationTestContext,
} from "./test-context";

/**
 * Cross-backend coverage for the `dateIndexExpressions` capability (#927).
 *
 * A declared index whose key, covering column or partial-index predicate
 * reads a date-typed property compiles to a text-to-timestamptz cast on
 * PostgreSQL, which the engine refuses in an index (42P17: not immutable).
 * Every PostgreSQL lane declares the gap and `materializeIndexes()` refuses
 * the declaration with a typed error before any DDL; every SQLite lane builds
 * the same declaration.
 */

const Event = defineNode("Event", {
  schema: z.object({
    at: z.date(),
    optAt: z.date().optional(),
    label: z.string(),
    info: z.object({ at: z.date() }),
    dates: z.array(z.date()).optional(),
  }),
});

const Tag = defineNode("Tag", { schema: z.object({ name: z.string() }) });

const scheduled = defineEdge("scheduled", {
  schema: z.object({ at: z.date(), n: z.number() }),
});

const DATE_INDEX_LANES: Readonly<Record<IntegrationLaneDriver, boolean>> = {
  "better-sqlite3": true,
  libsql: true,
  pglite: false,
  "node-postgres": false,
  "postgres-js": false,
};

let sequence = 0;

function uniqueSuffix(): string {
  sequence += 1;
  return `${Date.now().toString(36)}_${sequence}`;
}

type DateIndexCase = Readonly<{
  label: string;
  build: (name: string) => IndexDeclaration;
  entity: "node" | "edge";
  kind: string;
  field: string;
  position: "key" | "coveringField" | "where";
  positionLabel: string;
}>;

const AFTER_2024 = new Date("2024-01-01T00:00:00.000Z");

const DATE_INDEX_CASES: readonly DateIndexCase[] = [
  {
    label: "a node field",
    build: (name) => defineNodeIndex(Event, { name, fields: ["at"] }),
    entity: "node",
    kind: "Event",
    field: "/at",
    position: "key",
    positionLabel: "key",
  },
  {
    label: "an optional node field",
    build: (name) => defineNodeIndex(Event, { name, fields: ["optAt"] }),
    entity: "node",
    kind: "Event",
    field: "/optAt",
    position: "key",
    positionLabel: "key",
  },
  {
    label: "a composite node index",
    build: (name) => defineNodeIndex(Event, { name, fields: ["label", "at"] }),
    entity: "node",
    kind: "Event",
    field: "/at",
    position: "key",
    positionLabel: "key",
  },
  {
    label: "a unique node index",
    build: (name) =>
      defineNodeIndex(Event, { name, fields: ["at"], unique: true }),
    entity: "node",
    kind: "Event",
    field: "/at",
    position: "key",
    positionLabel: "key",
  },
  {
    label: "an ordered node key",
    build: (name) =>
      defineNodeIndex(Event, {
        name,
        keys: [{ field: "at", direction: "desc" }],
      }),
    entity: "node",
    kind: "Event",
    field: "/at",
    position: "key",
    positionLabel: "key",
  },
  {
    label: "a covering field",
    build: (name) =>
      defineNodeIndex(Event, {
        name,
        fields: ["label"],
        coveringFields: ["at"],
      }),
    entity: "node",
    kind: "Event",
    field: "/at",
    position: "coveringField",
    positionLabel: "covering column",
  },
  {
    label: "a nested node field",
    build: (name) =>
      defineNodeIndex(Event, { name, fields: [["info", "at"] as const] }),
    entity: "node",
    kind: "Event",
    field: "/info/at",
    position: "key",
    positionLabel: "key",
  },
  {
    label: "a partial-index comparison",
    build: (name) =>
      defineNodeIndex(Event, {
        name,
        fields: ["label"],
        where: (where) => where.at.gt(AFTER_2024),
      }),
    entity: "node",
    kind: "Event",
    field: "/at",
    position: "where",
    positionLabel: "partial-index where clause",
  },
  {
    label: "a partial-index null check",
    build: (name) =>
      defineNodeIndex(Event, {
        name,
        fields: ["label"],
        where: (where) => where.optAt.isNull(),
      }),
    entity: "node",
    kind: "Event",
    field: "/optAt",
    position: "where",
    positionLabel: "partial-index where clause",
  },
  {
    label: "an edge field",
    build: (name) => defineEdgeIndex(scheduled, { name, fields: ["at"] }),
    entity: "edge",
    kind: "scheduled",
    field: "/at",
    position: "key",
    positionLabel: "key",
  },
  {
    label: "a composite edge index",
    build: (name) => defineEdgeIndex(scheduled, { name, fields: ["n", "at"] }),
    entity: "edge",
    kind: "scheduled",
    field: "/at",
    position: "key",
    positionLabel: "key",
  },
  {
    label: "an edge partial-index comparison",
    build: (name) =>
      defineEdgeIndex(scheduled, {
        name,
        fields: ["n"],
        where: (where) => where.at.lt(AFTER_2024),
      }),
    entity: "edge",
    kind: "scheduled",
    field: "/at",
    position: "where",
    positionLabel: "partial-index where clause",
  },
];

function buildGraph(indexes: readonly IndexDeclaration[]) {
  return defineGraph({
    id: `date_index_${uniqueSuffix()}`,
    nodes: { Event: { type: Event }, Tag: { type: Tag } },
    edges: { scheduled: { type: scheduled, from: [Event], to: [Event] } },
    indexes,
  });
}

type MaterializeOutcome =
  | Readonly<{ results: readonly unknown[] }>
  | Readonly<{
      refused: Readonly<{
        type: string;
        message: string;
        details: unknown;
      }>;
    }>;

/**
 * Settles a `materializeIndexes()` call into one comparable value, so each
 * test asserts a single lane-derived expectation instead of branching.
 */
async function materializeOutcome(
  call: () => Promise<Readonly<{ results: readonly unknown[] }>>,
): Promise<MaterializeOutcome> {
  try {
    const { results } = await call();
    return { results };
  } catch (error) {
    if (!(error instanceof UnsupportedBackendCapabilityError)) throw error;
    return {
      refused: {
        type: error.name,
        message: error.message,
        details: error.details,
      },
    };
  }
}

function dateIndexRefusal(
  name: string,
  testCase: Pick<
    DateIndexCase,
    "entity" | "kind" | "field" | "position" | "positionLabel"
  >,
): MaterializeOutcome {
  return {
    refused: {
      type: "UnsupportedBackendCapabilityError",
      message: `store.materializeIndexes() requires backend capability 'dateIndexExpressions'. Index "${name}" on ${testCase.entity} kind "${testCase.kind}" reads date-typed field "${testCase.field}" in its ${testCase.positionLabel}; this backend cannot build an index over a date property (on PostgreSQL, the text-to-timestamptz cast it needs is not immutable).`,
      details: {
        operation: "store.materializeIndexes()",
        capability: "dateIndexExpressions",
        entity: testCase.entity,
        kind: testCase.kind,
        indexName: name,
        field: testCase.field,
        position: testCase.position,
      },
    },
  };
}

export function registerDateIndexExpressionIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("date-typed index expressions (#927)", () => {
    it("declares the gap on exactly the PostgreSQL lanes", () => {
      expect(context.getBackend().capabilities.dateIndexExpressions).toBe(
        DATE_INDEX_LANES[context.driver],
      );
    });

    for (const testCase of DATE_INDEX_CASES) {
      it(`refuses or builds a date-typed index on ${testCase.label}`, async () => {
        const name = `idx_date_${uniqueSuffix()}`;
        const store = await context.createStore(
          buildGraph([testCase.build(name)]),
        );
        const builds = DATE_INDEX_LANES[context.driver];

        const outcome = await materializeOutcome(() =>
          store.materializeIndexes(),
        );

        expect(outcome).toEqual(
          builds ?
            {
              results: [
                {
                  indexName: name,
                  entity: testCase.entity,
                  kind: testCase.kind,
                  status: "created",
                },
              ],
            }
          : dateIndexRefusal(name, testCase),
        );
      });
    }

    it("refuses before building any sibling index of the same call", async () => {
      const dateIndexName = `idx_date_${uniqueSuffix()}`;
      const tagIndexName = `idx_tag_${uniqueSuffix()}`;
      const store = await context.createStore(
        buildGraph([
          defineNodeIndex(Tag, { name: tagIndexName, fields: ["name"] }),
          defineNodeIndex(Event, { name: dateIndexName, fields: ["at"] }),
        ]),
      );
      const builds = DATE_INDEX_LANES[context.driver];

      const outcome = await materializeOutcome(() =>
        store.materializeIndexes(),
      );
      // A refused call built nothing, so the sibling is still to be created;
      // a call that built both leaves it already materialized.
      const tagOnly = await store.materializeIndexes({ kinds: ["Tag"] });

      expect(outcome).toEqual(
        builds ?
          {
            results: [
              {
                indexName: tagIndexName,
                entity: "node",
                kind: "Tag",
                status: "created",
              },
              {
                indexName: dateIndexName,
                entity: "node",
                kind: "Event",
                status: "created",
              },
            ],
          }
        : dateIndexRefusal(dateIndexName, {
            entity: "node",
            kind: "Event",
            field: "/at",
            position: "key",
            positionLabel: "key",
          }),
      );
      expect(tagOnly.results).toEqual([
        {
          indexName: tagIndexName,
          entity: "node",
          kind: "Tag",
          status: builds ? "alreadyMaterialized" : "created",
        },
      ]);
    });

    it("refuses an eager evolve before committing the new schema version", async () => {
      const name = `idx_date_${uniqueSuffix()}`;
      const graph = buildGraph([
        defineNodeIndex(Event, { name, fields: ["at"] }),
      ]);
      const store = await context.createStore(graph);
      const backend = context.getBackend();
      const before = await getCommittedSchemaVersion(backend, graph.id);
      const builds = DATE_INDEX_LANES[context.driver];

      const outcome = await materializeOutcome(async () => {
        const evolved = await store.evolve(
          defineGraphExtension({
            nodes: { Note: { properties: { body: { type: "string" } } } },
          }),
          { eager: {} },
        );
        return evolved.materializeIndexes();
      });
      const after = await getCommittedSchemaVersion(backend, graph.id);

      expect({ outcome, after }).toEqual({
        outcome:
          builds ?
            {
              results: [
                {
                  indexName: name,
                  entity: "node",
                  kind: "Event",
                  status: "alreadyMaterialized",
                },
              ],
            }
          : dateIndexRefusal(name, {
              entity: "node",
              kind: "Event",
              field: "/at",
              position: "key",
              positionLabel: "key",
            }),
        after: builds ? (before ?? 0) + 1 : before,
      });
    });

    it("builds a GIN index over an array of dates wherever GIN exists", async () => {
      const name = `idx_dates_${uniqueSuffix()}`;
      const store = await context.createStore(
        buildGraph([
          defineNodeIndex(Event, { name, fields: ["dates"], method: "gin" }),
        ]),
      );
      const result = await store.materializeIndexes();
      expect(result.results).toHaveLength(1);
      expect(result.results[0]?.status).toBe(
        DATE_INDEX_LANES[context.driver] ? "skipped" : "created",
      );
    });
  });
}
