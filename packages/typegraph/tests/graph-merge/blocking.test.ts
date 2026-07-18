import type { Node, UniqueIntrospection } from "@nicia-ai/typegraph";
import {
  createStoreWithSchema,
  defineGraph,
  defineNode,
} from "@nicia-ai/typegraph";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  blockNodes,
  isUniqueBucketKey,
  UNBLOCKED_BUCKET_KEY,
} from "../../src/graph-merge/blocking";
import type { ResolveConfig } from "../../src/graph-merge/types";
import { requireDefined } from "../../src/utils/presence";
import { createSqliteMergeBackend } from "./test-utils";

const Patient = defineNode("Patient", {
  schema: z.object({
    name: z.string(),
    birthDate: z.string().optional(),
    mrn: z.string().optional(),
  }),
});

/**
 * Plain Patient graph with NO unique constraint. Used for the `block()`,
 * unblocked-fallback, and determinism tests, which freely create nodes with
 * absent `mrn` — a unique constraint over an optional field would (correctly)
 * reject two such rows in the same store.
 */
const patientGraph = defineGraph({
  id: "blocking-patient",
  nodes: { Patient: { type: Patient } },
  edges: {},
});

/**
 * Patient graph WITH an `mrn` unique constraint. Used only for the
 * unique-constraint short-circuit tests, where every node in a given store
 * carries a distinct `mrn`.
 */
const patientGraphWithUnique = defineGraph({
  id: "blocking-patient-unique",
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
  },
  edges: {},
});

type PatientNode = Node<typeof Patient>;

type StoreHarness<
  G extends typeof patientGraph | typeof patientGraphWithUnique,
> = Readonly<{
  store: Awaited<ReturnType<typeof createStoreWithSchema<G>>>[0];
  uniqueConstraints: readonly UniqueIntrospection[];
  cleanup: () => Promise<void>;
}>;

/**
 * Boots a real Patient store on an in-memory SQLite backend and returns it
 * alongside the kind's introspected unique constraints. Using a real store keeps
 * the test honest about the public `Node` runtime shape (props spread at the top
 * level) and the public `store.introspect().kinds[k].unique` surface that the
 * production caller reads.
 */
async function makePatientStore<
  G extends typeof patientGraph | typeof patientGraphWithUnique,
>(graph: G): Promise<StoreHarness<G>> {
  const fixture = createSqliteMergeBackend();
  const [store] = await createStoreWithSchema(graph, fixture.backend);
  const patientKind = store
    .introspect()
    .kinds.find((kind) => kind.name === "Patient");
  return {
    store,
    uniqueConstraints: patientKind?.unique ?? [],
    cleanup: fixture.cleanup,
  };
}

/** Returns a stable, comparable view of a bucket map: key -> ordered ids. */
function bucketShape(
  buckets: Map<string, PatientNode[]>,
): Record<string, string[]> {
  const shape: Record<string, string[]> = {};
  for (const [key, members] of buckets) {
    shape[key] = members.map((node) => node.id);
  }
  return shape;
}

/** Bucket keys in their actual map-iteration order (must be sorted). */
function keyOrder(buckets: Map<string, PatientNode[]>): string[] {
  return [...buckets.keys()];
}

const blockByBirthDate: Pick<ResolveConfig, "block"> = {
  block: (node) => (node as unknown as { birthDate?: string }).birthDate,
};

describe("blockNodes grouping by block()", () => {
  it("groups Patient nodes by their birthDate block key", async () => {
    const harness = await makePatientStore(patientGraph);
    try {
      const alice = await harness.store.nodes.Patient.create({
        name: "Alice",
        birthDate: "1974-03-09",
      });
      const anna = await harness.store.nodes.Patient.create({
        name: "Anna",
        birthDate: "1974-03-09",
      });
      const bob = await harness.store.nodes.Patient.create({
        name: "Bob",
        birthDate: "1990-01-01",
      });

      const buckets = blockNodes([alice, anna, bob], blockByBirthDate);

      // Two birthDate buckets; the 1974 cohort holds both Alice and Anna.
      expect(keyOrder(buckets)).toHaveLength(2);
      const cohort1974 = [...buckets.entries()].find(([key]) =>
        key.includes("1974-03-09"),
      );
      const cohort1990 = [...buckets.entries()].find(([key]) =>
        key.includes("1990-01-01"),
      );
      expect(cohort1974?.[1].map((node) => node.id).sort()).toEqual(
        [alice.id, anna.id].sort(),
      );
      expect(cohort1990?.[1].map((node) => node.id)).toEqual([bob.id]);
      // No node fell through to the all-vs-all fallback.
      expect(buckets.has(UNBLOCKED_BUCKET_KEY)).toBe(false);
    } finally {
      await harness.cleanup();
    }
  });

  it("places nodes whose block() returns undefined into the unblocked bucket", async () => {
    const harness = await makePatientStore(patientGraph);
    try {
      // No birthDate -> block() is undefined; no unique constraint on this graph.
      const noKeyA = await harness.store.nodes.Patient.create({ name: "X" });
      const noKeyB = await harness.store.nodes.Patient.create({ name: "Y" });
      const dated = await harness.store.nodes.Patient.create({
        name: "Z",
        birthDate: "2000-12-31",
      });

      const buckets = blockNodes([noKeyA, noKeyB, dated], blockByBirthDate);

      expect(buckets.has(UNBLOCKED_BUCKET_KEY)).toBe(true);
      expect(
        requireDefined(buckets.get(UNBLOCKED_BUCKET_KEY))
          .map((node) => node.id)
          .sort(),
      ).toEqual([noKeyA.id, noKeyB.id].sort());
      // The dated node is in its own birthDate bucket, not unblocked.
      const datedBucket = [...buckets.entries()].find(([key]) =>
        key.includes("2000-12-31"),
      );
      expect(datedBucket?.[1].map((node) => node.id)).toEqual([dated.id]);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("blockNodes unique-constraint short-circuit", () => {
  it("co-buckets nodes sharing a unique-constraint value even without a block()", async () => {
    const harness = await makePatientStore(patientGraphWithUnique);
    try {
      // No block() configured at all; rely entirely on the mrn unique constraint.
      const noBlock: Pick<ResolveConfig, "block"> = {};
      const shareMrnA = await harness.store.nodes.Patient.create({
        name: "Dup A",
        mrn: "MRN-100",
      });
      const distinctMrn = await harness.store.nodes.Patient.create({
        name: "Other",
        mrn: "MRN-200",
      });

      // A second node with the SAME mrn cannot be created in this store (the
      // unique constraint forbids it), so model the second branch's duplicate as
      // a node from a separate store sharing the mrn value.
      const otherHarness = await makePatientStore(patientGraphWithUnique);
      const shareMrnB = await otherHarness.store.nodes.Patient.create({
        name: "Dup B",
        mrn: "MRN-100",
      });

      const buckets = blockNodes(
        [shareMrnA, shareMrnB, distinctMrn],
        noBlock,
        harness.uniqueConstraints,
      );

      // shareMrnA and shareMrnB co-bucket on MRN-100; distinctMrn is separate.
      const mrn100 = [...buckets.entries()].find(([key]) =>
        key.includes("MRN-100"),
      );
      const mrn200 = [...buckets.entries()].find(([key]) =>
        key.includes("MRN-200"),
      );
      expect(mrn100?.[1].map((node) => node.id).sort()).toEqual(
        [shareMrnA.id, shareMrnB.id].sort(),
      );
      expect(mrn200?.[1].map((node) => node.id)).toEqual([distinctMrn.id]);
      expect(buckets.has(UNBLOCKED_BUCKET_KEY)).toBe(false);

      await otherHarness.cleanup();
    } finally {
      await harness.cleanup();
    }
  });

  it("places a node in BOTH its block bucket and its unique bucket (union, not composite)", async () => {
    const harness = await makePatientStore(patientGraphWithUnique);
    try {
      // Same birthDate, different mrn. They MUST still co-bucket on birthDate (the
      // block key) — the old composite key wrongly intersected mrn into the block
      // bucket and split two same-birthDate nodes so they were never compared.
      const sameDate1 = await harness.store.nodes.Patient.create({
        name: "P1",
        birthDate: "1980-05-05",
        mrn: "A-1",
      });
      const sameDate2 = await harness.store.nodes.Patient.create({
        name: "P2",
        birthDate: "1980-05-05",
        mrn: "A-2",
      });

      const buckets = blockNodes(
        [sameDate1, sameDate2],
        blockByBirthDate,
        harness.uniqueConstraints,
      );

      // The birthDate block bucket co-buckets BOTH (so candidate-gen compares them).
      const blockBucket = [...buckets.entries()].find(([key]) =>
        key.includes("1980-05-05"),
      );
      expect(blockBucket?.[1].map((node) => node.id).sort()).toEqual(
        [sameDate1.id, sameDate2.id].sort(),
      );
      // PLUS a distinct mrn bucket per node (each a singleton): the union, not a
      // composite. So there are three buckets total.
      expect(keyOrder(buckets)).toHaveLength(3);
      const a1 = [...buckets.entries()].find(([key]) => key.includes("A-1"));
      const a2 = [...buckets.entries()].find(([key]) => key.includes("A-2"));
      expect(a1?.[1].map((node) => node.id)).toEqual([sameDate1.id]);
      expect(a2?.[1].map((node) => node.id)).toEqual([sameDate2.id]);
    } finally {
      await harness.cleanup();
    }
  });

  it("co-buckets nodes sharing a unique value even when their block() keys DIFFER (P1 regression)", async () => {
    const harness = await makePatientStore(patientGraphWithUnique);
    try {
      // The exact reported bug: two nodes share mrn but have DIFFERENT birthDate
      // block keys. The old composite key split them, so entity resolution never
      // compared them and the duplicate survived. They must co-bucket on the mrn.
      const dupA = await harness.store.nodes.Patient.create({
        name: "Dup A",
        birthDate: "1974-03-09",
        mrn: "MRN-100",
      });
      const otherHarness = await makePatientStore(patientGraphWithUnique);
      const dupB = await otherHarness.store.nodes.Patient.create({
        name: "Dup B",
        birthDate: "1990-01-01",
        mrn: "MRN-100",
      });

      const buckets = blockNodes(
        [dupA, dupB],
        blockByBirthDate,
        harness.uniqueConstraints,
      );

      // Despite different birthDate buckets, they co-bucket on the shared mrn, so
      // candidate-gen WILL compare them — the duplicate is no longer missed.
      const mrnBucket = [...buckets.entries()].find(([key]) =>
        key.includes("MRN-100"),
      );
      expect(mrnBucket?.[1].map((node) => node.id).sort()).toEqual(
        [dupA.id, dupB.id].sort(),
      );
      await otherHarness.cleanup();
    } finally {
      await harness.cleanup();
    }
  });
});

describe("blockNodes caseInsensitive collation (F6)", () => {
  const patientGraphCaseInsensitive = defineGraph({
    id: "blocking-patient-ci",
    nodes: {
      Patient: {
        type: Patient,
        unique: [
          {
            name: "mrn_ci",
            fields: ["mrn"],
            scope: "kind",
            collation: "caseInsensitive",
          },
        ],
      },
    },
    edges: {},
  });

  it("co-buckets case-variant unique values under a caseInsensitive constraint", async () => {
    // Two case-variant mrn values are the SAME entity under caseInsensitive
    // collation, so they MUST co-bucket — formerly the raw JSON encoding put them
    // in different buckets and candidate-gen never compared them, so the real
    // duplicate survived the merge. Distinct stores because one store's own
    // constraint forbids two case-equal rows.
    const fixtureA = createSqliteMergeBackend();
    const fixtureB = createSqliteMergeBackend();
    try {
      const [storeA] = await createStoreWithSchema(
        patientGraphCaseInsensitive,
        fixtureA.backend,
      );
      const [storeB] = await createStoreWithSchema(
        patientGraphCaseInsensitive,
        fixtureB.backend,
      );
      const constraints =
        storeA.introspect().kinds.find((kind) => kind.name === "Patient")
          ?.unique ?? [];

      const upper = await storeA.nodes.Patient.create({
        name: "Upper",
        mrn: "MRN-100",
      });
      const lower = await storeB.nodes.Patient.create({
        name: "Lower",
        mrn: "mrn-100",
      });

      const buckets = blockNodes([upper, lower], {}, constraints);

      expect(keyOrder(buckets)).toHaveLength(1);
      const [, members] = requireDefined([...buckets.entries()][0]);
      expect(members.map((node) => node.id).sort()).toEqual(
        [upper.id, lower.id].sort(),
      );
      expect(buckets.has(UNBLOCKED_BUCKET_KEY)).toBe(false);
    } finally {
      await fixtureA.cleanup();
      await fixtureB.cleanup();
    }
  });
});

describe("blockNodes unique key matches enforcement (#1)", () => {
  const Account = defineNode("Account", {
    schema: z.object({
      name: z.string(),
      ref: z.union([z.string(), z.number()]).nullable().optional(),
    }),
  });
  const accountGraph = defineGraph({
    id: "blocking-account-unique",
    nodes: {
      Account: {
        type: Account,
        unique: [
          {
            name: "ref_unique",
            fields: ["ref"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
    },
    edges: {},
  });

  async function makeAccountStore() {
    const fixture = createSqliteMergeBackend();
    const [store] = await createStoreWithSchema(accountGraph, fixture.backend);
    const constraints =
      store.introspect().kinds.find((kind) => kind.name === "Account")
        ?.unique ?? [];
    return { store, constraints, cleanup: fixture.cleanup };
  }

  /** Unique bucket keys are the ones candidate-gen FORCE-merges. */
  function uniqueBucketKeys(buckets: Map<string, Node<typeof Account>[]>) {
    return [...buckets.keys()].filter((key) => isUniqueBucketKey(key));
  }

  it('co-buckets the number 1 and the string "1" (the DB unique key collapses them)', async () => {
    // computeUniqueKey maps both to "1", so committing them as two rows trips a
    // UniquenessError. Blocking MUST co-bucket them so the merge resolves the
    // duplicate instead of aborting — the old hand-rolled encoding split them.
    const storeA = await makeAccountStore();
    const storeB = await makeAccountStore();
    try {
      const numeric = await storeA.store.nodes.Account.create({
        name: "Num",
        ref: 1,
      });
      const stringy = await storeB.store.nodes.Account.create({
        name: "Str",
        ref: "1",
      });

      const buckets = blockNodes([numeric, stringy], {}, storeA.constraints);

      const unique = uniqueBucketKeys(buckets);
      expect(unique).toHaveLength(1);
      expect(
        requireDefined(buckets.get(requireDefined(unique[0])))
          .map((node) => node.id)
          .sort(),
      ).toEqual([numeric.id, stringy.id].sort());
    } finally {
      await storeA.cleanup();
      await storeB.cleanup();
    }
  });

  it("never force-merges two null unique values (no silent over-merge of distinct rows)", async () => {
    // Two distinct entities that both happen to carry a null unique value must
    // not be definitionally fused: with no `where` predicate visible, a partial
    // unique constraint would treat them as a non-match. They land in the
    // all-vs-all unblocked bucket (compared, never forced).
    const storeA = await makeAccountStore();
    const storeB = await makeAccountStore();
    try {
      const nullA = await storeA.store.nodes.Account.create({
        name: "A",
        ref: null,
      });
      const nullB = await storeB.store.nodes.Account.create({
        name: "B",
        ref: null,
      });

      const buckets = blockNodes([nullA, nullB], {}, storeA.constraints);

      expect(uniqueBucketKeys(buckets)).toEqual([]);
      expect(
        buckets
          .get(UNBLOCKED_BUCKET_KEY)
          ?.map((node) => node.id)
          .sort(),
      ).toEqual([nullA.id, nullB.id].sort());
    } finally {
      await storeA.cleanup();
      await storeB.cleanup();
    }
  });
});

describe("blockNodes deterministic ordering", () => {
  it("yields identical bucket structure and member order across shuffled inputs", async () => {
    const harness = await makePatientStore(patientGraph);
    try {
      const nodes: PatientNode[] = [];
      for (let index = 0; index < 8; index += 1) {
        // Half on 1974, half on 1990, in deliberately non-sorted name order.
        const birthDate = index % 2 === 0 ? "1974-03-09" : "1990-01-01";
        nodes.push(
          await harness.store.nodes.Patient.create({
            name: `Patient-${7 - index}`,
            birthDate,
          }),
        );
      }

      const forward = blockNodes(nodes, blockByBirthDate);
      const reversed = blockNodes([...nodes].reverse(), blockByBirthDate);
      const rotated = blockNodes(
        [...nodes.slice(3), ...nodes.slice(0, 3)],
        blockByBirthDate,
      );

      // Identical key iteration order (lexicographically sorted).
      expect(keyOrder(reversed)).toEqual(keyOrder(forward));
      expect(keyOrder(rotated)).toEqual(keyOrder(forward));
      // Key order is genuinely sorted, not just stable.
      expect(keyOrder(forward)).toEqual([...keyOrder(forward)].sort());
      // Identical per-bucket member id ordering.
      expect(bucketShape(reversed)).toEqual(bucketShape(forward));
      expect(bucketShape(rotated)).toEqual(bucketShape(forward));
      // Member ids within each bucket are sorted ascending.
      for (const [, members] of forward) {
        const ids = members.map((node) => node.id);
        expect(ids).toEqual([...ids].sort());
      }
    } finally {
      await harness.cleanup();
    }
  });
});
