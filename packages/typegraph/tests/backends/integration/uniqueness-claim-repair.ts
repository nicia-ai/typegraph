/**
 * The upgrade path for uniqueness claims whose key moved: detect them with
 * `store.verifyConstraintFences()`, repair them with
 * `store.repairUniquenessClaims()`, on every backend.
 *
 * Every fixture writes the claim rows an earlier release left behind directly
 * through the backend: an object value from a fixed-literal `.default()`
 * claimed in its literal's key order rather than the schema's, and a date
 * claimed under its unquoted ISO text, the form an earlier import wrote. Both
 * hold the value under a key no create derives, so neither fences a create of
 * the same value, and no update of the holder moves the fixed-literal key.
 *
 * Each case asserts what survived the repair: the node row (version, validity
 * window, timestamps), its edges, the claim rows (live and released), the
 * recorded clock of a history store, and what a create and a get-or-create of
 * the value do afterwards.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  type GraphBackend,
  type NodeId,
} from "../../../src";
import { computeUniqueKey } from "../../../src/constraints";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import { asCompiledRowsSql } from "../../../src/query/sql-intent";
import { compareStrings } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const UcrFixed = defineNode("UcrFixed", {
  schema: z.object({
    name: z.string(),
    v: z
      .object({ zeta: z.literal("z"), a: z.literal("a") })
      .default({ a: "a", zeta: "z" }),
  }),
});
const UcrDate = defineNode("UcrDate", {
  schema: z.object({ name: z.string(), at: z.date() }),
});
const UcrTag = defineNode("UcrTag", {
  schema: z.object({ label: z.string() }),
});
const ucrTagged = defineEdge("ucrTagged", {
  schema: z.object({ note: z.string() }),
});

const FIXED_CONSTRAINT = "UcrFixed_v";
const DATE_CONSTRAINT = "UcrDate_at";

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      UcrFixed: {
        type: UcrFixed,
        unique: [
          {
            name: FIXED_CONSTRAINT,
            fields: ["v"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      UcrDate: {
        type: UcrDate,
        unique: [
          {
            name: DATE_CONSTRAINT,
            fields: ["at"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      UcrTag: { type: UcrTag },
    },
    edges: {
      ucrTagged: { type: ucrTagged, from: [UcrFixed], to: [UcrTag] },
    },
  });
}

let graphIdCounter = 0;
function nextGraphId(): string {
  graphIdCounter += 1;
  return `uniqueness_claim_repair_${graphIdCounter}`;
}

const AT = "2024-03-04T05:06:07.000Z";

/** The key a create of the fixed-literal default claims: the shape's order. */
const SHAPE_KEY = `{"zeta":"z","a":"a"}`;
/** The key an earlier release claimed it under: the literal's order. */
const LITERAL_KEY = computeUniqueKey(
  { v: { a: "a", zeta: "z" } },
  ["v"],
  "binary",
);
/** The key a create of the date claims: its JSON-quoted ISO text. */
const DATE_KEY = `"${AT}"`;
/** The key an earlier import claimed it under: the unquoted ISO text. */
const RAW_DATE_KEY = AT;

type ClaimRow = Readonly<{ key: string; node_id: string; released: boolean }>;

/** Every claim row of one constraint, live and released. */
async function claimRows(
  backend: Pick<GraphBackend, "execute" | "tableNames">,
  graphId: string,
  constraintName: string,
): Promise<readonly ClaimRow[]> {
  const schema = createSqlSchema(backend.tableNames);
  const rows = await backend.execute<
    Readonly<{ key: string; node_id: string; released: number | string }>
  >(
    asCompiledRowsSql(sql`
      SELECT key, node_id,
        CASE WHEN deleted_at IS NULL THEN 0 ELSE 1 END AS released
      FROM ${sql.identifier(schema.tables.uniques)}
      WHERE graph_id = ${graphId}
        AND constraint_name = ${constraintName}
    `),
  );
  return rows
    .map((row) => ({
      key: row.key,
      node_id: row.node_id,
      released: Number(row.released) === 1,
    }))
    .toSorted(
      (left, right) =>
        compareStrings(left.node_id, right.node_id) ||
        compareStrings(left.key, right.key),
    );
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

type ClaimFormBackend = Pick<
  GraphBackend,
  "insertUnique" | "deleteUnique" | "hardDeleteUniquesByNodeIds"
>;

/**
 * Rewrites a node's claim into the form an earlier release left it in: the
 * claim this release wrote is removed outright, as if never taken, and the
 * old-form claim is taken in its place, released too when the holder is.
 */
async function writeOldFormClaim(
  backend: ClaimFormBackend,
  claim: Readonly<{
    graphId: string;
    kind: string;
    nodeId: string;
    constraintName: string;
    key: string;
    released: boolean;
  }>,
): Promise<void> {
  const hardDelete = requireDefined(backend.hardDeleteUniquesByNodeIds);
  await hardDelete({
    graphId: claim.graphId,
    concreteKind: claim.kind,
    nodeIds: [claim.nodeId],
  });
  const row = {
    graphId: claim.graphId,
    nodeKind: claim.kind,
    constraintName: claim.constraintName,
    key: claim.key,
    nodeId: claim.nodeId,
    concreteKind: claim.kind,
  };
  await backend.insertUnique(row);
  if (claim.released) await backend.deleteUnique(row);
}

/** A gate a test opens once, and the promise that waits on it. */
function gate(): Readonly<{ open: () => void; opened: Promise<void> }> {
  let open: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

/** Waits until some session of the server waits on a lock another holds. */
async function untilASessionWaits(
  backend: Pick<GraphBackend, "execute">,
): Promise<number> {
  const waiting = async (): Promise<number> => {
    const rows = await backend.execute<Readonly<{ waiting: number | string }>>(
      asCompiledRowsSql(
        sql`SELECT count(*) AS waiting FROM pg_locks WHERE NOT granted`,
      ),
    );
    return Number(rows[0]?.waiting ?? 0);
  };
  const deadline = Date.now() + 10_000;
  while ((await waiting()) === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return waiting();
}

/** Cross-backend upgrade path for claims keyed in another form. */
export function registerUniquenessClaimRepairIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("uniqueness claim repair", () => {
    it("re-keys a live holder's claims in place, leaving its row, edges and history as they were", async () => {
      const store = await context.createHistoryStore(buildGraph(nextGraphId()));
      const graphId = store.graphId;
      const holderId = "holder" as NodeId<typeof UcrFixed>;
      const holder = await store.nodes.UcrFixed.create(
        { name: "holder" },
        { id: holderId },
      );
      const tag = await store.nodes.UcrTag.create({ label: "tag" });
      const edge = await store.edges.ucrTagged.create(holder, tag, {
        note: "kept",
      });
      const dated = await store.nodes.UcrDate.create(
        { name: "dated", at: new Date(AT) },
        { id: "dated" },
      );
      await writeOldFormClaim(store.backend, {
        graphId,
        kind: "UcrFixed",
        nodeId: holder.id,
        constraintName: FIXED_CONSTRAINT,
        key: LITERAL_KEY,
        released: false,
      });
      await writeOldFormClaim(store.backend, {
        graphId,
        kind: "UcrDate",
        nodeId: dated.id,
        constraintName: DATE_CONSTRAINT,
        key: RAW_DATE_KEY,
        released: false,
      });

      const rowBefore = await store.backend.getNode(
        graphId,
        "UcrFixed",
        holder.id,
      );
      const edgeBefore = await store.backend.getEdge(graphId, edge.id);
      const clockBefore = await store.recordedNow();

      const findings = [
        {
          family: "nodeUniquenessClaimMissing",
          target: {
            relation: "uniques",
            graphId,
            axis: "UcrDate",
            constraintName: DATE_CONSTRAINT,
            key: DATE_KEY,
          },
          owner: { concreteKind: "UcrDate", nodeId: "dated" },
          released: false,
        },
        {
          family: "nodeUniquenessClaimStale",
          target: {
            relation: "uniques",
            graphId,
            axis: "UcrDate",
            constraintName: DATE_CONSTRAINT,
            key: RAW_DATE_KEY,
          },
          owner: { concreteKind: "UcrDate", nodeId: "dated" },
          expectedKey: DATE_KEY,
        },
        {
          family: "nodeUniquenessClaimStale",
          target: {
            relation: "uniques",
            graphId,
            axis: "UcrFixed",
            constraintName: FIXED_CONSTRAINT,
            key: LITERAL_KEY,
          },
          owner: { concreteKind: "UcrFixed", nodeId: "holder" },
          expectedKey: SHAPE_KEY,
        },
        {
          family: "nodeUniquenessClaimMissing",
          target: {
            relation: "uniques",
            graphId,
            axis: "UcrFixed",
            constraintName: FIXED_CONSTRAINT,
            key: SHAPE_KEY,
          },
          owner: { concreteKind: "UcrFixed", nodeId: "holder" },
          released: false,
        },
      ];
      expect(await store.verifyConstraintFences()).toEqual(findings);

      // Dry run by default: the plan, and nothing written.
      expect(await store.repairUniquenessClaims()).toEqual({
        dryRun: true,
        repaired: findings,
        duplicates: [],
        blocked: [],
      });
      expect(await claimRows(store.backend, graphId, FIXED_CONSTRAINT)).toEqual(
        [{ key: LITERAL_KEY, node_id: "holder", released: false }],
      );

      expect(await store.repairUniquenessClaims({ dryRun: false })).toEqual({
        dryRun: false,
        repaired: findings,
        duplicates: [],
        blocked: [],
      });

      expect({
        fixed: await claimRows(store.backend, graphId, FIXED_CONSTRAINT),
        date: await claimRows(store.backend, graphId, DATE_CONSTRAINT),
        row: await store.backend.getNode(graphId, "UcrFixed", holder.id),
        edge: await store.backend.getEdge(graphId, edge.id),
        clock: await store.recordedNow(),
        report: await store.verifyConstraintFences(),
        again: await store.repairUniquenessClaims({ dryRun: false }),
      }).toEqual({
        // The old-form claim is released, not left reserving its bytes.
        fixed: [
          { key: LITERAL_KEY, node_id: "holder", released: true },
          { key: SHAPE_KEY, node_id: "holder", released: false },
        ],
        date: [
          { key: DATE_KEY, node_id: "dated", released: false },
          { key: RAW_DATE_KEY, node_id: "dated", released: true },
        ],
        row: rowBefore,
        edge: edgeBefore,
        clock: clockBefore,
        report: [],
        again: { dryRun: false, repaired: [], duplicates: [], blocked: [] },
      });
      // The old key reserves nothing: another owner can take those bytes.
      expect(
        await outcome(() =>
          store.backend.insertUnique({
            graphId,
            nodeKind: "UcrFixed",
            constraintName: FIXED_CONSTRAINT,
            key: LITERAL_KEY,
            nodeId: "unrelated",
            concreteKind: "UcrFixed",
          }),
        ),
      ).toBe("written");
      // The re-keyed claims fence a create of each value.
      expect({
        fixed: await outcome(() =>
          store.nodes.UcrFixed.create({ name: "duplicate" }),
        ),
        date: await outcome(() =>
          store.nodes.UcrDate.create({ name: "duplicate", at: new Date(AT) }),
        ),
      }).toEqual({ fixed: "UniquenessError", date: "UniquenessError" });
    });

    it("re-keys a soft-deleted holder's released claim so get-or-create resurrects it", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const graphId = store.graphId;
      const holderId = "holder" as NodeId<typeof UcrFixed>;
      await store.nodes.UcrFixed.create({ name: "holder" }, { id: holderId });
      await store.nodes.UcrFixed.delete(holderId);
      await writeOldFormClaim(store.backend, {
        graphId,
        kind: "UcrFixed",
        nodeId: holderId,
        constraintName: FIXED_CONSTRAINT,
        key: LITERAL_KEY,
        released: true,
      });

      const finding = {
        family: "nodeUniquenessClaimMissing",
        target: {
          relation: "uniques",
          graphId,
          axis: "UcrFixed",
          constraintName: FIXED_CONSTRAINT,
          key: SHAPE_KEY,
        },
        owner: { concreteKind: "UcrFixed", nodeId: "holder" },
        released: true,
      };
      expect(await store.verifyConstraintFences()).toEqual([finding]);
      expect(await store.repairUniquenessClaims({ dryRun: false })).toEqual({
        dryRun: false,
        repaired: [finding],
        duplicates: [],
        blocked: [],
      });
      expect(await claimRows(store.backend, graphId, FIXED_CONSTRAINT)).toEqual(
        [
          { key: LITERAL_KEY, node_id: "holder", released: true },
          { key: SHAPE_KEY, node_id: "holder", released: true },
        ],
      );
      expect(await store.verifyConstraintFences()).toEqual([]);

      const result = await store.nodes.UcrFixed.getOrCreateByConstraint(
        FIXED_CONSTRAINT,
        { name: "again" },
      );
      expect({
        action: result.action,
        id: result.node.id,
        claims: await claimRows(store.backend, graphId, FIXED_CONSTRAINT),
      }).toEqual({
        action: "resurrected",
        id: "holder",
        claims: [
          { key: LITERAL_KEY, node_id: "holder", released: true },
          { key: SHAPE_KEY, node_id: "holder", released: false },
        ],
      });
    });

    it("reports a duplicate the old claim let in and changes no claim of its constraint until it is resolved", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const graphId = store.graphId;
      const holderId = "holder" as NodeId<typeof UcrFixed>;
      await store.nodes.UcrFixed.create({ name: "holder" }, { id: holderId });
      await writeOldFormClaim(store.backend, {
        graphId,
        kind: "UcrFixed",
        nodeId: holderId,
        constraintName: FIXED_CONSTRAINT,
        key: LITERAL_KEY,
        released: false,
      });
      const dated = await store.nodes.UcrDate.create(
        { name: "dated", at: new Date(AT) },
        { id: "dated" },
      );
      await writeOldFormClaim(store.backend, {
        graphId,
        kind: "UcrDate",
        nodeId: dated.id,
        constraintName: DATE_CONSTRAINT,
        key: RAW_DATE_KEY,
        released: false,
      });
      // The old-form claim fences nothing, so a create of the value is let in.
      const duplicate = await store.nodes.UcrFixed.create(
        { name: "duplicate" },
        { id: "duplicate" },
      );
      const fixedBefore = await claimRows(
        store.backend,
        graphId,
        FIXED_CONSTRAINT,
      );
      expect(fixedBefore).toEqual([
        { key: SHAPE_KEY, node_id: "duplicate", released: false },
        { key: LITERAL_KEY, node_id: "holder", released: false },
      ]);

      const duplicateViolation = {
        family: "nodeUniqueness",
        target: {
          relation: "uniques",
          graphId,
          axis: "UcrFixed",
          constraintName: FIXED_CONSTRAINT,
          key: SHAPE_KEY,
        },
        owners: [
          { concreteKind: "UcrFixed", nodeId: "duplicate" },
          { concreteKind: "UcrFixed", nodeId: "holder" },
        ],
      };
      const staleFinding = {
        family: "nodeUniquenessClaimStale",
        target: { ...duplicateViolation.target, key: LITERAL_KEY },
        owner: { concreteKind: "UcrFixed", nodeId: "holder" },
        expectedKey: SHAPE_KEY,
      };
      const missingFinding = {
        family: "nodeUniquenessClaimMissing",
        target: duplicateViolation.target,
        owner: { concreteKind: "UcrFixed", nodeId: "holder" },
        released: false,
      };
      const holderFindings = [staleFinding, missingFinding];
      const dateFindings = [
        {
          family: "nodeUniquenessClaimMissing",
          target: {
            relation: "uniques",
            graphId,
            axis: "UcrDate",
            constraintName: DATE_CONSTRAINT,
            key: DATE_KEY,
          },
          owner: { concreteKind: "UcrDate", nodeId: "dated" },
          released: false,
        },
        {
          family: "nodeUniquenessClaimStale",
          target: {
            relation: "uniques",
            graphId,
            axis: "UcrDate",
            constraintName: DATE_CONSTRAINT,
            key: RAW_DATE_KEY,
          },
          owner: { concreteKind: "UcrDate", nodeId: "dated" },
          expectedKey: DATE_KEY,
        },
      ];
      expect(await store.verifyConstraintFences()).toEqual([
        ...dateFindings,
        staleFinding,
        duplicateViolation,
        missingFinding,
      ]);

      // The constraint carrying the duplicate is left alone; another is not.
      expect(await store.repairUniquenessClaims({ dryRun: false })).toEqual({
        dryRun: false,
        repaired: dateFindings,
        duplicates: [duplicateViolation],
        blocked: holderFindings,
      });
      expect({
        fixed: await claimRows(store.backend, graphId, FIXED_CONSTRAINT),
        date: await claimRows(store.backend, graphId, DATE_CONSTRAINT),
      }).toEqual({
        fixed: fixedBefore,
        date: [
          { key: DATE_KEY, node_id: "dated", released: false },
          { key: RAW_DATE_KEY, node_id: "dated", released: true },
        ],
      });

      // The operator resolves the duplicate; the next run repairs.
      await store.nodes.UcrFixed.hardDelete(duplicate.id);
      expect(await store.repairUniquenessClaims({ dryRun: false })).toEqual({
        dryRun: false,
        repaired: holderFindings,
        duplicates: [],
        blocked: [],
      });
      expect({
        fixed: await claimRows(store.backend, graphId, FIXED_CONSTRAINT),
        report: await store.verifyConstraintFences(),
        create: await outcome(() =>
          store.nodes.UcrFixed.create({ name: "duplicate" }),
        ),
      }).toEqual({
        fixed: [
          { key: LITERAL_KEY, node_id: "holder", released: true },
          { key: SHAPE_KEY, node_id: "holder", released: false },
        ],
        report: [],
        create: "UniquenessError",
      });
    });

    it("leaves one fence whichever of a repair and a concurrent create of the value goes first", async () => {
      const store = await context.createStore(buildGraph(nextGraphId()));
      const graphId = store.graphId;
      const holderId = "holder" as NodeId<typeof UcrFixed>;
      await store.nodes.UcrFixed.create({ name: "holder" }, { id: holderId });
      await writeOldFormClaim(store.backend, {
        graphId,
        kind: "UcrFixed",
        nodeId: holderId,
        constraintName: FIXED_CONSTRAINT,
        key: LITERAL_KEY,
        released: false,
      });

      const [repair, create] = await Promise.allSettled([
        store.repairUniquenessClaims({ dryRun: false }),
        store.nodes.UcrFixed.create({ name: "racer" }, { id: "racer" }),
      ]);
      const live = (
        await claimRows(store.backend, graphId, FIXED_CONSTRAINT)
      ).filter((row) => !row.released);
      const racer = await store.nodes.UcrFixed.getById(
        "racer" as NodeId<typeof UcrFixed>,
      );

      if (racer === undefined) {
        // The repair went first: the holder holds the value's key, and the
        // create was refused by it.
        expect({
          repair: repair.status,
          create:
            create.status === "rejected" ?
              (create.reason as Error).name
            : "written",
          live,
        }).toEqual({
          repair: "fulfilled",
          create: "UniquenessError",
          live: [{ key: SHAPE_KEY, node_id: "holder", released: false }],
        });
      } else {
        // The create went first: the old claim let it in, and the repair
        // either reported the duplicate or was refused by the racer's claim.
        // Either way it changed no claim, and the report names both holders.
        expect(live).toEqual([
          { key: LITERAL_KEY, node_id: "holder", released: false },
          { key: SHAPE_KEY, node_id: "racer", released: false },
        ]);
        expect(
          repair.status === "rejected" ?
            (repair.reason as Error).name
          : repair.value.duplicates.map((violation) => violation.family),
        ).toSatisfy(
          (value) =>
            value === "UniquenessError" ||
            (Array.isArray(value) && value[0] === "nodeUniqueness"),
        );
        const report = await store.verifyConstraintFences();
        expect(report.map((violation) => violation.family)).toContain(
          "nodeUniqueness",
        );
      }
    });

    it.skipIf(!context.serverLaneConcurrency)(
      "is refused, and writes nothing, when a concurrent create takes the value's key while it runs",
      async () => {
        const store = await context.createStore(buildGraph(nextGraphId()));
        const graphId = store.graphId;
        const holderId = "holder" as NodeId<typeof UcrFixed>;
        await store.nodes.UcrFixed.create({ name: "holder" }, { id: holderId });
        await writeOldFormClaim(store.backend, {
          graphId,
          kind: "UcrFixed",
          nodeId: holderId,
          constraintName: FIXED_CONSTRAINT,
          key: LITERAL_KEY,
          released: false,
        });

        const held = gate();
        const claimed = gate();
        // A create that has taken the value's key and not yet committed.
        const create = store.transaction(async (tx) => {
          await tx.nodes.UcrFixed.create({ name: "racer" }, { id: "racer" });
          claimed.open();
          await held.opened;
        });
        await claimed.opened;

        const repair = store.repairUniquenessClaims({ dryRun: false }).then(
          () => "fulfilled",
          (error: unknown) => (error as Error).name,
        );
        // Wait until the repair's claim of the key waits on the create's.
        expect(await untilASessionWaits(store.backend)).toBeGreaterThan(0);
        held.open();
        await create;

        expect({
          repair: await repair,
          claims: await claimRows(store.backend, graphId, FIXED_CONSTRAINT),
        }).toEqual({
          repair: "UniquenessError",
          claims: [
            { key: LITERAL_KEY, node_id: "holder", released: false },
            { key: SHAPE_KEY, node_id: "racer", released: false },
          ],
        });
        expect(
          (await store.verifyConstraintFences()).map(
            (violation) => violation.family,
          ),
        ).toContain("nodeUniqueness");
      },
    );

    it.skipIf(!context.serverLaneConcurrency)(
      "is refused, and writes nothing, when a holder it audited is updated before it locks the holder",
      async () => {
        const store = await context.createStore(buildGraph(nextGraphId()));
        const graphId = store.graphId;
        const dated = await store.nodes.UcrDate.create(
          { name: "dated", at: new Date(AT) },
          { id: "dated" },
        );
        await writeOldFormClaim(store.backend, {
          graphId,
          kind: "UcrDate",
          nodeId: dated.id,
          constraintName: DATE_CONSTRAINT,
          key: RAW_DATE_KEY,
          released: false,
        });

        const held = gate();
        const updated = gate();
        // An update moving the holder's value, holding its row lock.
        const update = store.transaction(async (tx) => {
          await tx.nodes.UcrDate.update(dated.id, {
            at: new Date("2025-01-02T03:04:05.000Z"),
          });
          updated.open();
          await held.opened;
        });
        await updated.opened;

        const repair = store.repairUniquenessClaims({ dryRun: false }).then(
          () => "fulfilled",
          (error: unknown) =>
            error instanceof Error && "details" in error ?
              (error.details as Readonly<{ code?: string }>).code
            : String(error),
        );
        // Wait until the repair's lock of the holder waits on the update's.
        expect(await untilASessionWaits(store.backend)).toBeGreaterThan(0);
        held.open();
        await update;

        // The update re-keyed the holder itself; the repair, whose first
        // audit predates it, wrote nothing.
        expect({
          repair: await repair,
          claims: await claimRows(store.backend, graphId, DATE_CONSTRAINT),
          report: await store.verifyConstraintFences(),
        }).toEqual({
          repair: "UNIQUENESS_CLAIM_REPAIR_CONCURRENT_WRITE",
          claims: [
            {
              key: `"2025-01-02T03:04:05.000Z"`,
              node_id: "dated",
              released: false,
            },
            { key: RAW_DATE_KEY, node_id: "dated", released: true },
          ],
          report: [],
        });
      },
    );
  });
}
