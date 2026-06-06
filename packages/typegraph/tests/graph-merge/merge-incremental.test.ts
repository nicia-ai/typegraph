/**
 * Acceptance gate for the public ADDITIVE new-vs-base entry point `mergeIncremental()`
 * (design §6.4-B / §6.6). v1 commits a branch's ADDITIONS and resolves them against
 * the committed `target` (base-id-wins), never propagating inherited modify/delete,
 * and refusing any stale-overwrite of a committed row.
 *
 * Covers, on BOTH backends (new-vs-base semantics parity):
 *   - happy path: additive resolution against an ADVANCED target (target content the
 *     fork-point never had) — the deliberately-relaxed half of base@V;
 *   - idempotent re-run: a second merge against the now-evolved target does not churn;
 *   - inherited modify / delete are REJECTED (default `"error"`);
 *   - `"skipWithReport"` drops them + reports, never silent;
 *   - a non-keep-base `onBasePropertyConflict` is REJECTED;
 *   - the existing-target-id write guard fires for a colliding NODE and a colliding EDGE;
 *   - a branch that did not fork from `forkPoint` is REJECTED.
 */

import type { GraphBackend } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { branch } from "../../src/graph-merge/branch";
import { mergeIncremental } from "../../src/graph-merge/merge";
import { isErr, isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { normalizeGraph } from "../property/graph-merge/normalize";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    mrn: z.string(),
    tag: z.string().optional(),
  }),
});
const Encounter = defineNode("Encounter", {
  // `tag` is OPTIONAL so a target row can carry a field a branch's add omits — the
  // subset/patch-no-op case the stale-overwrite guard must NOT falsely refuse.
  schema: z.object({ reason: z.string(), tag: z.string().optional() }),
});
const hadEncounter = defineEdge("hadEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});
// A SECOND edge kind over the same endpoints, so a test can collide two different-kind
// edges on one (globally-unique) edge id.
const flaggedEncounter = defineEdge("flaggedEncounter", {
  schema: z.object({ reason: z.string() }),
  from: [Patient],
  to: [Encounter],
});
const primaryEncounter = defineEdge("primaryEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

const careGraph = defineGraph({
  id: "merge-incremental-care",
  nodes: {
    Patient: {
      type: Patient,
      unique: [
        {
          name: "mrn_unique",
          fields: ["mrn"],
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Encounter: { type: Encounter },
  },
  edges: {
    hadEncounter: { type: hadEncounter, from: [Patient], to: [Encounter] },
    flaggedEncounter: {
      type: flaggedEncounter,
      from: [Patient],
      to: [Encounter],
    },
    primaryEncounter: {
      type: primaryEncounter,
      from: [Patient],
      to: [Encounter],
      cardinality: "one",
    },
  },
});
type CareGraph = typeof careGraph;
type CareStore = GraphBranch<CareGraph>["store"];

const A = asBranchId("provider-a");

function options(
  overrides: Partial<MergeOptions<CareGraph>> = {},
): MergeOptions<CareGraph> {
  return {
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { mrn?: string }).mrn,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [A],
    ...overrides,
  };
}

describe.each(backendMatrix())(
  "mergeIncremental (additive) [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    afterEach(async () => {
      for (const cleanup of cleanups ?? []) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function emptyStore(): Promise<CareStore> {
      const [store] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      return store;
    }

    async function forkOf(
      forkPoint: CareStore,
    ): Promise<GraphBranch<CareGraph>> {
      return unwrap(
        await branch<CareGraph>(forkPoint, () => makeBackend(), { id: A }),
      );
    }

    it("HAPPY PATH: resolves a branch addition onto an advanced target's base entity", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      // A re-discovered patient (different spelling, same mrn) + an encounter edge.
      await provider.store.nodes.Patient.bulkCreate([
        { id: "new-ana", props: { name: "Ana Rivera", mrn: "MRN-1" } },
      ]);
      await provider.store.nodes.Encounter.bulkCreate([
        { id: "enc-1", props: { reason: "checkup" } },
      ]);
      await provider.store.edges.hadEncounter.bulkCreate([
        {
          id: "edge-1",
          from: { kind: "Patient", id: "new-ana" },
          to: { kind: "Encounter", id: "enc-1" },
          props: { on: "2026-06-04" },
        },
      ]);

      // Target is ADVANCED beyond the (empty) fork-point: it already holds the base.
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      // The new patient absorbed onto the committed base id (base-id-wins), and the
      // encounter + edge repointed onto it. Base name preserved (keep-base).
      const patients = await target.nodes.Patient.find();
      expect(patients.map((patient) => patient.id)).toEqual(["base-ana"]);
      expect(patients[0]!.name).toBe("Anna Rivera");
      const encounters = await target.nodes.Encounter.find();
      expect(encounters.map((enc) => enc.id)).toEqual(["enc-1"]);
      expect(result.data.resolutions.length).toBeGreaterThanOrEqual(1);
    });

    it("IDEMPOTENT: re-merging the same branch against the evolved target does not churn", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      await provider.store.nodes.Patient.bulkCreate([
        { id: "new-ana", props: { name: "Ana Rivera", mrn: "MRN-1" } },
        // A novel patient with NO base match — exercises the idempotency of a
        // non-resolved branch addition (committed under its own id, then re-seen).
        { id: "new-cara", props: { name: "Cara Diaz", mrn: "MRN-9" } },
      ]);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);

      const first = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isOk(first)).toBe(true);
      const afterFirst = await normalizeGraph(target);

      const second = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isOk(second)).toBe(true);
      const afterSecond = await normalizeGraph(target);

      expect(afterSecond).toEqual(afterFirst);
    });

    it("REJECTS an inherited node modification by default (additive v1)", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const [base] = await forkPoint.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);
      const provider = await forkOf(forkPoint);
      // Modify the INHERITED patient — the data-loss path v1 refuses.
      await provider.store.nodes.Patient.update(base!.id, { name: "Anna R." });
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/additive/i);
        expect(result.error.message).toMatch(/inherited/i);
      }
    });

    it("REJECTS an inherited node deletion by default (additive v1)", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const [base] = await forkPoint.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);
      const provider = await forkOf(forkPoint);
      await provider.store.nodes.Patient.delete(base!.id);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
    });

    it('"skipWithReport" drops inherited mutations + reports, never silently', async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const [base] = await forkPoint.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);
      const provider = await forkOf(forkPoint);
      await provider.store.nodes.Patient.update(base!.id, { name: "Anna R." });
      // ...plus a genuine ADDITION that must still commit.
      await provider.store.nodes.Patient.bulkCreate([
        { id: "new-bob", props: { name: "Bob Lee", mrn: "MRN-2" } },
      ]);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
        onInheritedMutation: "skipWithReport",
      });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }
      // The inherited modify was dropped and reported.
      expect(
        result.data.warnings.some((warning) => /inherited/i.test(warning)),
      ).toBe(true);
      // Base name is UNCHANGED (the inherited modify did not propagate)...
      const ana = (await target.nodes.Patient.find()).find(
        (patient) => patient.id === "base-ana",
      );
      expect(ana?.name).toBe("Anna Rivera");
      // ...but the genuine addition committed.
      const ids = (await target.nodes.Patient.find())
        .map((patient) => patient.id)
        .sort();
      expect(ids).toEqual(["base-ana", "new-bob"]);
    });

    it("REJECTS a non-keep-base onBasePropertyConflict policy", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      const target = await emptyStore();

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options({ onBasePropertyConflict: "lastWriteWins" }),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/onBasePropertyConflict/);
      }
    });

    it("GUARD: refuses to overwrite a colliding committed NODE id", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      // A novel patient (mrn has no base match) under an id that the target reuses.
      await provider.store.nodes.Patient.bulkCreate([
        { id: "shared-id", props: { name: "Branch Person", mrn: "MRN-NEW" } },
      ]);
      const target = await emptyStore();
      // Same id, DIFFERENT entity (different mrn → no new-vs-base resolution).
      await target.nodes.Patient.bulkCreate([
        {
          id: "shared-id",
          props: { name: "Committed Person", mrn: "MRN-OTHER" },
        },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/overwrite committed node/i);
      }
    });

    it("SAME-ID re-discovery: resolves onto the base (base-id-wins), does not error", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      // The branch re-creates the entity under its REAL committed id (same id, same mrn,
      // a divergent name) — a node whose unique value re-discovers the committed base
      // AT THE SAME (kind, id). It must resolve via base-id-wins, not trip the guard.
      await provider.store.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Ana Rivera", mrn: "MRN-1" } },
      ]);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }
      // Single committed row, base name kept (keep-base), no duplicate insert.
      const patients = await target.nodes.Patient.find();
      expect(patients.map((patient) => patient.id)).toEqual(["base-ana"]);
      expect(patients[0]!.name).toBe("Anna Rivera");
      // The base↔branch name divergence is FLAGGED, and the reserved base-provenance
      // sentinel never leaks into the public conflict's contributing-branch values.
      const nameConflict = result.data.conflicts.find(
        (conflict) => conflict.property === "name",
      );
      expect(nameConflict).toBeDefined();
      for (const value of nameConflict?.values ?? []) {
        expect(value.branchId).not.toMatch(/committed_base/);
      }
    });

    it("PATCH no-op: a subset re-add of a committed row is allowed (not a stale overwrite)", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      // A new Encounter (no unique constraint → never a base member) under an id the
      // target already holds, whose props are a SUBSET of (and agree with) the committed
      // row. The commit PATCH-merges, so this is a no-op, not a stale overwrite.
      await provider.store.nodes.Encounter.bulkCreate([
        { id: "enc-sub", props: { reason: "checkup" } },
      ]);
      const target = await emptyStore();
      await target.nodes.Encounter.bulkCreate([
        { id: "enc-sub", props: { reason: "checkup", tag: "vip" } },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isOk(result)).toBe(true);
      // The patch preserved the committed-only field — a true no-op.
      const [encounter] = await target.nodes.Encounter.find();
      expect(encounter?.reason).toBe("checkup");
      expect((encounter as { tag?: string } | undefined)?.tag).toBe("vip");
    });

    it("GUARD: refuses to overwrite a colliding committed EDGE id", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      // Branch addition: novel patient + encounter + edge "shared-edge".
      await provider.store.nodes.Patient.bulkCreate([
        { id: "branch-pat", props: { name: "Branch Person", mrn: "MRN-NEW" } },
      ]);
      await provider.store.nodes.Encounter.bulkCreate([
        { id: "branch-enc", props: { reason: "branch" } },
      ]);
      await provider.store.edges.hadEncounter.bulkCreate([
        {
          id: "shared-edge",
          from: { kind: "Patient", id: "branch-pat" },
          to: { kind: "Encounter", id: "branch-enc" },
          props: { on: "2026-06-04" },
        },
      ]);
      const target = await emptyStore();
      // Same edge id, DIFFERENT endpoints already committed.
      await target.nodes.Patient.bulkCreate([
        { id: "base-pat", props: { name: "Committed", mrn: "MRN-OTHER" } },
      ]);
      await target.nodes.Encounter.bulkCreate([
        { id: "base-enc", props: { reason: "committed" } },
      ]);
      await target.edges.hadEncounter.bulkCreate([
        {
          id: "shared-edge",
          from: { kind: "Patient", id: "base-pat" },
          to: { kind: "Encounter", id: "base-enc" },
          props: { on: "2000-01-01" },
        },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/overwrite committed edge/i);
      }
    });

    it("GUARD (cross-kind): refuses a same-id edge of a DIFFERENT kind than the committed edge", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      // Branch additively creates a patient + encounter + a flaggedEncounter edge that
      // reuses an id the target holds under a DIFFERENT edge kind.
      await provider.store.nodes.Patient.bulkCreate([
        { id: "branch-pat", props: { name: "Branch", mrn: "MRN-NEW" } },
      ]);
      await provider.store.nodes.Encounter.bulkCreate([
        { id: "branch-enc", props: { reason: "branch" } },
      ]);
      await provider.store.edges.flaggedEncounter.bulkCreate([
        {
          id: "shared-edge",
          from: { kind: "Patient", id: "branch-pat" },
          to: { kind: "Encounter", id: "branch-enc" },
          props: { reason: "flag" },
        },
      ]);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-pat", props: { name: "Committed", mrn: "MRN-OTHER" } },
      ]);
      await target.nodes.Encounter.bulkCreate([
        { id: "base-enc", props: { reason: "committed" } },
      ]);
      // SAME edge id, committed as a DIFFERENT kind (hadEncounter).
      await target.edges.hadEncounter.bulkCreate([
        {
          id: "shared-edge",
          from: { kind: "Patient", id: "base-pat" },
          to: { kind: "Encounter", id: "base-enc" },
          props: { on: "2000-01-01" },
        },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      // Edge ids are globally unique (PK is (graph_id, id)); committing the
      // flaggedEncounter edge would resolve the committed hadEncounter row by id and
      // overwrite it in place. Must be refused (was silently allowed + corrupting).
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(
          /edge.id collision|different-kind/i,
        );
      }
      // The committed edge is untouched: still hadEncounter, original props (the guard
      // aborts before any write, so nothing was committed).
      const committed = await target.edges.hadEncounter.find();
      expect(committed.map((edge) => edge.id)).toEqual(["shared-edge"]);
      expect(committed[0]!.on).toBe("2000-01-01");
    });

    it("GUARD (soft-delete): refuses to resurrect a soft-deleted committed EDGE", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      await provider.store.nodes.Patient.bulkCreate([
        { id: "branch-pat", props: { name: "Branch", mrn: "MRN-NEW" } },
      ]);
      await provider.store.nodes.Encounter.bulkCreate([
        { id: "branch-enc", props: { reason: "branch" } },
      ]);
      await provider.store.edges.hadEncounter.bulkCreate([
        {
          id: "sd-edge",
          from: { kind: "Patient", id: "branch-pat" },
          to: { kind: "Encounter", id: "branch-enc" },
          props: { on: "2026-06-06" },
        },
      ]);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-pat", props: { name: "Committed", mrn: "MRN-OTHER" } },
      ]);
      await target.nodes.Encounter.bulkCreate([
        { id: "base-enc", props: { reason: "committed" } },
      ]);
      const [sdEdge] = await target.edges.hadEncounter.bulkCreate([
        {
          id: "sd-edge",
          from: { kind: "Patient", id: "base-pat" },
          to: { kind: "Encounter", id: "base-enc" },
          props: { on: "2000-01-01" },
        },
      ]);
      // Soft-delete the committed edge. The commit's upsert resolves by id and would
      // RESURRECT this tombstone (dropping the branch's new edge) — a silent data loss.
      await target.edges.hadEncounter.delete(sdEdge!.id);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(
          /resurrect soft-deleted committed edge/i,
        );
      }
    });

    it("GUARD (soft-delete): refuses to resurrect a soft-deleted committed NODE", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      // A novel patient (different mrn → no base match) reusing a soft-deleted id.
      await provider.store.nodes.Patient.bulkCreate([
        { id: "sd-pat", props: { name: "Fresh", mrn: "MRN-NEW" } },
      ]);
      const target = await emptyStore();
      const [sdPat] = await target.nodes.Patient.bulkCreate([
        { id: "sd-pat", props: { name: "OldStale", mrn: "MRN-OTHER" } },
      ]);
      // Soft-delete it; the commit's upsert would resurrect the tombstone and merge its
      // stale props forward into what the branch staged as a fresh insert.
      await target.nodes.Patient.delete(sdPat!.id);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(
          /resurrect soft-deleted committed node/i,
        );
      }
    });

    it("GUARD (kind-aware): a base member does NOT exempt a same-id node of another kind", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      // A new Patient resolves onto base Patient:shared (so "shared" is a base member)...
      await provider.store.nodes.Patient.bulkCreate([
        { id: "new-pat", props: { name: "Ana Rivera", mrn: "MRN-1" } },
      ]);
      // ...and a NEW Encounter reuses the id "shared" — a DIFFERENT kind, same id.
      await provider.store.nodes.Encounter.bulkCreate([
        { id: "shared", props: { reason: "branch" } },
      ]);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "shared", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);
      await target.nodes.Encounter.bulkCreate([
        { id: "shared", props: { reason: "committed" } },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      // Patient:shared is the base member; Encounter:shared must STILL be guarded
      // (node identity is (kind, id) — an id-only skip would let this through).
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/overwrite committed node/i);
        expect(result.error.message).toMatch(/Encounter/);
      }
    });

    it("TRANSACTION: TypeGraph edge-cardinality failure rolls back prior node creates", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      await provider.store.nodes.Patient.bulkCreate([
        {
          id: "new-ana",
          props: { name: "Ana Rivera", mrn: "MRN-1" },
        },
      ]);
      await provider.store.nodes.Encounter.bulkCreate([
        { id: "branch-enc", props: { reason: "branch" } },
      ]);
      await provider.store.edges.primaryEncounter.bulkCreate([
        {
          id: "branch-primary",
          from: { kind: "Patient", id: "new-ana" },
          to: { kind: "Encounter", id: "branch-enc" },
          props: { on: "2026-06-06" },
        },
      ]);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);
      await target.nodes.Encounter.bulkCreate([
        { id: "base-enc", props: { reason: "committed" } },
      ]);
      await target.edges.primaryEncounter.bulkCreate([
        {
          id: "base-primary",
          from: { kind: "Patient", id: "base-ana" },
          to: { kind: "Encounter", id: "base-enc" },
          props: { on: "2026-06-01" },
        },
      ]);

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/cardinality/i);
      }

      expect(
        (await target.nodes.Patient.find()).map((patient) => patient.id),
      ).toEqual(["base-ana"]);
      expect(
        (await target.nodes.Encounter.find()).map((encounter) => encounter.id),
      ).toEqual(["base-enc"]);
      expect(
        (await target.edges.primaryEncounter.find()).map((edge) => edge.id),
      ).toEqual(["base-primary"]);
    });

    it("GUARD (base update): refuses to strip heterogeneous committed props while gap-filling base fields", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      await provider.store.nodes.Patient.bulkCreate([
        {
          id: "new-ana",
          props: { name: "Ana Rivera", mrn: "MRN-1", tag: "branch-gap" },
        },
      ]);
      const target = await emptyStore();
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);
      // Public create keeps the unique index coherent; this raw backend update then
      // simulates an older/heterogeneous committed row the active schema would strip.
      await target.backend.updateNode({
        graphId: target.graphId,
        kind: "Patient",
        id: "base-ana",
        props: {
          name: "Anna Rivera",
          mrn: "MRN-1",
          legacyCode: "KEEP-ME",
        },
        incrementVersion: true,
      });

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/strip existing props/i);
        expect(result.error.message).toMatch(/lossy base update/i);
      }

      const row = await target.backend.getNode(
        target.graphId,
        "Patient",
        "base-ana",
      );
      expect(row).toBeDefined();
      const props = JSON.parse(row!.props) as Record<string, unknown>;
      expect(props.legacyCode).toBe("KEEP-ME");
      expect(props.tag).toBeUndefined();
    });

    it("REJECTS a branch that did not fork from forkPoint (base@V mismatch)", async () => {
      cleanups = [];
      const forkPoint = await emptyStore();
      const provider = await forkOf(forkPoint);
      await provider.store.nodes.Patient.bulkCreate([
        { id: "new-ana", props: { name: "Ana Rivera", mrn: "MRN-1" } },
      ]);
      // Mutate the fork-point AFTER forking → its base@V no longer matches the branch.
      await forkPoint.nodes.Patient.bulkCreate([
        { id: "drift", props: { name: "Drift", mrn: "MRN-DRIFT" } },
      ]);
      const target = await emptyStore();

      const result = await mergeIncremental<CareGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: options(),
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/forkPoint|fork-point/i);
      }
    });
  },
);

// A graph whose edge type allows MULTIPLE endpoint kinds, so an edge's identity
// includes `(fromKind, toKind)` — the edge guard must compare them.
const Thing = defineNode("Thing", { schema: z.object({ name: z.string() }) });
const Other = defineNode("Other", { schema: z.object({ name: z.string() }) });
const relatesTo = defineEdge("relatesTo", {
  schema: z.object({ note: z.string() }),
  from: [Thing, Other],
  to: [Thing, Other],
});
const polyGraph = defineGraph({
  id: "merge-incremental-poly",
  nodes: { Thing: { type: Thing }, Other: { type: Other } },
  edges: {
    relatesTo: { type: relatesTo, from: [Thing, Other], to: [Thing, Other] },
  },
});
type PolyGraph = typeof polyGraph;

describe.each(backendMatrix())(
  "mergeIncremental edge endpoint-kind guard [$name]",
  (entry) => {
    let cleanups: (() => Promise<void>)[];

    afterEach(async () => {
      for (const cleanup of cleanups ?? []) {
        await cleanup();
      }
      cleanups = [];
    });

    async function makeBackend(): Promise<GraphBackend> {
      const fixture = await entry.make();
      cleanups.push(fixture.cleanup);
      return fixture.backend;
    }

    async function emptyPoly(): Promise<GraphBranch<PolyGraph>["store"]> {
      const [store] = await createStoreWithSchema(
        polyGraph,
        await makeBackend(),
      );
      return store;
    }

    it("refuses an edge differing ONLY by endpoint kind (same id / endpoint ids / props)", async () => {
      cleanups = [];
      const forkPoint = await emptyPoly();
      const provider = unwrap(
        await branch<PolyGraph>(forkPoint, () => makeBackend(), { id: A }),
      );
      // Branch edge "e": Other:x -> Other:y, note "same".
      await provider.store.nodes.Other.bulkCreate([
        { id: "x", props: { name: "X" } },
        { id: "y", props: { name: "Y" } },
      ]);
      await provider.store.edges.relatesTo.bulkCreate([
        {
          id: "e",
          from: { kind: "Other", id: "x" },
          to: { kind: "Other", id: "y" },
          props: { note: "same" },
        },
      ]);
      const target = await emptyPoly();
      // Committed edge "e": Thing:x -> Thing:y, note "same" — same id, same endpoint
      // ids, same props, DIFFERENT endpoint kinds.
      await target.nodes.Thing.bulkCreate([
        { id: "x", props: { name: "X" } },
        { id: "y", props: { name: "Y" } },
      ]);
      await target.edges.relatesTo.bulkCreate([
        {
          id: "e",
          from: { kind: "Thing", id: "x" },
          to: { kind: "Thing", id: "y" },
          props: { note: "same" },
        },
      ]);

      const result = await mergeIncremental<PolyGraph>({
        forkPoint,
        target,
        branches: [provider],
        options: { branchOrder: [A] },
      });
      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.message).toMatch(/overwrite committed edge/i);
      }
    });
  },
);
