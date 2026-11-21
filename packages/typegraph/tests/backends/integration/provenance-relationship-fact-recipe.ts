/**
 * The "Relationship as a fact node" recipe in the provenance guide
 * (apps/docs/src/content/docs/provenance.md), run against every backend so the
 * documented shape and every read the guide describes cannot drift from what
 * the store does. Keep the graph, the capability config and
 * `recordEmployment` below identical to the documented blocks.
 *
 * Only the public surface is used: the root entry point and the
 * `@nicia-ai/typegraph/provenance` subpath.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CardinalityError,
  count,
  defineEdge,
  defineGraph,
  defineNode,
  field,
  type Node,
  UniquenessError,
} from "../../../src";
import { createRetractionCapability } from "../../../src/provenance";
import type { HistoryStore } from "../../../src/store/store";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

// --- The documented graph -------------------------------------------------

const Person = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});

const Organization = defineNode("Organization", {
  schema: z.object({ name: z.string() }),
});

const Employment = defineNode("Employment", {
  schema: z.object({
    organizationId: z.string(),
    role: z.string(),
    startedOn: z.string(),
    endedOn: z.string().optional(),
  }),
});

const Source = defineNode("Source", {
  schema: z.object({
    label: z.string(),
    retracted: z.boolean().default(false),
  }),
});

const Justification = defineNode("Justification", {
  schema: z.object({ rule: z.string() }),
});

const heldRole = defineEdge("heldRole");
const atOrganization = defineEdge("atOrganization");
const premiseOf = defineEdge("premiseOf");
const derives = defineEdge("derives");

const graph = defineGraph({
  id: "employment_facts",
  nodes: {
    Person: { type: Person },
    Organization: { type: Organization },
    Employment: {
      type: Employment,
      unique: [
        {
          name: "one_current_holder",
          fields: ["organizationId", "role"],
          // The docs write `props.endedOn.isNull()`; this repo compiles with
          // `noPropertyAccessFromIndexSignature`, so the test indexes it.
          where: (props) => requireDefined(props["endedOn"]).isNull(),
          scope: "kind",
          collation: "binary",
        },
      ],
    },
    Source: { type: Source },
    Justification: { type: Justification },
  },
  edges: {
    heldRole: {
      type: heldRole,
      from: [Person],
      to: [Employment],
      targetCardinality: "one",
    },
    atOrganization: {
      type: atOrganization,
      from: [Employment],
      to: [Organization],
      cardinality: "one",
    },
    premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Employment] },
  },
});

const provenanceConfig = {
  source: { kind: "Source" },
  justification: { kind: "Justification" },
  fact: { kinds: ["Employment"] },
  premiseOf: { kind: "premiseOf" },
  derives: { kind: "derives" },
} as const;

type EmploymentStore = HistoryStore<typeof graph>;

/**
 * Not documented as a pattern: the same kinds with "one current employment
 * per person" put on the edge instead of the node, to show what the guide
 * warns about.
 */
const perPersonCardinalityGraph = defineGraph({
  id: "employment_facts_edge_cardinality",
  nodes: {
    Person: { type: Person },
    Employment: { type: Employment },
    Source: { type: Source },
    Justification: { type: Justification },
  },
  edges: {
    heldRole: {
      type: heldRole,
      from: [Person],
      to: [Employment],
      cardinality: "oneActive",
    },
    premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
    derives: { type: derives, from: [Justification], to: [Employment] },
  },
});

async function recordEmployment(
  store: EmploymentStore,
  person: Node<typeof Person>,
  organization: Node<typeof Organization>,
  stint: Readonly<{ role: string; startedOn: string; endedOn?: string }>,
  sources: readonly Node<typeof Source>[],
): Promise<Node<typeof Employment>> {
  return store.transaction(async (tx) => {
    const employment = await tx.nodes.Employment.create({
      organizationId: organization.id,
      ...stint,
    });
    await tx.edges.heldRole.create(person, employment, {});
    await tx.edges.atOrganization.create(employment, organization, {});
    for (const source of sources) {
      const justification = await tx.nodes.Justification.create({
        rule: `reported by ${source.label}`,
      });
      await tx.edges.premiseOf.create(source, justification, {});
      await tx.edges.derives.create(justification, employment, {});
    }
    return employment;
  });
}

/**
 * The shape the guide warns against: the relationship stays a plain edge and
 * its provenance sits on a claim node beside it.
 */
const EmploymentClaim = defineNode("EmploymentClaim", {
  schema: z.object({ statement: z.string() }),
});
const worksAt = defineEdge("worksAt");

const claimBesideEdgeGraph = defineGraph({
  id: "employment_claim_beside_edge",
  nodes: {
    Person: { type: Person },
    Organization: { type: Organization },
    EmploymentClaim: { type: EmploymentClaim },
    Source: { type: Source },
    Justification: { type: Justification },
  },
  edges: {
    worksAt: { type: worksAt, from: [Person], to: [Organization] },
    premiseOf: { type: premiseOf, from: [Source], to: [Justification] },
    derives: {
      type: derives,
      from: [Justification],
      to: [EmploymentClaim],
    },
  },
});

// --- Test helpers ---------------------------------------------------------

/** The documented traversal: person -> Employment -> organization. */
async function employmentsOf(
  store: EmploymentStore,
  person: Node<typeof Person>,
) {
  return store
    .query()
    .from("Person", "person")
    .whereNode("person", (fields) => fields.id.eq(person.id))
    .traverse("heldRole", "held")
    .to("Employment", "employment")
    .traverse("atOrganization", "at")
    .to("Organization", "organization")
    .select((ctx) => ({
      employmentId: ctx.employment.id,
      role: ctx.employment.role,
      organization: ctx.organization.name,
    }))
    .execute();
}

function idsOf(rows: readonly Readonly<{ id: string }>[]): string[] {
  return rows
    .map((row) => row.id)
    .toSorted((left, right) => left.localeCompare(right));
}

async function seed(context: IntegrationTestContext) {
  const store = await context.createHistoryStore(graph);
  const provenance = createRetractionCapability(store, provenanceConfig);
  const ada = await store.nodes.Person.create({ name: "Ada" });
  const acme = await store.nodes.Organization.create({ name: "Acme" });
  const registry = await store.nodes.Source.create({ label: "registry" });
  return { store, provenance, ada, acme, registry };
}

export function registerProvenanceRelationshipFactRecipeTests(
  context: IntegrationTestContext,
): void {
  describe("provenance recipe: a relationship as a fact node", () => {
    it("closing the Employment fact leaves its heldRole and atOrganization edges live, pointing at the closed node", async () => {
      const { store, provenance, ada, acme, registry } = await seed(context);
      const employment = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Engineer", startedOn: "2024-01-01" },
        [registry],
      );
      const [held] = await store.edges.heldRole.findFrom(ada);
      const [at] = await store.edges.atOrganization.findFrom(employment);
      const heldId = requireDefined(held).id;
      const atId = requireDefined(at).id;

      const report = await provenance.retract(registry);

      expect(report.died).toEqual([{ kind: "Employment", id: employment.id }]);
      expect(report.survivedVia).toEqual([]);
      expect(
        await store.nodes.Employment.getById(employment.id),
      ).toBeUndefined();
      // The node is a tombstone, not gone.
      const tombstone = await store.nodes.Employment.getById(employment.id, {
        temporalMode: "includeTombstones",
      });
      expect(tombstone?.meta.deletedAt).toBeDefined();
      // Both edges are untouched: still live, still pointing at the node.
      const heldAfter = await store.edges.heldRole.getById(heldId);
      const atAfter = await store.edges.atOrganization.getById(atId);
      expect(heldAfter?.meta.deletedAt).toBeUndefined();
      expect(heldAfter?.toId).toBe(employment.id);
      expect(atAfter?.meta.deletedAt).toBeUndefined();
      expect(atAfter?.fromId).toBe(employment.id);
    });

    it("after a retraction, reads through the fact node drop it while the edge collections still return its edges", async () => {
      const { store, provenance, ada, acme, registry } = await seed(context);
      const employment = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Engineer", startedOn: "2024-01-01" },
        [registry],
      );
      expect(await employmentsOf(store, ada)).toEqual([
        {
          employmentId: employment.id,
          role: "Engineer",
          organization: "Acme",
        },
      ]);

      await provenance.retract(registry);

      // Through the fact node: gone.
      expect(await employmentsOf(store, ada)).toEqual([]);
      const firstHop = await store
        .query()
        .from("Person", "person")
        .traverse("heldRole", "held")
        .to("Employment", "employment")
        .select((ctx) => ({ id: ctx.employment.id }))
        .execute();
      expect(firstHop).toEqual([]);
      const optional = await store
        .query()
        .from("Person", "person")
        .optionalTraverse("heldRole", "held")
        .to("Employment", "employment")
        .select((ctx) => ({
          person: ctx.person.name,
          held: ctx.held?.id,
          employment: ctx.employment?.id,
        }))
        .execute();
      expect(optional).toEqual([
        { person: "Ada", held: undefined, employment: undefined },
      ]);
      const perOrganization = await store
        .query()
        .from("Organization", "organization")
        .traverse("atOrganization", "at", { direction: "in" })
        .to("Employment", "employment")
        .groupBy("organization", "name")
        .aggregate({
          organization: field("organization", "name"),
          employments: count("at"),
        })
        .execute();
      expect(perOrganization).toEqual([]);
      expect(await store.countNeighbors(ada, { edges: ["heldRole"] })).toBe(0);
      expect(await provenance.holding()).toEqual([]);
      expect(await store.nodes.Employment.count()).toBe(0);

      // The edge collections alone: the edges are still there.
      expect(await store.edges.heldRole.find()).toHaveLength(1);
      expect(await store.edges.heldRole.findFrom(ada)).toHaveLength(1);
      expect(await store.edges.heldRole.findTo(employment)).toHaveLength(1);
      expect(await store.edges.atOrganization.findTo(acme)).toHaveLength(1);
      expect(await store.edges.heldRole.count()).toBe(1);
      expect(await store.edges.atOrganization.count({ to: acme })).toBe(1);

      // A tombstone-inclusive query shows the closed fact and when it closed.
      const audit = await store
        .query()
        .from("Person", "person")
        .traverse("heldRole", "held")
        .to("Employment", "employment")
        .temporal("includeTombstones")
        .select((ctx) => ({
          id: ctx.employment.id,
          closedAt: ctx.employment.meta.deletedAt,
        }))
        .execute();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.id).toBe(employment.id);
      expect(audit[0]?.closedAt).toBeDefined();
    });

    it("unRetract reopens the fact and every read returns what it returned before the retraction", async () => {
      const { store, provenance, ada, acme, registry } = await seed(context);
      const employment = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Engineer", startedOn: "2024-01-01" },
        [registry],
      );
      await provenance.retract(registry);

      const report = await provenance.unRetract(registry);

      expect(report.died).toEqual([]);
      expect(idsOf(await provenance.holding())).toEqual([employment.id]);
      expect(await employmentsOf(store, ada)).toEqual([
        {
          employmentId: employment.id,
          role: "Engineer",
          organization: "Acme",
        },
      ]);
      const reopened = await store.nodes.Employment.getById(employment.id);
      expect(reopened?.meta.deletedAt).toBeUndefined();
      expect(reopened?.role).toBe("Engineer");
      expect(await store.edges.heldRole.findFrom(ada)).toHaveLength(1);
      expect(await store.edges.atOrganization.findTo(acme)).toHaveLength(1);
      expect(await store.edges.heldRole.count()).toBe(1);
      expect(await store.countNeighbors(ada, { edges: ["heldRole"] })).toBe(1);
    });

    it("two stints at the same organization are two facts: retracting one source leaves the other", async () => {
      const { store, provenance, ada, acme, registry } = await seed(context);
      const press = await store.nodes.Source.create({ label: "press" });
      const first = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Engineer", startedOn: "2019-01-01", endedOn: "2021-06-30" },
        [registry],
      );
      const second = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Engineer", startedOn: "2023-03-01" },
        [press],
      );

      const report = await provenance.retract(registry);

      expect(report.died).toEqual([{ kind: "Employment", id: first.id }]);
      expect(idsOf(await provenance.holding())).toEqual([second.id]);
      expect(await employmentsOf(store, ada)).toEqual([
        { employmentId: second.id, role: "Engineer", organization: "Acme" },
      ]);
      // The edge collection still counts both stints' edges.
      expect(await store.edges.heldRole.findFrom(ada)).toHaveLength(2);
    });

    it("a fact with two justifications survives one source's retraction and names the survivor in survivedVia", async () => {
      const { store, provenance, ada, acme, registry } = await seed(context);
      const employment = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Engineer", startedOn: "2024-01-01" },
        [registry],
      );
      // The documented snippet, step for step.
      const press = await store.nodes.Source.create({ label: "press" });
      const confirmed = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Advisor", startedOn: "2025-01-01" },
        [registry, press],
      );
      const pressJustifications = await store
        .query()
        .from("Source", "source")
        .whereNode("source", (fields) => fields.id.eq(press.id))
        .traverse("premiseOf", "premise")
        .to("Justification", "justification")
        .select((ctx) => ({ id: ctx.justification.id }))
        .execute();

      const report = await provenance.retract(registry);

      expect(report.died).toEqual([{ kind: "Employment", id: employment.id }]);
      expect(report.survivedVia).toEqual([
        {
          fact: { kind: "Employment", id: confirmed.id },
          via: [{ kind: "Justification", id: pressJustifications[0]?.id }],
        },
      ]);
      expect(await employmentsOf(store, ada)).toEqual([
        { employmentId: confirmed.id, role: "Advisor", organization: "Acme" },
      ]);

      const second = await provenance.retract(press);
      expect(second.died).toEqual([{ kind: "Employment", id: confirmed.id }]);
      expect(await employmentsOf(store, ada)).toEqual([]);
    });

    it("one current holder per role: the uniqueness constraint on the fact node refuses a second, and a close or an end frees the seat", async () => {
      const { store, provenance, ada, acme, registry } = await seed(context);
      const grace = await store.nodes.Person.create({ name: "Grace" });
      const press = await store.nodes.Source.create({ label: "press" });
      const adaAsChair = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Chair", startedOn: "2024-01-01" },
        [registry],
      );

      // A second current Chair at Acme is refused, and the transaction that
      // tried it leaves nothing behind.
      await expect(
        recordEmployment(
          store,
          grace,
          acme,
          { role: "Chair", startedOn: "2024-06-01" },
          [press],
        ),
      ).rejects.toThrow(UniquenessError);
      expect(await store.nodes.Employment.count()).toBe(1);
      expect(await store.nodes.Justification.count()).toBe(1);
      expect(await store.edges.heldRole.count()).toBe(1);
      // Ended stints sit outside the `where`, so history does not hold the seat.
      await recordEmployment(
        store,
        grace,
        acme,
        { role: "Chair", startedOn: "2020-01-01", endedOn: "2023-12-31" },
        [press],
      );

      // Retracting the fact closes it and frees the seat for a new holder.
      await provenance.retract(registry);
      const graceAsChair = await recordEmployment(
        store,
        grace,
        acme,
        { role: "Chair", startedOn: "2024-06-01" },
        [press],
      );

      // Reopening the old holder would now break the constraint: unRetract
      // is refused and the whole transition rolls back, source flag included.
      await expect(provenance.unRetract(registry)).rejects.toThrow(
        UniquenessError,
      );
      const source = await store.nodes.Source.getById(registry.id);
      expect(source?.retracted).toBe(true);
      expect(
        await store.nodes.Employment.getById(adaAsChair.id),
      ).toBeUndefined();

      // Ending the current stint frees the seat; the old fact can reopen.
      await store.nodes.Employment.update(graceAsChair.id, {
        endedOn: "2024-12-31",
      });
      const report = await provenance.unRetract(registry);
      expect(report.died).toEqual([]);
      const reopened = await store.nodes.Employment.getById(adaAsChair.id);
      expect(reopened?.role).toBe("Chair");
    });

    it("edge cardinality bounds each fact's own shape: one holder and one organization per Employment", async () => {
      const { store, provenance, ada, acme, registry } = await seed(context);
      const grace = await store.nodes.Person.create({ name: "Grace" });
      const globex = await store.nodes.Organization.create({ name: "Globex" });
      const employment = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Engineer", startedOn: "2024-01-01" },
        [registry],
      );

      await expect(
        store.edges.heldRole.create(grace, employment, {}),
      ).rejects.toThrow(CardinalityError);
      await expect(
        store.edges.atOrganization.create(employment, globex, {}),
      ).rejects.toThrow(CardinalityError);

      // A new edge onto the closed fact is refused on every backend. Which
      // error says so is backend-dependent (a CardinalityError on SQLite, an
      // EndpointNotFoundError on PostgreSQL), so only the refusal is pinned.
      await provenance.retract(registry);
      await expect(
        store.edges.heldRole.create(grace, employment, {}),
      ).rejects.toThrow();
      expect(await store.edges.heldRole.findTo(employment)).toHaveLength(1);
    });

    it("a per-person edge cardinality keeps counting a closed fact's live edge, so it cannot say 'current'", async () => {
      const store = await context.createHistoryStore(perPersonCardinalityGraph);
      const provenance = createRetractionCapability(store, provenanceConfig);
      const ada = await store.nodes.Person.create({ name: "Ada" });
      const registry = await store.nodes.Source.create({ label: "registry" });
      const first = await store.nodes.Employment.create({
        organizationId: "acme",
        role: "Engineer",
        startedOn: "2024-01-01",
      });
      await store.edges.heldRole.create(ada, first, {});
      const justification = await store.nodes.Justification.create({
        rule: "reported by registry",
      });
      await store.edges.premiseOf.create(registry, justification, {});
      await store.edges.derives.create(justification, first, {});
      const second = await store.nodes.Employment.create({
        organizationId: "globex",
        role: "Engineer",
        startedOn: "2025-01-01",
      });

      await expect(
        store.edges.heldRole.create(ada, second, {}),
      ).rejects.toThrow(CardinalityError);

      const report = await provenance.retract(registry);
      expect(report.died).toEqual([{ kind: "Employment", id: first.id }]);
      // The first Employment is closed, but its heldRole edge is live and
      // open-ended, so Ada's one `oneActive` slot is still taken.
      await expect(
        store.edges.heldRole.create(ada, second, {}),
      ).rejects.toThrow(CardinalityError);
    });

    it("recorded time shows the fact and its traversal before the retraction, and neither after it", async () => {
      const { store, provenance, ada, acme, registry } = await seed(context);
      const employment = await recordEmployment(
        store,
        ada,
        acme,
        { role: "Engineer", startedOn: "2024-01-01" },
        [registry],
      );
      const [held] = await store.edges.heldRole.findFrom(ada);
      const before = await store.recordedNow();
      await provenance.retract(registry);
      const after = await store.recordedNow();
      if (before === undefined || after === undefined) {
        throw new Error("a history store reports recorded time");
      }

      const believed = store.asOfRecorded(before);
      const retracted = store.asOfRecorded(after);

      const believedEmployment = await believed.nodes.Employment.getById(
        employment.id,
      );
      expect(believedEmployment?.role).toBe("Engineer");
      expect(
        await retracted.nodes.Employment.getById(employment.id),
      ).toBeUndefined();

      async function traversal(view: typeof believed) {
        return view
          .query()
          .from("Person", "person")
          .traverse("heldRole", "held")
          .to("Employment", "employment")
          .traverse("atOrganization", "at")
          .to("Organization", "organization")
          .select((ctx) => ({
            employmentId: ctx.employment.id,
            organization: ctx.organization.name,
          }))
          .execute();
      }
      expect(await traversal(believed)).toEqual([
        { employmentId: employment.id, organization: "Acme" },
      ]);
      expect(await traversal(retracted)).toEqual([]);

      // The edge is live at both instants.
      const heldBefore = await believed.edges.heldRole.getById(
        requireDefined(held).id,
      );
      const heldAfter = await retracted.edges.heldRole.getById(
        requireDefined(held).id,
      );
      expect(heldBefore?.toId).toBe(employment.id);
      expect(heldAfter?.toId).toBe(employment.id);
    });

    it("a claim node kept beside a live edge: retraction closes the claim and the edge still answers every query", async () => {
      const store = await context.createHistoryStore(claimBesideEdgeGraph);
      const provenance = createRetractionCapability(store, {
        ...provenanceConfig,
        fact: { kinds: ["EmploymentClaim"] },
      });
      const ada = await store.nodes.Person.create({ name: "Ada" });
      const acme = await store.nodes.Organization.create({ name: "Acme" });
      const registry = await store.nodes.Source.create({ label: "registry" });
      await store.edges.worksAt.create(ada, acme, {});
      const claim = await store.nodes.EmploymentClaim.create({
        statement: "Ada works at Acme",
      });
      const justification = await store.nodes.Justification.create({
        rule: "reported by registry",
      });
      await store.edges.premiseOf.create(registry, justification, {});
      await store.edges.derives.create(justification, claim, {});

      const report = await provenance.retract(registry);

      expect(report.died).toEqual([{ kind: "EmploymentClaim", id: claim.id }]);
      const employers = await store
        .query()
        .from("Person", "person")
        .traverse("worksAt", "works")
        .to("Organization", "organization")
        .select((ctx) => ({
          person: ctx.person.name,
          organization: ctx.organization.name,
        }))
        .execute();
      expect(employers).toEqual([{ person: "Ada", organization: "Acme" }]);
    });
  });
}
