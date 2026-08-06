/**
 * Props-key membership is an OWN-key question (issue #422).
 *
 * A props bag is data: its keys come from a JSON column, so a key may name an
 * `Object.prototype` member. `in` cannot answer "does this row carry this
 * property" for such a bag — `"toString" in {}` is `true` — so a row that does NOT
 * carry the key reads as though it does, and the `bag[key]` read that follows
 * yields the inherited prototype member instead of stored data.
 *
 * WHICH KEY MAKES THIS REACHABLE. Issue #422 named `__proto__`, but that is the
 * hardest case to reach and the least severe: Zod 4 drops an own `__proto__` key
 * (`looseObject` and `.passthrough()` alike), `branch()` clones the working copy
 * through the VALIDATING interchange import, the base@V content fingerprint
 * refuses a base mutated after the fork, and — decisively — `bag["__proto__"] =
 * value` sets a PROTOTYPE rather than creating a key, so the merge's own
 * assignment-built result bags cannot carry one either. Every layer independently
 * blocks it.
 *
 * The live ammunition is the rest of `Object.prototype`: `toString`,
 * `constructor`, `valueOf`, `hasOwnProperty`. A schema may legitimately DECLARE a
 * field with one of those names — `z.object({ toString: z.string() })` is an
 * ordinary schema — and such a field survives Zod, the JSON round-trip, and plain
 * assignment as completely normal data. `in` misclassifies it exactly the same
 * way, with no exotic input and nothing bypassed. That is what these tests pin.
 */

import type { GraphBackend, Store } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { rowPropsToObject } from "../../src/backend/types";
import { branch } from "../../src/graph-merge/branch";
import { collectConflictingValues } from "../../src/graph-merge/conflict-policy";
import { merge } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import { enumerateAllNodes } from "../../src/graph-merge/state-diff";
import type { BranchId, GraphBranch } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { backendMatrix, getStoreBackend } from "./test-utils";

/**
 * The declared field whose name shadows an `Object.prototype` member. Ordinary
 * data in every respect — the name is the entire point.
 */
const SHADOWING_FIELD = "toString";

/** The key issue #422 named; see the module docblock for why it is the weak case. */
const PROTO_KEY = "__proto__";

const PATIENT_KIND = "Patient";

const Patient = defineNode(PATIENT_KIND, {
  schema: z.object({
    name: z.string(),
    // A field named after a prototype member. `z.object({ toString: ... })` builds
    // an ordinary own key — `toString` has none of `__proto__`'s assignment magic.
    toString: z.string().optional(),
  }),
});

const graph = defineGraph({
  id: "prototype-named-props",
  nodes: { Patient: { type: Patient } },
  edges: {},
});
type G = typeof graph;

const BRANCH_A = asBranchId("branch-a");
const BRANCH_B = asBranchId("branch-b");

describe.each(backendMatrix())(
  "props keyed by a prototype member name [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    beforeEach(() => {
      cleanups = [];
    });

    afterEach(async () => {
      for (const cleanup of cleanups) {
        await cleanup();
      }
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function makeBranch(
      baseStore: Store<G>,
      id: BranchId,
    ): Promise<GraphBranch<G>> {
      return unwrap(await branch<G>(baseStore, () => makeBackend(), { id }));
    }

    /**
     * The row's props as actually stored. Read raw rather than through the
     * collection: a missing `toString` key would resolve to the inherited method
     * on a mapped object, which is the very confusion under test.
     */
    async function readStoredProps(
      store: Store<G>,
      id: string,
    ): Promise<Record<string, unknown>> {
      const rows = await enumerateAllNodes(
        getStoreBackend(store),
        store.graphId,
        PATIENT_KIND,
      );
      const row = requireDefined(rows.find((candidate) => candidate.id === id));
      return rowPropsToObject(row.props);
    }

    it("applies a fork's deletion of a property whose name shadows a prototype member", async () => {
      const [baseStore] = await createStoreWithSchema(
        graph,
        await makeBackend(),
      );
      const alice = await baseStore.nodes.Patient.create({
        name: "Alice",
        [SHADOWING_FIELD]: "base-owned",
      });
      const stored = await readStoredProps(baseStore, alice.id);
      // FIXTURE SANITY: an ordinary validated write really did store the key.
      expect(Object.hasOwn(stored, SHADOWING_FIELD)).toBe(true);

      const branchA = await makeBranch(baseStore, BRANCH_A);
      // The fork removes the optional field on the inherited node.
      await branchA.store.nodes.Patient.update(alice.id, {
        [SHADOWING_FIELD]: undefined,
      });

      const result = await merge<G>(baseStore, [branchA], {
        branchOrder: [BRANCH_A],
      });
      expect(isOk(result)).toBe(true);

      const merged = await readStoredProps(baseStore, alice.id);
      console.info(
        `[${entry.name}] stored keys after the fork's deletion:`,
        Object.keys(merged),
      );
      // A fork's bag is its FULL intended state, so a base key absent from it was
      // deleted by that fork. Under `in`, `"toString" in forkProps` is true even
      // though the fork dropped it, so no deletion tombstone is written and the
      // base value survives the merge — the fork's write is lost.
      expect(Object.hasOwn(merged, SHADOWING_FIELD)).toBe(false);
      expect(merged["name"]).toBe("Alice");
    });

    it("honors that deletion while a concurrent branch edits a different property", async () => {
      const [baseStore] = await createStoreWithSchema(
        graph,
        await makeBackend(),
      );
      const alice = await baseStore.nodes.Patient.create({
        name: "Alice",
        [SHADOWING_FIELD]: "base-owned",
      });

      const branchA = await makeBranch(baseStore, BRANCH_A);
      const branchB = await makeBranch(baseStore, BRANCH_B);
      await branchA.store.nodes.Patient.update(alice.id, {
        [SHADOWING_FIELD]: undefined,
      });
      // Restates the base value rather than passing a bare `{ name }` literal: with
      // a field declared as `toString: string`, TypeScript rejects any object
      // literal, because the literal's INHERITED `toString` (`() => string`) is
      // matched against the declared type. The name collision bites at the type
      // level too — so this branch keeps the field and edits only `name`.
      await branchB.store.nodes.Patient.update(alice.id, {
        name: "Alicia",
        [SHADOWING_FIELD]: "base-owned",
      });

      const result = await merge<G>(baseStore, [branchA, branchB], {
        branchOrder: [BRANCH_A, BRANCH_B],
      });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      const merged = await readStoredProps(baseStore, alice.id);
      console.info(
        `[${entry.name}] three-way merge stored keys:`,
        Object.keys(merged),
        `| conflicts:`,
        result.data.conflicts.length,
      );
      // Disjoint edits: one branch deletes the shadowing field, the other renames.
      // Both must land, and the deletion is not a conflict.
      expect(Object.hasOwn(merged, SHADOWING_FIELD)).toBe(false);
      expect(merged["name"]).toBe("Alicia");
      expect(
        result.data.conflicts.filter(
          (conflict) => conflict.property === SHADOWING_FIELD,
        ),
      ).toEqual([]);
    });
  },
);

describe("collectConflictingValues own-key contract", () => {
  /**
   * A props bag carrying a REAL own `__proto__` data property.
   *
   * The JSON parse is load-bearing and must not be "simplified" into an object
   * literal or an assignment: both `{ __proto__: value }` and `bag[PROTO_KEY] =
   * value` set the bag's PROTOTYPE and leave it with no own key at all, which
   * would make the assertion vacuous. Only `JSON.parse` — and the JSON columns
   * props are stored in — mint `__proto__` as ordinary own data.
   */
  function propsWithOwnProtoKey(taint: string): Record<string, unknown> {
    const bag = JSON.parse(
      `{"name": "carries", "${PROTO_KEY}": {"tainted": ${JSON.stringify(taint)}}}`,
    ) as Record<string, unknown>;
    expect(Object.hasOwn(bag, PROTO_KEY)).toBe(true);
    return bag;
  }

  it("skips a contribution that lacks a property named after a prototype member", () => {
    const values = collectConflictingValues(SHADOWING_FIELD, [
      { branchId: asBranchId("lacking"), props: { name: "lacks" } },
      {
        branchId: asBranchId("carrying"),
        props: { name: "carries", [SHADOWING_FIELD]: "real" },
      },
    ]);

    // Under `in`, the "lacking" branch is credited with a value it never stored —
    // `Object.prototype.toString`, a function — which then competes in conflict
    // resolution and is reported back to the caller as that branch's value.
    expect(values.map((candidate) => candidate.branchId)).toEqual([
      asBranchId("carrying"),
    ]);
    expect(values.map((candidate) => candidate.value)).toEqual(["real"]);
  });

  it("does not credit a bag lacking __proto__ with Object.prototype as its value", () => {
    const lacks = JSON.parse(`{"name": "lacks"}`) as Record<string, unknown>;
    expect(Object.hasOwn(lacks, PROTO_KEY)).toBe(false);

    const values = collectConflictingValues(PROTO_KEY, [
      { branchId: asBranchId("lacking"), props: lacks as never },
      {
        branchId: asBranchId("carrying"),
        props: propsWithOwnProtoKey("real") as never,
      },
    ]);

    expect(values.map((candidate) => candidate.branchId)).toEqual([
      asBranchId("carrying"),
    ]);
    expect(
      values.some(
        (candidate) => (candidate.value as unknown) === Object.prototype,
      ),
    ).toBe(false);
  });
});
