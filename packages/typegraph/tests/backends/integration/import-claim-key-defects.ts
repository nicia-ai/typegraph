/**
 * Two uniqueness-key defects an import exposes, pinned as known defects.
 *
 * A uniqueness claim is keyed by the value a write states. Both defects are a
 * claim keyed from one form of a value and looked up or released from
 * another, and both are owned by the change that gives the uniqueness key one
 * owner; it flips these markers.
 *
 *  - An object-valued unique property imported under
 *    `onUnknownProperty: "allow"` persists the document's object verbatim.
 *    PostgreSQL's JSONB returns an object's keys sorted (shorter first), not
 *    in schema order, so the exported object's key order differs from the
 *    order a create states, and the imported claim does not collide with a
 *    create of the same value: two rows hold one unique value. No date is
 *    involved, and it reproduces on main.
 *  - A claim over a date is taken from the `Date` a write states but released
 *    from the row's stored text, so a write that replaces a unique date
 *    (an import under `onConflict: "update"`, `update()`) or deletes the row
 *    leaves the old date reserved.
 */
import { describe, it } from "vitest";
import { z } from "zod";

import { asNodeId, defineGraph, defineNode } from "../../../src";
import {
  exportGraph,
  type GraphData,
  importGraph,
} from "../../../src/interchange";
import { expectObservation } from "../../helpers/known-defect";
import { type IntegrationTestContext } from "./test-context";

const Badge = defineNode("ClaimKeyBadge", {
  schema: z.object({
    // Declared longest key first: PostgreSQL's JSONB stores `a` first.
    code: z.object({ zeta: z.string(), a: z.string() }),
  }),
});

const DatedSlot = defineNode("ClaimKeyDatedSlot", {
  schema: z.object({ title: z.string(), at: z.date() }),
});

function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      ClaimKeyBadge: {
        type: Badge,
        unique: [
          {
            name: "claim_key_badge_code",
            fields: ["code"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      ClaimKeyDatedSlot: {
        type: DatedSlot,
        unique: [
          {
            name: "claim_key_dated_slot_at",
            fields: ["at"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: {},
  });
}

const FIRST = new Date("2024-01-02T03:04:05.678Z");
const SECOND = new Date("2024-05-06T07:08:09.012Z");
const THIRD = new Date("2024-09-10T11:12:13.141Z");

/** Whether a write was refused, by error name, or completed. */
async function outcome(write: () => Promise<unknown>): Promise<string> {
  try {
    await write();
    return "written";
  } catch (error) {
    return error instanceof Error ? error.name : String(error);
  }
}

export function registerImportClaimKeyDefectIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("uniqueness keys an import takes", () => {
    it("an object-valued unique property imported under allow collides with a create of the same value", async () => {
      const source = await context.createStore(
        buildGraph("claim_key_object_source"),
      );
      await source.nodes.ClaimKeyBadge.create(
        { code: { zeta: "z", a: "a" } },
        { id: "badge" },
      );
      const exported = await exportGraph(source);
      const document: GraphData = {
        ...exported,
        nodes: exported.nodes.map((node) => ({
          ...node,
          properties: { ...node.properties, legacyNote: "kept" },
        })),
      };
      const target = await context.createStore(
        buildGraph("claim_key_object_target"),
      );
      const imported = await importGraph(target, document, {
        onConflict: "error",
        onUnknownProperty: "allow",
      });
      const duplicate = await outcome(() =>
        target.nodes.ClaimKeyBadge.create({ code: { zeta: "z", a: "a" } }),
      );
      expectObservation({
        lane: { dialect: target.backend.dialect },
        observed: {
          importErrors: imported.errors.length,
          duplicate,
        },
        correct: { importErrors: 0, duplicate: "UniquenessError" },
        defects: [
          {
            label: "import claim key: JSONB key order",
            on: { dialect: ["postgres"] },
            today: { importErrors: 0, duplicate: "written" },
          },
        ],
      });
    });

    it("a write that replaces or deletes a unique date releases the old date", async () => {
      const source = await context.createStore(
        buildGraph("claim_key_date_source"),
      );
      await source.nodes.ClaimKeyDatedSlot.create(
        { title: "imported", at: SECOND },
        { id: "imported" },
      );
      const document = await exportGraph(source);
      const store = await context.createStore(
        buildGraph("claim_key_date_target"),
      );
      await store.nodes.ClaimKeyDatedSlot.create(
        { title: "imported", at: FIRST },
        { id: "imported" },
      );
      await store.nodes.ClaimKeyDatedSlot.create(
        { title: "updated", at: THIRD },
        { id: "updated" },
      );
      const deleted = await store.nodes.ClaimKeyDatedSlot.create({
        title: "deleted",
        at: new Date("2023-01-01T00:00:00.000Z"),
      });

      // Each write replaces (or removes) one unique date; a create of that
      // old date afterwards must succeed.
      const imported = await importGraph(store, document, {
        onConflict: "update",
        onUnknownProperty: "error",
      });
      await store.nodes.ClaimKeyDatedSlot.update(asNodeId("updated"), {
        at: new Date("2025-01-01T00:00:00.000Z"),
      });
      await store.nodes.ClaimKeyDatedSlot.delete(deleted.id);

      const observed = {
        importErrors: imported.errors.length,
        afterImport: await outcome(() =>
          store.nodes.ClaimKeyDatedSlot.create({ title: "a", at: FIRST }),
        ),
        afterUpdate: await outcome(() =>
          store.nodes.ClaimKeyDatedSlot.create({ title: "b", at: THIRD }),
        ),
        afterDelete: await outcome(() =>
          store.nodes.ClaimKeyDatedSlot.create({
            title: "c",
            at: new Date("2023-01-01T00:00:00.000Z"),
          }),
        ),
      };
      expectObservation({
        lane: { driver: context.driver },
        observed,
        correct: {
          importErrors: 0,
          afterImport: "written",
          afterUpdate: "written",
          afterDelete: "written",
        },
        // A delete keeps the deleted row's date reserved on better-sqlite3
        // only; every lane keeps the date an import or update replaced.
        defects: [
          {
            label: "date claim release (delete too)",
            on: { driver: ["better-sqlite3"] },
            today: {
              importErrors: 0,
              afterImport: "UniquenessError",
              afterUpdate: "UniquenessError",
              afterDelete: "UniquenessError",
            },
          },
          {
            label: "date claim release",
            on: {
              driver: ["libsql", "pglite", "node-postgres", "postgres-js"],
            },
            today: {
              importErrors: 0,
              afterImport: "UniquenessError",
              afterUpdate: "UniquenessError",
              afterDelete: "written",
            },
          },
        ],
      });
    });
  });
}
