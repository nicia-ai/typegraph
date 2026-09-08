/**
 * Cross-backend contract for ontology change classification with
 * data-validated tightening (roadmap §3.A).
 *
 * The preflight path (`createSchemaVersionMembers`) is dialect-agnostic, so
 * there is deliberately no per-dialect file here — a SQLite-only or
 * PG-only test would certify nothing the shared suite does not. Every case
 * states, in its own comment, the mutation that must make it fail; the
 * revert/mutation checks actually performed are recorded in the scratchpad
 * `lane-A-load-bearing.md` note.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createAdapterStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  disjointWith,
  inverseOf,
  MigrationError,
  subClassOf,
} from "../../../src";
import {
  deriveBackend,
  projectBackendWithout,
} from "../../../src/backend/derive-backend";
import { type AdapterBackend } from "../../../src/backend/types";
import { computeUniqueKey } from "../../../src/constraints";
import { buildKindRegistry } from "../../../src/registry";
import { getActiveSchema, migrateSchema } from "../../../src/schema";
import {
  DISJOINT_CONSTRAINT_NAME,
  disjointnessClaimAxis,
} from "../../../src/store/claims/axis";
import { requireDefined } from "../../../src/utils/presence";
import { matchingObject } from "../../test-utils";
import { type IntegrationTestContext } from "./test-context";

const Person = defineNode("Person", { schema: z.object({}) });
const Company = defineNode("Company", { schema: z.object({}) });
const Organization = defineNode("Organization", { schema: z.object({}) });
const worksFor = defineEdge("worksFor", { schema: z.object({}) });

/**
 * A subClassOf/disjointWith relation between these two never changes across
 * a test's before/after graphs. `serializeOntology` derives a schema's
 * `metaEdges` dict from the meta-edges its surviving RELATIONS actually
 * reference, so removing the only relation that names a meta-edge also
 * removes the meta-edge itself — an unrelated, pre-existing `breaking`
 * change ("meta-edge removed") that would otherwise mask the relation-level
 * classification these tests are about. Keeping one relation of each
 * meta-edge alive on both sides isolates the assertion to the relation this
 * test actually adds or removes.
 */
const Bystander = defineNode("Bystander", { schema: z.object({}) });
const OtherBystander = defineNode("OtherBystander", { schema: z.object({}) });

const SIBLING_EMAIL_UNIQUE = {
  name: "sibling_email_unique",
  fields: ["email"],
  scope: "kindWithSubClasses",
  collation: "binary",
} as const;
const SiblingA = defineNode("SiblingA", {
  schema: z.object({ email: z.string() }),
});
const SiblingB = defineNode("SiblingB", {
  schema: z.object({ email: z.string() }),
});

async function activeVersion(
  context: IntegrationTestContext,
  id: string,
): Promise<number> {
  const active = await getActiveSchema(context.getBackend(), id);
  return requireDefined(active, "active schema").version;
}

/**
 * Wraps `backend.commitSchemaVersionWithPreflight` so the preflight closure
 * runs against a target lacking `readConstraintFenceViolations` — the
 * shape a custom port takes, never a spread copy (`src/backend/derive-backend.ts`).
 */
function withoutFenceAudit(
  backend: AdapterBackend<unknown>,
): AdapterBackend<unknown> {
  const commitWithPreflight = requireDefined(
    backend.commitSchemaVersionWithPreflight,
  );
  return deriveBackend(backend, {
    commitSchemaVersionWithPreflight: (params, preflight) =>
      commitWithPreflight(params, (target) =>
        preflight(
          projectBackendWithout(target, ["readConstraintFenceViolations"]),
        ),
      ),
  });
}

/** v1 = `subClassOf(Company, Organization)`; v2 additionally declares `disjointWith(Person, Organization)`. */
function probeGraph(id: string, withDisjoint: boolean) {
  return defineGraph({
    id,
    nodes: {
      Person: { type: Person },
      Company: { type: Company },
      Organization: { type: Organization },
    },
    edges: {},
    ontology: [
      subClassOf(Company, Organization),
      ...(withDisjoint ? [disjointWith(Person, Organization)] : []),
    ],
  });
}

export function registerOntologyTighteningIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("ontology change classification with data-validated tightening", () => {
    it("refuses a disjointWith addition existing rows already violate (the roadmap probe)", async () => {
      const id = "ontology_tightening_probe";
      const store = await context.createStore(probeGraph(id, false));
      await store.nodes.Person.create({}, { id: "shared" });
      await store.nodes.Company.create({}, { id: "shared" });

      const v2 = probeGraph(id, true);
      const registry = buildKindRegistry(v2);

      const error = await createAdapterStoreWithSchema(
        v2,
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      expect(details.violations).toEqual([
        {
          family: "nodeDisjointness",
          target: {
            relation: "uniques",
            graphId: id,
            axis: disjointnessClaimAxis("Company", "Person", registry),
            constraintName: DISJOINT_CONSTRAINT_NAME,
            key: "shared",
          },
          owners: [
            { concreteKind: "Company", nodeId: "shared" },
            { concreteKind: "Person", nodeId: "shared" },
          ],
        },
      ]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK (lane-A-load-bearing.md): this case fails against
    // today's `main` (the commit migrates instead of refusing) and fails
    // again when the classifier's `disjointWith`-added row is flipped to
    // "safe".

    it("refuses the same tightening through Store.evolve()", async () => {
      const id = "ontology_tightening_evolve_twin";
      const store = await context.createStore(probeGraph(id, false));
      await store.nodes.Person.create({}, { id: "shared" });
      await store.nodes.Company.create({}, { id: "shared" });

      await expect(
        store.evolve(
          defineGraphExtension({
            ontology: [
              { metaEdge: "disjointWith", from: "Person", to: "Organization" },
            ],
          }),
        ),
      ).rejects.toMatchObject({
        name: "MigrationError",
        details: matchingObject({ reason: "ontology-tightening-violated" }),
      });
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK (lane-A-load-bearing.md): removing the
    // `ontologyPreflight` step from `Store.evolve`'s composed callback makes
    // the evolve succeed and this test fail.

    it("refuses a subClassOf removal a live edge's endpoint relies on", async () => {
      const id = "ontology_tightening_endpoint_shrink";
      const graphWith = (withSubClass: boolean) =>
        defineGraph({
          id,
          nodes: {
            Person: { type: Person },
            Company: { type: Company },
            Organization: { type: Organization },
            Bystander: { type: Bystander },
            OtherBystander: { type: OtherBystander },
          },
          edges: {
            worksFor: { type: worksFor, from: [Person], to: [Organization] },
          },
          ontology: [
            subClassOf(Bystander, OtherBystander),
            ...(withSubClass ? [subClassOf(Company, Organization)] : []),
          ],
        });

      const store = await context.createStore(graphWith(true));
      const person = await store.nodes.Person.create({});
      const company = await store.nodes.Company.create({});
      // Written through the backend directly: Company is only assignable to
      // `worksFor`'s declared `to: [Organization]` via the live subClassOf
      // relation, which the compile-time edge-collection types cannot
      // express — this is the exact shape the removal below invalidates.
      const edgeRow = await store.backend.insertEdge({
        graphId: id,
        id: "shrink-endpoint-edge",
        kind: "worksFor",
        fromKind: "Person",
        fromId: person.id,
        toKind: "Company",
        toId: company.id,
        props: {},
      });

      const error = await createAdapterStoreWithSchema(
        graphWith(false),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      expect(details.violations).toEqual([
        {
          family: "edgeEndpointAssignability",
          edgeKind: "worksFor",
          allowedPairs: [["Person", "Organization"]],
          edges: [
            {
              edgeKind: "worksFor",
              edgeId: edgeRow.id,
              fromKind: "Person",
              fromId: person.id,
              toKind: "Company",
              toId: company.id,
            },
          ],
        },
      ]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK (lane-A-load-bearing.md): dropping
    // `edgeEndpointAllowances` from the probe plan makes the commit succeed
    // and this test fail.

    it("refuses a subClassOf addition that merges two duplicate-holding uniqueness components", async () => {
      const id = "ontology_tightening_uniqueness_merge";
      const graphWith = (merged: boolean) =>
        defineGraph({
          id,
          nodes: {
            SiblingA: { type: SiblingA, unique: [SIBLING_EMAIL_UNIQUE] },
            SiblingB: { type: SiblingB, unique: [SIBLING_EMAIL_UNIQUE] },
          },
          edges: {},
          ontology: merged ? [subClassOf(SiblingA, SiblingB)] : [],
        });

      const store = await context.createStore(graphWith(false));
      const nodeA = await store.nodes.SiblingA.create({
        email: "dup@example.com",
      });
      const nodeB = await store.nodes.SiblingB.create({
        email: "dup@example.com",
      });

      const error = await createAdapterStoreWithSchema(
        graphWith(true),
        context.getBackend(),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      expect(details.violations).toEqual([
        {
          family: "nodeUniqueness",
          target: {
            relation: "uniques",
            graphId: id,
            axis: "SiblingA",
            constraintName: "sibling_email_unique",
            key: computeUniqueKey(
              { email: "dup@example.com" },
              ["email"],
              "binary",
            ),
          },
          owners: [
            { concreteKind: "SiblingA", nodeId: nodeA.id },
            { concreteKind: "SiblingB", nodeId: nodeB.id },
          ],
        },
      ]);
      expect(await activeVersion(context, id)).toBe(1);
    });
    // MUTATION CHECK (lane-A-load-bearing.md): dropping the
    // `nodeUniquenessComponent` probe makes the commit succeed and this
    // test fail.

    it("classifies an added inverseOf relation as breaking, blocking auto-migrate", async () => {
      const id = "ontology_tightening_inverse_breaking";
      const likes = defineEdge("likes", { schema: z.object({}) });
      const likedBy = defineEdge("likedBy", { schema: z.object({}) });
      const graphWith = (withInverse: boolean) =>
        defineGraph({
          id,
          nodes: { Person: { type: Person } },
          edges: {
            likes: { type: likes, from: [Person], to: [Person] },
            likedBy: { type: likedBy, from: [Person], to: [Person] },
          },
          ontology: withInverse ? [inverseOf(likes, likedBy)] : [],
        });
      await context.createStore(graphWith(false));
      const v2 = graphWith(true);

      const error = await createAdapterStoreWithSchema(
        v2,
        context.getBackend(),
      ).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "breaking-change") {
        throw new Error(`expected breaking-change, got ${details.reason}`);
      }
      expect(await activeVersion(context, id)).toBe(1);

      await migrateSchema(
        context.getBackend(),
        v2,
        await activeVersion(context, id),
      );
      expect(await activeVersion(context, id)).toBe(2);
    });
    // MUTATION CHECK (lane-A-load-bearing.md): setting the `inverseOf` row
    // to "warning" makes the first half of this test fail (auto-migrate
    // would succeed instead of throwing `breaking-change`).

    it("still auto-migrates a clean tightening", async () => {
      const id = "ontology_tightening_clean";
      const graphWith = (withSubClass: boolean, withDisjoint: boolean) =>
        defineGraph({
          id,
          nodes: {
            Person: { type: Person },
            Company: { type: Company },
            Organization: { type: Organization },
          },
          edges: {
            worksFor: { type: worksFor, from: [Person], to: [Organization] },
          },
          ontology: [
            ...(withSubClass ? [subClassOf(Company, Organization)] : []),
            ...(withDisjoint ? [disjointWith(Person, Organization)] : []),
          ],
        });

      const store = await context.createStore(graphWith(true, false));
      const person = await store.nodes.Person.create({});
      const organization = await store.nodes.Organization.create({});
      await store.edges.worksFor.create(person, organization, {});

      const [evolvedStore, result] = await createAdapterStoreWithSchema(
        graphWith(true, true),
        context.getBackend(),
      );
      expect(result.status).toBe("migrated");
      expect(await activeVersion(context, id)).toBe(2);
      expect(await evolvedStore.verifyConstraintFences()).toEqual([]);
    });
    // MUTATION CHECK (lane-A-load-bearing.md): making the preflight throw
    // unconditionally makes this test fail (status would never reach
    // "migrated").

    it("still auto-migrates removing a disjointWith declaration with existing conflicts", async () => {
      const id = "ontology_tightening_disjoint_removal_safe";
      const graphWith = (withDisjoint: boolean) =>
        defineGraph({
          id,
          nodes: {
            Person: { type: Person },
            Organization: { type: Organization },
            Bystander: { type: Bystander },
            OtherBystander: { type: OtherBystander },
          },
          edges: {},
          ontology: [
            disjointWith(Bystander, OtherBystander),
            ...(withDisjoint ? [disjointWith(Person, Organization)] : []),
          ],
        });

      const store = await context.createStore(graphWith(true));
      const person = await store.nodes.Person.create({}, { id: "conflict" });
      // Seeded through the backend directly: the store's own write path
      // enforces the live `disjointWith` declaration and would refuse this.
      await store.backend.insertNode({
        graphId: id,
        kind: "Organization",
        id: person.id,
        props: {},
      });

      const [, result] = await createAdapterStoreWithSchema(
        graphWith(false),
        context.getBackend(),
      );
      expect(result.status).toBe("migrated");
      expect(await activeVersion(context, id)).toBe(2);
    });
    // MUTATION CHECK (lane-A-load-bearing.md): classifying a `disjointWith`
    // removal as "breaking" makes this migration refuse instead of
    // auto-migrating, and the test fails. (Reclassifying it as "warning"
    // alone does not: the `nodeDisjointness` delta is computed from pairs the
    // AFTER registry adds that the BEFORE registry lacks, so a pure removal
    // always folds to an empty probe payload regardless of the severity
    // label, and `ontologyTighteningProbes` drops an empty-payload probe
    // before it ever reaches a preflight.)

    it("lets removeKinds drop an extension kind that participates in disjointWith with live rows on the surviving side", async () => {
      const id = "ontology_tightening_remove_kinds";
      const hostGraph = defineGraph({
        id,
        nodes: { Person: { type: Person } },
        edges: {},
      });
      const store = await context.createStore(hostGraph);
      const evolved = await store.evolve(
        defineGraphExtension({
          nodes: { Widget: { properties: {} } },
          ontology: [
            { metaEdge: "disjointWith", from: "Person", to: "Widget" },
          ],
        }),
      );
      await evolved.nodes.Person.create({});

      const afterRemoval = await evolved.removeKinds(["Widget"]);
      expect(
        afterRemoval.introspect().kinds.map((kind) => kind.name),
      ).not.toContain("Widget");
      expect(await activeVersion(context, id)).toBe(3);
    });

    it("refuses the same probe-1 tightening through migrateSchema directly", async () => {
      const id = "ontology_tightening_via_migrate_schema";
      const store = await context.createStore(probeGraph(id, false));
      await store.nodes.Person.create({}, { id: "shared" });
      await store.nodes.Company.create({}, { id: "shared" });

      const error = await migrateSchema(
        context.getBackend(),
        probeGraph(id, true),
        await activeVersion(context, id),
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(MigrationError);
      const details = (error as MigrationError).details;
      if (details.reason !== "ontology-tightening-violated") {
        throw new Error(
          `expected ontology-tightening-violated, got ${details.reason}`,
        );
      }
      expect(await activeVersion(context, id)).toBe(1);
    });
    // Proves the documented `migrateSchema()` escape hatch is not a path
    // that skips the probe.

    it("refuses with CONSTRAINT_FENCE_AUDIT_UNSUPPORTED when the preflight target cannot run the audit", async () => {
      const id = "ontology_tightening_custom_port_refusal";
      const store = await context.createStore(probeGraph(id, false));
      const shared = await store.nodes.Person.create({}, { id: "shared" });
      await store.nodes.Company.create({}, { id: "shared" });

      const restrictedBackend = withoutFenceAudit(context.getBackend());
      const error = await createAdapterStoreWithSchema(
        probeGraph(id, true),
        restrictedBackend,
      ).catch((error_: unknown) => error_);

      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).details).toMatchObject({
        code: "CONSTRAINT_FENCE_AUDIT_UNSUPPORTED",
      });
      expect(await activeVersion(context, id)).toBe(1);
      // No rows moved: the "shared" id still resolves, unaffected by the
      // refused (and therefore rolled-back) commit.
      expect(await store.nodes.Person.getById(shared.id)).toBeDefined();
    });
    // MUTATION CHECK (lane-A-load-bearing.md): skipping the probe when
    // `readConstraintFenceViolations` is absent from the preflight target
    // (instead of refusing) makes the tightening commit and this test fail.
  });
}
