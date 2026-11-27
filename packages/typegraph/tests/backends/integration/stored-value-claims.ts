/**
 * A uniqueness claim is keyed from the value the row stores.
 *
 * The one place a row's stored rendering of a value and the rendering a write
 * validated differ is a date: a `Date` is stored as its ISO text. Every other
 * value is stored as the write produced it, so a path that keys a claim from a
 * stored row keys the row's own value — never the value a second pass through
 * the schema would make of it. A schema whose parse does not reproduce its own
 * output (here, a transform that appends `!`) is what tells the two apart:
 * creating `"x"` stores `"x!"` and claims `"x!"`, and re-parsing the stored
 * row would yield `"x!!"`.
 *
 * Each case drives one path that reads a stored row or re-parses whole props
 * and requires the claim relation to hold the key of the value the row now
 * stores.
 *
 * REVERT CHECK: see the report for the revision these cases were classified
 * against. On main's `src` every case below passes; on the revision before
 * this one the update, verbatim-import, resurrection, provenance and scoped
 * get-or-create cases fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type NodeId,
  subClassOf,
} from "../../../src";
import { type GraphBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { FORMAT_VERSION, importGraph } from "../../../src/interchange";
import { createRetractionCapability } from "../../../src/provenance";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { compareStrings } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

/** A unique field whose parse appends `!`, so re-parsing its output moves it. */
const SvcSuffixed = defineNode("SvcSuffixed", {
  schema: z.object({
    code: z.string().transform((value) => `${value}!`),
    note: z.string().optional(),
  }),
});

/**
 * A unique `code` the schema derives from `label` on every parse. A re-parse
 * of either complete row is idempotent, so an update naming only `label`
 * moves the stored code and must move its claim with it.
 */
const SvcLabelled = defineNode("SvcLabelled", {
  schema: z
    .object({ label: z.string(), code: z.string().optional() })
    .overwrite((value) => ({ ...value, code: value.label.toLowerCase() })),
});

/** A date behind `z.lazy`, which stored-date revival cannot see through. */
const SvcLazyEvent = defineNode("SvcLazyEvent", {
  schema: z.object({ name: z.string(), at: z.lazy(() => z.date()) }),
});

/** A scope parent that coerces, and a child that does not. */
const SvcAccount = defineNode("SvcAccount", {
  schema: z.object({ code: z.coerce.string(), note: z.string().optional() }),
});
const SvcPartnerAccount = defineNode("SvcPartnerAccount", {
  schema: z.object({ code: z.string(), note: z.string().optional() }),
});

const SvcSource = defineNode("SvcSource", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});
const SvcJustification = defineNode("SvcJustification", {
  schema: z.object({ label: z.string() }),
});
const svcPremiseOf = defineEdge("svcPremiseOf");
const svcDerives = defineEdge("svcDerives");

/**
 * A scope parent and child whose claim axis (the code-point least kind of the
 * hierarchy) is the CHILD, so a claim at the parent's kind is off the axis.
 */
const SvcVault = defineNode("SvcVault", {
  schema: z.object({ code: z.string() }),
});
const SvcAgentVault = defineNode("SvcAgentVault", {
  schema: z.object({ code: z.string() }),
});
const VAULT_CODE_UNIQUE = {
  name: "SvcVault_code",
  fields: ["code"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

const ACCOUNT_CODE_UNIQUE = {
  name: "SvcAccount_code",
  fields: ["code"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      SvcSuffixed: {
        type: SvcSuffixed,
        unique: [
          {
            name: "SvcSuffixed_code",
            fields: ["code"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      SvcLabelled: {
        type: SvcLabelled,
        unique: [
          {
            name: "SvcLabelled_code",
            fields: ["code"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      SvcLazyEvent: {
        type: SvcLazyEvent,
        unique: [
          {
            name: "SvcLazyEvent_at",
            fields: ["at"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      SvcAccount: { type: SvcAccount, unique: [ACCOUNT_CODE_UNIQUE] },
      SvcVault: { type: SvcVault, unique: [VAULT_CODE_UNIQUE] },
      SvcAgentVault: { type: SvcAgentVault, unique: [VAULT_CODE_UNIQUE] },
      SvcPartnerAccount: {
        type: SvcPartnerAccount,
        unique: [ACCOUNT_CODE_UNIQUE],
      },
      SvcSource: { type: SvcSource },
      SvcJustification: { type: SvcJustification },
    },
    edges: {
      svcPremiseOf: {
        type: svcPremiseOf,
        from: [SvcSource],
        to: [SvcJustification],
      },
      svcDerives: {
        type: svcDerives,
        from: [SvcJustification],
        to: [SvcSuffixed, SvcLazyEvent],
      },
    },
    ontology: [
      subClassOf(SvcPartnerAccount, SvcAccount),
      subClassOf(SvcAgentVault, SvcVault),
    ],
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `stored_value_claims_${graphIdCounter}`;
}

function codeKey(code: string): string {
  return computeUniqueKey({ code }, ["code"], "binary");
}

type LiveClaim = Readonly<{ key: string; node_id: string }>;

/** Every live claim of one constraint, read straight from the claim relation. */
async function liveClaims(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
  constraintName: string,
): Promise<readonly LiveClaim[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<LiveClaim>(
    asCompiledRowsSql(sql`
      SELECT key, node_id
      FROM ${sql.identifier(schema.tables.uniques)}
      WHERE graph_id = ${graphId}
        AND constraint_name = ${constraintName}
        AND deleted_at IS NULL
    `),
  );
  return rows
    .map((row) => ({ key: row.key, node_id: row.node_id }))
    .toSorted((left, right) => compareStrings(left.node_id, right.node_id));
}

/**
 * A child kind holding a claim off its constraint's axis, as a writer from
 * before the axis move left it: under the child's own kind (the axis is the
 * parent), or under the parent's kind (the axis is the child).
 */
const LEGACY_AXIS_SHAPES = [
  {
    name: "under the child's own kind",
    parent: "SvcAccount",
    child: "SvcPartnerAccount",
    legacyAxis: "SvcPartnerAccount",
    constraintName: "SvcAccount_code",
  },
  {
    name: "under the parent's kind",
    parent: "SvcVault",
    child: "SvcAgentVault",
    legacyAxis: "SvcVault",
    constraintName: "SvcVault_code",
  },
] as const;

/** A call's result, or the name of the error it threw. */
async function outcomeOf<T>(call: () => Promise<T>): Promise<T | string> {
  try {
    return await call();
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

/** Whether a write was refused, by error name, or completed. */
async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "written";
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

export function registerStoredValueClaimIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a uniqueness claim is keyed from the value the row stores", () => {
    it("a patch to another field moves the claim of a unique field its re-parse rewrites", async () => {
      const graphId = nextGraphId();
      const store = await context.createStore(buildGraph(graphId));
      await store.nodes.SvcSuffixed.create(
        { code: "x", note: "a" },
        { id: "row" },
      );

      const updated = await store.nodes.SvcSuffixed.update(
        "row" as NodeId<typeof SvcSuffixed>,
        { note: "b" },
      );

      expect({
        stored: updated.code,
        claims: await liveClaims(store.backend, graphId, "SvcSuffixed_code"),
        // `"x!"` parses to `"x!!"`, the value the row now stores.
        duplicate: await outcome(() =>
          store.nodes.SvcSuffixed.create({ code: "x!" }),
        ),
      }).toEqual({
        stored: "x!!",
        claims: [{ key: codeKey("x!!"), node_id: "row" }],
        duplicate: "UniquenessError",
      });
    });

    for (const inTransaction of [false, true]) {
      it(`an update naming only the field a unique code derives from moves the claim${inTransaction ? " inside a transaction" : ""}`, async () => {
        const graphId = nextGraphId();
        const store = await context.createStore(buildGraph(graphId));
        type LabelledId = NodeId<typeof SvcLabelled>;
        await store.nodes.SvcLabelled.create({ label: "A" }, { id: "row" });

        const updated =
          inTransaction ?
            await store.transaction((tx) =>
              tx.nodes.SvcLabelled.update("row" as LabelledId, { label: "B" }),
            )
          : await store.nodes.SvcLabelled.update("row" as LabelledId, {
              label: "B",
            });

        expect({
          stored: updated.code,
          claims: await liveClaims(store.backend, graphId, "SvcLabelled_code"),
          // The stored code moved from `a` to `b`: `b` is held, `a` is free.
          duplicateOfNew: await outcome(() =>
            store.nodes.SvcLabelled.create({ label: "b" }),
          ),
          createOfOld: await outcome(() =>
            store.nodes.SvcLabelled.create({ label: "a" }, { id: "taker" }),
          ),
        }).toEqual({
          stored: "b",
          claims: [{ key: codeKey("b"), node_id: "row" }],
          duplicateOfNew: "UniquenessError",
          createOfOld: "written",
        });
      });
    }

    it("an import under onUnknownProperty allow claims the value it writes", async () => {
      const graphId = nextGraphId();
      const store = await context.createStore(buildGraph(graphId));
      // Stores and claims `"x!"`.
      await store.nodes.SvcSuffixed.create({ code: "x" }, { id: "first" });

      const imported = await importGraph(
        store,
        {
          formatVersion: FORMAT_VERSION,
          exportedAt: new Date().toISOString(),
          source: { type: "external", description: "verbatim import" },
          nodes: [
            {
              kind: "SvcSuffixed",
              id: "second",
              // Written verbatim: the row stores `"x!"`, the first row's value.
              properties: { code: "x!", legacyNote: "kept" },
            },
          ],
          edges: [],
        },
        { onConflict: "error", onUnknownProperty: "allow" },
      );

      expect({
        refused: imported.errors.map((error) => error.id),
        claims: await liveClaims(store.backend, graphId, "SvcSuffixed_code"),
      }).toEqual({
        refused: ["second"],
        claims: [{ key: codeKey("x!"), node_id: "first" }],
      });
    });

    it("getOrCreateByConstraint resurrects a tombstone keyed from its stored value", async () => {
      const graphId = nextGraphId();
      const store = await context.createStore(buildGraph(graphId));
      await store.nodes.SvcSuffixed.create({ code: "x" }, { id: "row" });
      await store.nodes.SvcSuffixed.delete("row" as NodeId<typeof SvcSuffixed>);

      // `"x"` keys as `"x!"`, the released claim the tombstone still holds.
      const result = await store.nodes.SvcSuffixed.getOrCreateByConstraint(
        "SvcSuffixed_code",
        { code: "x" },
      );

      expect({ action: result.action, id: result.node.id }).toEqual({
        action: "resurrected",
        id: "row",
      });
      // The resurrection leg hands the row the props the lookup validated,
      // which the update parses again as input: `"x!"` becomes `"x!!"`. The
      // same on main.
      expectObservation({
        lane: { driver: context.driver },
        observed: {
          stored: result.node.code,
          claims: await liveClaims(store.backend, graphId, "SvcSuffixed_code"),
        },
        correct: {
          stored: "x!",
          claims: [{ key: codeKey("x!"), node_id: "row" }],
        },
        defects: [
          {
            label: "get-or-create update re-validates validated props",
            on: {},
            today: {
              stored: "x!!",
              claims: [{ key: codeKey("x!!"), node_id: "row" }],
            },
          },
        ],
      });
    });

    it("getOrCreateByConstraint reads a tombstone holding a date under z.lazy without failing", async () => {
      const graphId = nextGraphId();
      const store = await context.createStore(buildGraph(graphId));
      const at = new Date("2024-01-01T00:00:00.000Z");
      await store.nodes.SvcLazyEvent.create({ name: "row", at }, { id: "row" });
      await store.nodes.SvcLazyEvent.delete(
        "row" as NodeId<typeof SvcLazyEvent>,
      );

      const result = await store.nodes.SvcLazyEvent.getOrCreateByConstraint(
        "SvcLazyEvent_at",
        { name: "again", at },
      );

      // Revival cannot see through `z.lazy`, so the tombstone's stored text
      // keys differently from the `Date` a create claimed, and the lookup
      // finds no node holding the released claim. (Main resurrects here only
      // because its delete left the claim live.)
      expectObservation({
        lane: { driver: context.driver },
        observed: result.action,
        correct: "resurrected",
        defects: [
          {
            label: "date under z.lazy keyed from stored text",
            on: {},
            today: "created",
          },
        ],
      });
    });

    for (const kind of ["SvcSuffixed", "SvcLazyEvent"] as const) {
      it(`a ${kind} fact reopened by provenance holds the claim of its stored value`, async () => {
        const graphId = nextGraphId();
        const store = await context.createHistoryStore(buildGraph(graphId));
        const source = await store.nodes.SvcSource.create(
          { label: "source", retracted: false },
          { id: "source" },
        );
        const fact =
          kind === "SvcSuffixed" ?
            await store.nodes.SvcSuffixed.create({ code: "x" }, { id: "fact" })
          : await store.nodes.SvcLazyEvent.create(
              { name: "fact", at: new Date("2024-01-01T00:00:00.000Z") },
              { id: "fact" },
            );
        const justification = await store.nodes.SvcJustification.create(
          { label: "justification" },
          { id: "justification" },
        );
        await store.edges.svcPremiseOf.create(source, justification, {});
        await store.edges.svcDerives.create(justification, fact, {});
        const constraintName = `${kind}_${kind === "SvcSuffixed" ? "code" : "at"}`;
        const before = await liveClaims(store.backend, graphId, constraintName);
        const provenance = createRetractionCapability(store, {
          source: { kind: "SvcSource" },
          justification: { kind: "SvcJustification" },
          fact: { kinds: [kind] },
          premiseOf: { kind: "svcPremiseOf" },
          derives: { kind: "svcDerives" },
        });

        await provenance.retract(source);
        const reopened = await outcome(() => provenance.unRetract(source));

        expect(reopened).toBe("written");
        // A date under `z.lazy` keys from its stored text, which revival does
        // not reach; the reopen does not fail on it, and claims that text.
        expectObservation({
          lane: { driver: context.driver, kind },
          observed: await liveClaims(store.backend, graphId, constraintName),
          correct: before,
          defects: [
            {
              label: "date under z.lazy keyed from stored text",
              on: { kind: ["SvcLazyEvent"] },
              today: [{ key: "2024-01-01T00:00:00.000Z", node_id: "fact" }],
            },
          ],
        });
      });
    }

    for (const bulk of [false, true]) {
      it(`a scoped ${bulk ? "bulkGetOrCreateByConstraint" : "getOrCreateByConstraint"} update hands the matched child kind the validated value`, async () => {
        const store = await context.createStore(buildGraph(nextGraphId()));
        await store.nodes.SvcPartnerAccount.create(
          { code: "123" },
          { id: "partner" },
        );

        // The parent coerces `123` to `"123"`, the child's key.
        const results =
          bulk ?
            await store.nodes.SvcAccount.bulkGetOrCreateByConstraint(
              "SvcAccount_code",
              [
                {
                  props: {
                    code: 123,
                    note: "matched",
                  },
                },
              ],
              { ifExists: "update" },
            )
          : [];
        const result =
          bulk ?
            requireDefined(results[0])
          : await store.nodes.SvcAccount.getOrCreateByConstraint(
              "SvcAccount_code",
              { code: 123, note: "matched" },
              { ifExists: "update" },
            );

        expect({
          action: result.action,
          kind: result.node.kind,
          id: result.node.id,
          note: result.node.note,
        }).toEqual({
          action: "updated",
          kind: "SvcPartnerAccount",
          id: "partner",
          note: "matched",
        });
      });
    }
    // A claim written before the axis move sits under its owner's own concrete
    // kind. A child whose update moves its code onto a key it holds there is
    // probed as already holding it, so the update claims nothing new and its
    // release keeps the legacy row. A parent create of the same key later in
    // the same import slice must be refused for that row alone, not fail the
    // import's flush and roll the child's update back.
    for (const shape of LEGACY_AXIS_SHAPES) {
      it(`an import update onto a key its node holds at a legacy axis (${shape.name}) keeps a later create of that key from aborting the import`, async () => {
        const graphId = nextGraphId();
        const store = await context.createStore(buildGraph(graphId));
        await store.nodes[shape.child].create({ code: "j" }, { id: "child" });
        await store.backend.insertUnique({
          graphId,
          nodeKind: shape.legacyAxis,
          constraintName: shape.constraintName,
          key: codeKey("k"),
          nodeId: "child",
          concreteKind: shape.child,
        });

        const imported = await outcomeOf(() =>
          importGraph(
            store,
            {
              formatVersion: FORMAT_VERSION,
              exportedAt: new Date().toISOString(),
              source: { type: "external", description: "legacy axis" },
              nodes: [
                { kind: shape.child, id: "child", properties: { code: "k" } },
                { kind: shape.parent, id: "parent", properties: { code: "k" } },
              ],
              edges: [],
            },
            { onConflict: "update", onUnknownProperty: "error" },
          ),
        );
        const child = await store.nodes[shape.child].getById("child" as never);

        expect({
          import:
            typeof imported === "string" ? imported : (
              imported.errors.map((error) => error.id)
            ),
          childCode: child?.code,
        }).toEqual({ import: ["parent"], childCode: "k" });
      });
    }
  });
}
