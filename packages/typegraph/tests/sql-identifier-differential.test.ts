/**
 * The SQL-name guard against the unguarded compiler, on SQLite and PGlite side
 * by side. For each generated standard query over colliding and
 * near-colliding aliases:
 *
 * - with the guard, every engine returns a typed refusal or exactly the right
 *   row, and both engines reach the same verdict;
 * - a query the unguarded compiler answers correctly on both engines is not
 *   refused — the guard refuses only statements that fail, or return another
 *   value's data, on at least one engine.
 *
 * The guard is disabled by replacing `refuseConflictingSqlNames`, the one
 * function every standard-path entry point calls to apply the verdict, with a
 * pass-through for the unguarded runs.
 */
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
  type Store,
} from "../src";
import { createPostgresBackend } from "../src/backend/drizzle/postgres";
import { createLocalPgliteBackend } from "../src/backend/postgres/pglite";
import type { GraphBackend } from "../src/backend/types";
import {
  SQL_IDENTIFIER_COLLISION_CODE,
  SQL_IDENTIFIER_TOO_LONG_CODE,
  ValidationError,
} from "../src/errors";
import type * as SqlNameRegistry from "../src/query/compiler/sql-name-registry";
import { requireDefined } from "../src/utils/presence";
import { createTestBackend } from "./test-utils";

const guard = vi.hoisted(() => ({ enabled: true }));

vi.mock("../src/query/compiler/sql-name-registry", async (importOriginal) => {
  const actual = await importOriginal<typeof SqlNameRegistry>();
  return {
    ...actual,
    refuseConflictingSqlNames: (
      ...args: Parameters<typeof actual.refuseConflictingSqlNames>
    ) => {
      if (guard.enabled) actual.refuseConflictingSqlNames(...args);
    },
  };
});

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const knows = defineEdge("knows", { schema: z.object({}) });
const graph = defineGraph({
  id: "sql_identifier_differential",
  nodes: { Person: { type: Person } },
  edges: { knows: { type: knows, from: [Person], to: [Person] } },
});

type DifferentialStore = Store<typeof graph>;

type Engine = Readonly<{
  name: "sqlite" | "pglite";
  store: DifferentialStore;
  aliceId: string;
  bobId: string;
  knowsId: string;
}>;

/** Two 60-character aliases that share their first 59 characters. */
const CLIPPED_TWIN_A = `${"a".repeat(59)}1`;
const CLIPPED_TWIN_B = `${"a".repeat(59)}2`;

const ALIAS_POOL = [
  "p",
  "P",
  "e",
  "E",
  "e_from",
  "E_from",
  "e_to",
  "e_id",
  "item",
  "Item",
  "p_edge",
  "k",
  "K",
  CLIPPED_TWIN_A,
  CLIPPED_TWIN_B,
  `r${"o".repeat(60)}`,
] as const;

const SHAPES = [
  "ids",
  "whole rows",
  "target name",
  "projected name",
  "edge and target",
] as const;
type Shape = (typeof SHAPES)[number];

type Outcome =
  | Readonly<{ kind: "refused"; typed: boolean }>
  | Readonly<{ kind: "failed"; message: string }>
  | Readonly<{ kind: "rows"; rows: readonly unknown[] }>;

type Row = Readonly<{ id: unknown; name?: unknown }>;
type Context = Readonly<Record<string, Row>>;

function idOf(value: unknown): unknown {
  return typeof value === "object" && value !== null ?
      (value as { id?: unknown }).id
    : value;
}

function runQuery(
  engine: Engine,
  [start, edge, target]: readonly [string, string, string],
  shape: Shape,
): Promise<readonly unknown[]> {
  const query = engine.store
    .query()
    .fromDynamic("Person", start as "differential_start")
    .whereNode(start as "differential_start", (person) =>
      person.id.eq(engine.aliceId),
    )
    .traverseDynamic("knows", edge as "differential_edge")
    .toDynamic("Person", target as "differential_target");
  switch (shape) {
    case "ids": {
      return query
        .select((ctx: Context) => ({
          start: requireDefined(ctx[start]).id,
          edge: requireDefined(ctx[edge]).id,
          target: requireDefined(ctx[target]).id,
        }))
        .execute();
    }
    case "whole rows": {
      return query
        .select((ctx: Context) => ({
          start: idOf(requireDefined(ctx[start])),
          startName: requireDefined(ctx[start]).name,
          edge: idOf(requireDefined(ctx[edge])),
          target: idOf(requireDefined(ctx[target])),
          targetName: requireDefined(ctx[target]).name,
        }))
        .execute();
    }
    case "target name": {
      return query
        .select((ctx: Context) => ({ name: requireDefined(ctx[target]).name }))
        .execute();
    }
    case "projected name": {
      return query
        .project(
          (ctx) =>
            ({
              name: requireDefined((ctx as unknown as Context)[target]).name,
            }) as never,
        )
        .execute();
    }
    case "edge and target": {
      return query
        .project(
          (ctx) =>
            ({
              edge: requireDefined((ctx as unknown as Context)[edge]).id,
              name: requireDefined((ctx as unknown as Context)[target]).name,
            }) as never,
        )
        .execute();
    }
  }
}

function expectedRows(engine: Engine, shape: Shape): readonly unknown[] {
  switch (shape) {
    case "ids": {
      return [
        { start: engine.aliceId, edge: engine.knowsId, target: engine.bobId },
      ];
    }
    case "whole rows": {
      return [
        {
          start: engine.aliceId,
          startName: "Alice",
          edge: engine.knowsId,
          target: engine.bobId,
          targetName: "Bob",
        },
      ];
    }
    case "target name":
    case "projected name": {
      return [{ name: "Bob" }];
    }
    case "edge and target": {
      return [{ edge: engine.knowsId, name: "Bob" }];
    }
  }
}

async function outcomeOf(
  run: () => Promise<readonly unknown[]>,
): Promise<Outcome> {
  try {
    return { kind: "rows", rows: await run() };
  } catch (error) {
    if (error instanceof ValidationError)
      return {
        kind: "refused",
        typed: error.details.issues.every(
          (issue) =>
            issue.code === SQL_IDENTIFIER_COLLISION_CODE ||
            issue.code === SQL_IDENTIFIER_TOO_LONG_CODE,
        ),
      };
    return {
      kind: "failed",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function isExactlyRight(
  outcome: Outcome,
  engine: Engine,
  shape: Shape,
): boolean {
  return (
    outcome.kind === "rows" &&
    JSON.stringify(outcome.rows) === JSON.stringify(expectedRows(engine, shape))
  );
}

async function seedEngine(
  name: Engine["name"],
  backend: GraphBackend,
): Promise<Engine> {
  const [store] = await createStoreWithSchema(graph, backend);
  const alice = await store.nodes.Person.create({ name: "Alice" });
  const bob = await store.nodes.Person.create({ name: "Bob" });
  const edge = await store.edges.knows.create(alice, bob, {});
  return {
    name,
    store,
    aliceId: alice.id,
    bobId: bob.id,
    knowsId: edge.id,
  };
}

describe("SQL-name guard against the unguarded compiler on SQLite and PGlite", () => {
  let engines: readonly Engine[] = [];
  let closePglite: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    const pglite = await createLocalPgliteBackend({ vector: false });
    closePglite = () => pglite.backend.close();
    engines = [
      await seedEngine("sqlite", createTestBackend()),
      await seedEngine(
        "pglite",
        createPostgresBackend(pglite.db, { vector: false }),
      ),
    ];
  });

  afterAll(async () => {
    await closePglite?.();
  });

  it("refuses only queries that some engine answers wrongly or fails, and answers the rest exactly", async () => {
    const aliasTriple = fc
      .tuple(
        fc.constantFrom(...ALIAS_POOL),
        fc.constantFrom(...ALIAS_POOL),
        fc.constantFrom(...ALIAS_POOL),
      )
      .filter(
        ([start, edge, target]) =>
          start !== edge && start !== target && edge !== target,
      );
    await fc.assert(
      fc.asyncProperty(
        aliasTriple,
        fc.constantFrom(...SHAPES),
        async (aliases, shape) => {
          guard.enabled = true;
          const guarded = await Promise.all(
            engines.map((engine) =>
              outcomeOf(() => runQuery(engine, aliases, shape)),
            ),
          );
          guard.enabled = false;
          const unguarded = await Promise.all(
            engines.map((engine) =>
              outcomeOf(() => runQuery(engine, aliases, shape)),
            ),
          );
          guard.enabled = true;

          // Typed refusal or exactly the right row, with one verdict.
          for (const [index, engine] of engines.entries()) {
            const outcome = requireDefined(guarded[index]);
            expect({ engine: engine.name, outcome }).toEqual({
              engine: engine.name,
              outcome:
                outcome.kind === "refused" ?
                  { kind: "refused", typed: true }
                : { kind: "rows", rows: expectedRows(engine, shape) },
            });
          }
          expect(new Set(guarded.map((outcome) => outcome.kind)).size).toBe(1);

          // A refusal is justified only by an engine the unguarded statement
          // fails or answers wrongly on.
          const unguardedRightEverywhere = engines.every((engine, index) =>
            isExactlyRight(requireDefined(unguarded[index]), engine, shape),
          );
          expect({
            aliases,
            shape,
            refusedThoughRightUnguarded:
              unguardedRightEverywhere && guarded[0]?.kind === "refused",
          }).toEqual({ aliases, shape, refusedThoughRightUnguarded: false });
        },
      ),
      {
        numRuns: 120,
        seed: 951,
        examples: [
          // An edge `e` beside a target `e_from`: neither `e_from_id` is read.
          [["p", "e", "e_from"], "projected name"],
          [["p", "e", "e_from"], "target name"],
          [["p", "e", "e_from"], "edge and target"],
          [["k", "K", "p"], "ids"],
          [["k", "K", "p"], "whole rows"],
          [["item", "e", "Item"], "projected name"],
        ],
      },
    );
  });
});
