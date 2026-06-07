/**
 * Step 4 contract: reconciler wiring for the synthetic NEW-vs-BASE scope
 * (design §6.4-C). Drives `mergeAgainstBase` end-to-end and proves:
 *
 *   - a staged node re-discovering a committed entity (shared unique value)
 *     resolves AGAINST it — BASE-ID-WINS: the committed base id is the canonical
 *     survivor, the new node is absorbed (never inserted as a duplicate);
 *   - branch edges onto the new node REPOINT onto the surviving base id;
 *   - base props gap-fill / keep the committed value under the default policy.
 *
 * The branch forks from an EMPTY fork-point (so its new node does not collide with
 * the committed base's unique value and the diff sees no spurious deletion), while
 * the committed base lives in a separate TARGET — the evolved-base shape the
 * synthetic scope models. Runs on BOTH backends (new-vs-base semantics parity).
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
import { mergeAgainstBase } from "../../src/graph-merge/merge";
import { isOk, unwrap } from "../../src/graph-merge/result";
import type { GraphBranch, MergeOptions } from "../../src/graph-merge/types";
import { asBranchId } from "../../src/graph-merge/types";
import { backendMatrix } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({ name: z.string(), mrn: z.string() }),
});
const Encounter = defineNode("Encounter", {
  schema: z.object({ reason: z.string() }),
});
const hadEncounter = defineEdge("hadEncounter", {
  schema: z.object({ on: z.string() }),
  from: [Patient],
  to: [Encounter],
});

const careGraph = defineGraph({
  id: "new-vs-base-care",
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
  },
});
type CareGraph = typeof careGraph;

const BRANCH = asBranchId("provider-x");

function mergeOptions(
  target: GraphBranch<CareGraph>["store"],
): MergeOptions<CareGraph> {
  return {
    target,
    resolve: {
      Patient: {
        block: (node) => (node as unknown as { mrn?: string }).mrn,
        similarity: { kind: "fulltext", fields: ["name"] },
        threshold: 0.85,
      },
    },
    onPropertyConflict: "flag",
    branchOrder: [BRANCH],
  };
}

describe.each(backendMatrix())(
  "mergeAgainstBase new-vs-base [$name]",
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

    it("resolves a staged duplicate onto the committed base id; edges follow", async () => {
      cleanups = [];

      // Fork-point base: EMPTY (so the branch's new patient does not collide with the
      // committed unique value, and the diff sees no spurious deletion).
      const [forkBase] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );

      // The branch adds a duplicate patient (same mrn as the committed base) + an
      // encounter edge onto her.
      const provider = unwrap(
        await branch<CareGraph>(forkBase, () => makeBackend(), { id: BRANCH }),
      );
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

      // The committed (evolved) base, in a SEPARATE target: already holds the entity.
      const [target] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      await target.nodes.Patient.bulkCreate([
        { id: "base-ana", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);

      const result = await mergeAgainstBase<CareGraph>(
        forkBase,
        [provider],
        mergeOptions(target),
      );
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }
      console.info(
        `[${entry.name}] resolutions:`,
        result.data.resolutions.map(
          (r) => `${r.canonicalId}<-[${r.memberIds.join(",")}]`,
        ),
      );

      // BASE-ID-WINS: exactly one Patient in the target — the committed base-ana —
      // carrying its committed value (flag keeps the canonical/base value). new-ana
      // was absorbed, never inserted as a second row.
      const patients = await target.nodes.Patient.find();
      console.info(
        `[${entry.name}] patients:`,
        patients.map((p) => `${p.id}:${p.name}`),
      );
      expect(patients).toHaveLength(1);
      expect(`${patients[0]?.id}`).toBe("base-ana");
      expect(patients[0]?.name).toBe("Anna Rivera");

      // The branch's new encounter committed, and its edge REPOINTED onto base-ana.
      const encounters = await target.nodes.Encounter.find();
      expect(encounters).toHaveLength(1);
      const edges = await target.edges.hadEncounter.find();
      console.info(
        `[${entry.name}] edges:`,
        edges.map((e) => `${e.fromId}->${e.toId}`),
      );
      expect(edges).toHaveLength(1);
      expect(`${edges[0]?.fromId}`).toBe("base-ana");
      expect(`${edges[0]?.toId}`).toBe("enc-1");

      // The resolution records the base id as canonical, spanning both ids.
      const resolution = result.data.resolutions.find(
        (r) => r.canonicalId === "base-ana",
      );
      expect(resolution).toBeDefined();
      expect(resolution?.memberIds.map((id) => id).sort()).toEqual([
        "base-ana",
        "new-ana",
      ]);
    });

    it("base-id-wins overrides a MergeOptions.canonical hook (hook bypassed for base clusters)", async () => {
      cleanups = [];
      const [forkBase] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      const provider = unwrap(
        await branch<CareGraph>(forkBase, () => makeBackend(), { id: BRANCH }),
      );
      await provider.store.nodes.Patient.bulkCreate([
        { id: "zzz-new", props: { name: "Ana Rivera", mrn: "MRN-1" } },
      ]);
      const [target] = await createStoreWithSchema(
        careGraph,
        await makeBackend(),
      );
      await target.nodes.Patient.bulkCreate([
        { id: "aaa-base", props: { name: "Anna Rivera", mrn: "MRN-1" } },
      ]);

      // A canonical hook that would pick the lexicographically-LAST member id. For a
      // base cluster it must be BYPASSED — the committed base id wins regardless.
      const result = await mergeAgainstBase<CareGraph>(forkBase, [provider], {
        ...mergeOptions(target),
        canonical: (cluster) =>
          [...cluster.members].sort((l, r) => (l < r ? 1 : -1))[0]!,
      });
      expect(isOk(result)).toBe(true);
      if (!isOk(result)) {
        return;
      }

      const patients = await target.nodes.Patient.find();
      // Hook would have chosen "zzz-new"; base-id-wins forces the committed "aaa-base".
      expect(patients).toHaveLength(1);
      expect(`${patients[0]?.id}`).toBe("aaa-base");
    });
  },
);
