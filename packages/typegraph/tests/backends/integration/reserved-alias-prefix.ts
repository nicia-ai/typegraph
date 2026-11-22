/**
 * The compiler names what it generates in the `__tg` namespace: it renames a
 * subquery's aliases to `__tg_sq_<depth>_a<index>`, and names hidden result
 * columns `__tg_order_<n>`, `__tg_relation_order_<n>` and the like. A caller
 * name spelled like a generated one can meet it, so a caller name starting
 * with `__tg` in any letter case is refused before any SQL is sent.
 */
import { describe, expect, it } from "vitest";

import { expr } from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import type { IntegrationStore } from "./fixtures";
import type { IntegrationTestContext } from "./test-context";

/** The spelling of the subquery's renamed start alias at depth 1. */
const GENERATED_SUBQUERY_ALIAS = "__tg_sq_1_a0";

type Observation =
  | Readonly<{ kind: "rows"; names: readonly string[] }>
  | Readonly<{ kind: "refused"; error: string }>;

async function observe(
  run: () => Promise<readonly string[]>,
): Promise<Observation> {
  try {
    return { kind: "rows", names: [...(await run())].toSorted() };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { kind: "refused", error: error.name };
  }
}

/** The people someone else is older than, read through an outer alias. */
async function peopleWithSomeoneOlder(
  store: IntegrationStore,
  outerAlias: string,
): Promise<readonly string[]> {
  const rows = await store
    .query()
    .from("Person", outerAlias)
    .where((expressions) =>
      expressions.$exists((subquery, outer) =>
        subquery
          .from("Person", "older")
          .where((inner) =>
            expr.gt(inner.older.age, requireDefined(outer[outerAlias]).age),
          )
          .project((inner) => ({ id: inner.older.id })),
      ),
    )
    .project((expressions) => ({
      name: requireDefined(expressions[outerAlias]).name,
    }))
    .execute();
  return rows.map((row) => row.name);
}

export function registerReservedAliasPrefixIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Reserved __tg alias prefix", () => {
    it("refuses an outer alias spelled like a generated subquery alias instead of reading the subquery's own row", async () => {
      const store = context.getStore();
      await store.nodes.Person.create({ name: "Alice", age: 10 });
      await store.nodes.Person.create({ name: "Bob", age: 20 });

      // The same query under an ordinary alias: only Alice has someone older.
      expect(await observe(() => peopleWithSomeoneOlder(store, "p"))).toEqual({
        kind: "rows",
        names: ["Alice"],
      });

      expectObservation({
        lane: { dialect: store.backend.dialect },
        observed: await observe(() =>
          peopleWithSomeoneOlder(store, GENERATED_SUBQUERY_ALIAS),
        ),
        correct: { kind: "refused", error: "ValidationError" },
        defects: [
          {
            // The subquery's own start alias is renamed to the same spelling,
            // so the outer reference reads the subquery's row: `older.age >
            // older.age` holds for no one.
            label: "#975",
            on: {},
            today: { kind: "rows", names: [] },
          },
        ],
      });
    });
  });
}
