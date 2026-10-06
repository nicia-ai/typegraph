/**
 * Cross-backend contract for schema commits that would leave a uniqueness
 * constraint unenforced over existing rows.
 *
 * A schema commit validates no existing row against a unique constraint and
 * rebuilds no claim, so every path that publishes a version refuses to add or
 * reshape a unique constraint on a populated kind, and to move a
 * `kindWithSubClasses` claim axis away from where a populated kind's claims
 * sit. Each case states the mutation that must make it fail.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createAdapterStoreWithSchema,
  defineGraph,
  defineGraphExtension,
  defineNode,
  IncompatibleChangeError,
  MigrationError,
  type MigrationErrorDetails,
  subClassOf,
  type UniquenessClaimGate,
  UniquenessError,
  UnsupportedBackendCapabilityError,
} from "../../../src";
import { projectBackendWithout } from "../../../src/backend/derive-backend";
import {
  getActiveSchema,
  migrateSchema,
  rollbackSchema,
} from "../../../src/schema";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

const DUPLICATE_EMAIL = "dup@example.com";

const Account = defineNode("GateAccount", {
  schema: z.object({ email: z.string() }),
});
const ACCOUNT_EMAIL_UNIQUE = {
  name: "gate_account_email",
  fields: ["email"],
  scope: "kind",
  collation: "binary",
} as const;

/** One kind, with or without its unique constraint (optionally widened). */
function accountGraph(id: string, unique: "none" | "kind" | "caseInsensitive") {
  return defineGraph({
    id,
    nodes: {
      GateAccount: {
        type: Account,
        unique:
          unique === "none" ? []
          : unique === "kind" ? [ACCOUNT_EMAIL_UNIQUE]
          : [{ ...ACCOUNT_EMAIL_UNIQUE, collation: "caseInsensitive" }],
      },
    },
    edges: {},
  });
}

/**
 * `GateEmployee` sorts before `GatePerson`, so while the two share a subclass
 * component the `kindWithSubClasses` claim axis is `GateEmployee` — including
 * for claims a `GatePerson` row writes.
 */
const Person = defineNode("GatePerson", {
  schema: z.object({ email: z.string() }),
});
const Employee = defineNode("GateEmployee", {
  schema: z.object({ email: z.string() }),
});
const HIERARCHY_EMAIL_UNIQUE = {
  name: "gate_hierarchy_email",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;

/**
 * Keeps the `subClassOf` meta-edge alive on both sides of every transition:
 * removing the only relation naming a meta-edge removes the meta-edge too,
 * an unrelated `breaking` change that would mask the one under test.
 */
const Bystander = defineNode("GateBystander", { schema: z.object({}) });
const OtherBystander = defineNode("GateOtherBystander", {
  schema: z.object({}),
});

function hierarchyGraph(id: string, related: boolean) {
  return defineGraph({
    id,
    nodes: {
      GatePerson: { type: Person, unique: [HIERARCHY_EMAIL_UNIQUE] },
      GateEmployee: { type: Employee, unique: [HIERARCHY_EMAIL_UNIQUE] },
      GateBystander: { type: Bystander },
      GateOtherBystander: { type: OtherBystander },
    },
    edges: {},
    ontology: [
      subClassOf(Bystander, OtherBystander),
      ...(related ? [subClassOf(Employee, Person)] : []),
    ],
  });
}

const PERSON_AXIS_MOVED: UniquenessClaimGate = {
  cause: "claim-axis-moved",
  kind: "GatePerson",
  constraintName: "gate_hierarchy_email",
  axis: "GatePerson",
  previousAxis: "GateEmployee",
};

/** A host kind an extension subclass can pull the claim axis away from. */
const Whole = defineNode("GateWhole", {
  schema: z.object({ email: z.string() }),
});
function wholeGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      GateWhole: {
        type: Whole,
        unique: [
          { ...HIERARCHY_EMAIL_UNIQUE, name: "gate_whole_email" } as const,
        ],
      },
    },
    edges: {},
  });
}
/** `GateAardvark` sorts before `GateWhole`, so it becomes the claim axis. */
const AARDVARK_EXTENSION = defineGraphExtension({
  nodes: { GateAardvark: { properties: { email: { type: "string" } } } },
  ontology: [{ metaEdge: "subClassOf", from: "GateAardvark", to: "GateWhole" }],
});

const Host = defineNode("GateHost", { schema: z.object({}) });
function hostGraph(id: string) {
  return defineGraph({ id, nodes: { GateHost: { type: Host } }, edges: {} });
}
function taggedExtension(unique: boolean) {
  return defineGraphExtension({
    nodes: {
      GateTag: {
        properties: { label: { type: "string" } },
        ...(unique ?
          { unique: [{ name: "gate_tag_label", fields: ["label"] }] }
        : {}),
      },
    },
  });
}

async function activeVersion(
  context: IntegrationTestContext,
  id: string,
): Promise<number> {
  const active = await getActiveSchema(context.getBackend(), id);
  return requireDefined(active, "active schema").version;
}

function gatedConstraints(error: unknown): readonly UniquenessClaimGate[] {
  expect(error).toBeInstanceOf(MigrationError);
  const details: MigrationErrorDetails = (error as MigrationError).details;
  if (details.reason !== "unique-constraint-requires-empty-kind") {
    throw new Error(
      `expected unique-constraint-requires-empty-kind, got ${details.reason}`,
    );
  }
  return details.constraints;
}

const ACCOUNT_CONSTRAINT_ADDED: UniquenessClaimGate = {
  cause: "constraint-added",
  kind: "GateAccount",
  constraintName: "gate_account_email",
  axis: "GateAccount",
};

export function registerUniquenessClaimGateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("schema commits that would strand uniqueness enforcement", () => {
    it("refuses adding a unique constraint to a populated kind through createStoreWithSchema", async () => {
      const id = "uniqueness_gate_add_ensure";
      const store = await context.createStore(accountGraph(id, "none"));
      await store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });
      await store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });

      const error = await createAdapterStoreWithSchema(
        accountGraph(id, "kind"),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(gatedConstraints(error)).toEqual([ACCOUNT_CONSTRAINT_ADDED]);
      expect((error as MigrationError).details).toMatchObject({
        graphId: id,
        fromVersion: 1,
        toVersion: 2,
      });
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: dropping `assertUniquenessClaimGatesOpen` from the
    // tightening preflight's `run` commits version 2 over two rows that
    // violate the constraint, and this case fails.

    it("refuses the same addition when the existing rows hold no duplicate", async () => {
      const id = "uniqueness_gate_add_clean_rows";
      const store = await context.createStore(accountGraph(id, "none"));
      await store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });

      const error = await createAdapterStoreWithSchema(
        accountGraph(id, "kind"),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      // No claim row is backfilled, so a later duplicate of the OLD value
      // would be accepted: duplicate-free rows are refused all the same.
      expect(gatedConstraints(error)).toEqual([ACCOUNT_CONSTRAINT_ADDED]);
      expect(await activeVersion(context, id)).toBe(1);
    });

    it("refuses the same addition through migrateSchema", async () => {
      const id = "uniqueness_gate_add_migrate";
      const store = await context.createStore(accountGraph(id, "none"));
      await store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });

      const error = await migrateSchema(
        context.getBackend(),
        accountGraph(id, "kind"),
        1,
      ).catch((error_: unknown) => error_);

      expect(gatedConstraints(error)).toEqual([ACCOUNT_CONSTRAINT_ADDED]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: same as above; `migrateSchema` reaches the gate through
    // the one tightening preflight every commit path composes.

    it("refuses reshaping a unique constraint on a populated kind", async () => {
      const id = "uniqueness_gate_reshape";
      const store = await context.createStore(accountGraph(id, "kind"));
      await store.nodes.GateAccount.create({ email: "Case@example.com" });
      await store.nodes.GateAccount.create({ email: "case@example.com" });

      const error = await createAdapterStoreWithSchema(
        accountGraph(id, "caseInsensitive"),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(gatedConstraints(error)).toEqual([
        { ...ACCOUNT_CONSTRAINT_ADDED, cause: "constraint-reshaped" },
      ]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: making `uniqueConstraintEnforcementChange` return
    // `undefined` for a same-named constraint of a different shape commits
    // the reshape, and this case fails.

    it("adds a unique constraint to an unpopulated kind and enforces it", async () => {
      const id = "uniqueness_gate_add_empty";
      await context.createStore(accountGraph(id, "none"));

      const [store] = await createAdapterStoreWithSchema(
        accountGraph(id, "kind"),
        context.getBackend(),
      );

      expect(await activeVersion(context, id)).toBe(2);
      await store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });
      await expect(
        store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });

    it("adds a unique constraint once the kind's rows are deleted", async () => {
      const id = "uniqueness_gate_add_emptied";
      const before = await context.createStore(accountGraph(id, "none"));
      const first = await before.nodes.GateAccount.create({
        email: DUPLICATE_EMAIL,
      });
      const second = await before.nodes.GateAccount.create({
        email: DUPLICATE_EMAIL,
      });
      await before.nodes.GateAccount.delete(first.id);
      await before.nodes.GateAccount.delete(second.id);

      const [store] = await createAdapterStoreWithSchema(
        accountGraph(id, "kind"),
        context.getBackend(),
      );

      expect(await activeVersion(context, id)).toBe(2);
      await store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });
      await expect(
        store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });

    it("drops a unique constraint from a populated kind", async () => {
      const id = "uniqueness_gate_drop";
      const store = await context.createStore(accountGraph(id, "kind"));
      await store.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });

      await createAdapterStoreWithSchema(
        accountGraph(id, "none"),
        context.getBackend(),
      );

      expect(await activeVersion(context, id)).toBe(2);
    });

    it("refuses rolling back to a version that declares a unique constraint the populated kind lacks", async () => {
      const id = "uniqueness_gate_rollback";
      await context.createStore(accountGraph(id, "kind"));
      const [relaxed] = await createAdapterStoreWithSchema(
        accountGraph(id, "none"),
        context.getBackend(),
      );
      await relaxed.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });
      await relaxed.nodes.GateAccount.create({ email: DUPLICATE_EMAIL });

      const error = await rollbackSchema(context.getBackend(), id, 1).catch(
        (error_: unknown) => error_,
      );

      expect(gatedConstraints(error)).toEqual([ACCOUNT_CONSTRAINT_ADDED]);
      expect((error as MigrationError).details).toMatchObject({
        fromVersion: 2,
        toVersion: 1,
      });
      expect(await activeVersion(context, id)).toBe(2);
    });
    // MUTATION CHECK: dropping the gate from the tightening preflight
    // reactivates version 1 over two duplicate rows, and this case fails.

    it("rolls back to a version that declares a unique constraint while the kind is empty", async () => {
      const id = "uniqueness_gate_rollback_empty";
      await context.createStore(accountGraph(id, "kind"));
      await createAdapterStoreWithSchema(
        accountGraph(id, "none"),
        context.getBackend(),
      );

      await rollbackSchema(context.getBackend(), id, 1);

      expect(await activeVersion(context, id)).toBe(1);
    });

    it("refuses removing a subClassOf relation that moves a populated kind's claim axis", async () => {
      const id = "uniqueness_gate_axis_split";
      const store = await context.createStore(hierarchyGraph(id, true));
      await store.nodes.GatePerson.create({ email: DUPLICATE_EMAIL });

      const error = await createAdapterStoreWithSchema(
        hierarchyGraph(id, false),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(gatedConstraints(error)).toEqual([PERSON_AXIS_MOVED]);
      expect(await activeVersion(context, id)).toBe(1);
      // Still fenced under the version that stayed active.
      await expect(
        store.nodes.GatePerson.create({ email: DUPLICATE_EMAIL }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });
    // MUTATION CHECK: returning no gate for an unchanged constraint in
    // `uniquenessClaimGates` commits the split; `GatePerson` then probes only
    // its own axis, misses the claim at `GateEmployee`, and accepts a second
    // row with the same email.

    it("refuses the same axis move through migrateSchema", async () => {
      const id = "uniqueness_gate_axis_split_migrate";
      const store = await context.createStore(hierarchyGraph(id, true));
      await store.nodes.GatePerson.create({ email: DUPLICATE_EMAIL });

      const error = await migrateSchema(
        context.getBackend(),
        hierarchyGraph(id, false),
        1,
      ).catch((error_: unknown) => error_);

      expect(gatedConstraints(error)).toEqual([PERSON_AXIS_MOVED]);
      expect(await activeVersion(context, id)).toBe(1);
    });

    it("refuses rolling back to a version whose hierarchy moves a populated kind's claim axis", async () => {
      const id = "uniqueness_gate_axis_split_rollback";
      await context.createStore(hierarchyGraph(id, false));
      const [merged] = await createAdapterStoreWithSchema(
        hierarchyGraph(id, true),
        context.getBackend(),
      );
      await merged.nodes.GatePerson.create({ email: DUPLICATE_EMAIL });

      const error = await rollbackSchema(context.getBackend(), id, 1).catch(
        (error_: unknown) => error_,
      );

      expect(gatedConstraints(error)).toEqual([PERSON_AXIS_MOVED]);
      expect(await activeVersion(context, id)).toBe(2);
    });

    it("removes a subClassOf relation while only the kind that keeps its axis is populated", async () => {
      const id = "uniqueness_gate_axis_split_kept";
      const before = await context.createStore(hierarchyGraph(id, true));
      await before.nodes.GateEmployee.create({ email: DUPLICATE_EMAIL });

      const [store] = await createAdapterStoreWithSchema(
        hierarchyGraph(id, false),
        context.getBackend(),
      );

      // `GateEmployee` wrote at `GateEmployee` and still probes it.
      expect(await activeVersion(context, id)).toBe(2);
      await expect(
        store.nodes.GateEmployee.create({ email: DUPLICATE_EMAIL }),
      ).rejects.toBeInstanceOf(UniquenessError);
    });

    it("keeps existing claims fencing after a subClassOf addition merges the axis", async () => {
      const id = "uniqueness_gate_axis_merge";
      const before = await context.createStore(hierarchyGraph(id, false));
      await before.nodes.GatePerson.create({ email: DUPLICATE_EMAIL });

      const [store] = await createAdapterStoreWithSchema(
        hierarchyGraph(id, true),
        context.getBackend(),
      );

      // The axis moved from `GatePerson` to `GateEmployee`, but the merged
      // component still probes `GatePerson`, where the old claim sits.
      expect(await activeVersion(context, id)).toBe(2);
      await expect(
        store.nodes.GatePerson.create({ email: DUPLICATE_EMAIL }),
      ).rejects.toBeInstanceOf(UniquenessError);
      await expect(
        store.nodes.GateEmployee.create({ email: DUPLICATE_EMAIL }),
      ).rejects.toBeInstanceOf(UniquenessError);
      expect(await store.verifyConstraintFences()).toEqual([]);
    });

    it("refuses removeKinds of the kind a populated hierarchy's claims sit under", async () => {
      const id = "uniqueness_gate_remove_kinds";
      const store = await context.createStore(wholeGraph(id));
      const evolved = await store.evolve(AARDVARK_EXTENSION);
      await evolved.nodes.GateWhole.create({ email: DUPLICATE_EMAIL });

      const error = await evolved
        .removeKinds(["GateAardvark"])
        .catch((error_: unknown) => error_);

      expect(gatedConstraints(error)).toEqual([
        {
          cause: "claim-axis-moved",
          kind: "GateWhole",
          constraintName: "gate_whole_email",
          axis: "GateWhole",
          previousAxis: "GateAardvark",
        },
      ]);
      expect(await activeVersion(context, id)).toBe(2);
    });
    // MUTATION CHECK: dropping the gate lets the removal commit; `GateWhole`
    // then probes only itself and accepts a duplicate of the claimed email.

    it("removes that kind while the hierarchy is empty", async () => {
      const id = "uniqueness_gate_remove_kinds_empty";
      const store = await context.createStore(wholeGraph(id));
      const evolved = await store.evolve(AARDVARK_EXTENSION);

      await evolved.removeKinds(["GateAardvark"]);

      expect(await activeVersion(context, id)).toBe(3);
    });

    it("refuses adding a unique constraint to a populated extension kind through evolve and an adopted plan", async () => {
      const id = "uniqueness_gate_evolve";
      const backend = context.getBackend();
      const [store] = await createAdapterStoreWithSchema(
        hostGraph(id),
        backend,
      );
      const evolved = await store.evolve(taggedExtension(false));
      const tags = evolved.getNodeCollectionOrThrow("GateTag");
      await tags.create({ label: "same" });
      await tags.create({ label: "same" });

      const evolveError = await evolved
        .evolve(taggedExtension(true))
        .catch((error_: unknown) => error_);
      expect(evolveError).toBeInstanceOf(IncompatibleChangeError);
      expect((evolveError as IncompatibleChangeError).changes).toMatchObject([
        { kind: "GateTag", type: "ADD_UNIQUE_ON_POPULATED" },
      ]);

      // The gate and the extension classifier name the same kind, so the plan
      // lists it once, and not as an ontology tightening.
      const plan = await evolved.planEvolution(taggedExtension(true));
      if (plan.status !== "change") throw new Error("Expected a change plan.");
      expect(
        plan.requirements.filter(
          (requirement) =>
            requirement.kind === "require-empty" ||
            requirement.kind === "ontology-tightening",
        ),
      ).toEqual([
        { kind: "require-empty", entity: "node", kindName: "GateTag" },
      ]);
      // A lane that cannot adopt a schema-write transaction refuses the apply
      // before reaching the plan's checks.
      const adoptedRefusal =
        backend.adoptSchemaWriteTransaction === undefined ?
          UnsupportedBackendCapabilityError
        : IncompatibleChangeError;
      const adoptedError = await backend
        .transactionWithNative(async (_target, nativeTx) =>
          evolved.withEvolvedTransaction(nativeTx, plan, async () => {
            await Promise.resolve();
          }),
        )
        .catch((error_: unknown) => error_);
      expect(adoptedError).toBeInstanceOf(adoptedRefusal);
      expect(await activeVersion(context, id)).toBe(2);
    });
    // MUTATION CHECK: dropping the `ADD_UNIQUE_ON_POPULATED` record from
    // `classifyUnique` changes both refusals to the gate's `MigrationError`
    // (the commit is still refused), and this case fails.

    it("refuses with UNIQUE_CONSTRAINT_CHANGE_REQUIRES_ATOMIC_BACKEND when the backend cannot commit a preflight atomically", async () => {
      const id = "uniqueness_gate_capability";
      await context.createStore(accountGraph(id, "none"));
      const restrictedBackend = projectBackendWithout(context.getBackend(), [
        "commitSchemaVersionWithPreflight",
      ]);

      const error = await createAdapterStoreWithSchema(
        accountGraph(id, "kind"),
        restrictedBackend,
      ).catch((error_: unknown) => error_);

      // Refused even though the kind is empty: without the atomic primitive
      // the emptiness probe cannot be bound to the commit it decides.
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).details).toMatchObject({
        code: "UNIQUE_CONSTRAINT_CHANGE_REQUIRES_ATOMIC_BACKEND",
      });
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK: returning `undefined` from
    // `prepareSchemaTighteningPreflight` for a gate-only transition commits
    // through the plain primitive with no probe, and this case fails.

    it("refuses a gated rollback on a backend without setActiveVersionWithPreflight", async () => {
      const id = "uniqueness_gate_rollback_capability";
      await context.createStore(accountGraph(id, "kind"));
      await createAdapterStoreWithSchema(
        accountGraph(id, "none"),
        context.getBackend(),
      );
      const restrictedBackend = projectBackendWithout(context.getBackend(), [
        "setActiveVersionWithPreflight",
      ]);

      const error = await rollbackSchema(restrictedBackend, id, 1).catch(
        (error_: unknown) => error_,
      );

      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).details).toMatchObject({
        code: "UNIQUE_CONSTRAINT_CHANGE_REQUIRES_ATOMIC_BACKEND",
      });
      expect(await activeVersion(context, id)).toBe(2);
    });
  });
}
