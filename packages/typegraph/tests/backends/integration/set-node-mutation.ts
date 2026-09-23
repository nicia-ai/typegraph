import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";

import {
  compareAndSetAbsent,
  ConfigurationError,
  defineEdge,
  defineGraph,
  defineNode,
  expr,
  subClassOf,
  ValidationError,
} from "../../../src";
import type {
  CompareAndSetNodeParams,
  GraphBackend,
  UpdateNodeSetParams,
} from "../../../src/backend/types";
import { rowPropsToObject } from "../../../src/backend/types";
import type { QueryAst } from "../../../src/query/ast";
import { compileQuery } from "../../../src/query/compiler";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import type { NodeSetUpdateWork } from "../../../src/store/operations/node-write-pipeline";
import { requireDefined } from "../../../src/utils/presence";
import { integrationTestGraph } from "./fixtures";
import { type IntegrationTestContext } from "./test-context";

function compileCandidateIds(
  graphId: string,
  backend: Pick<
    GraphBackend,
    | "capabilities"
    | "dialect"
    | "fulltextStrategy"
    | "tableNames"
    | "vectorStrategy"
  >,
  ast: QueryAst,
) {
  return compileQuery(ast, graphId, {
    dialect: backend.dialect,
    schema: createSqlSchema(backend.tableNames),
    fulltextStrategy: backend.fulltextStrategy,
    vectorStrategy: backend.vectorStrategy,
    windowFunctions: backend.capabilities.windowFunctions,
  });
}

async function updateNodeSet(
  backend: Pick<GraphBackend, "updateNodeSet">,
  params: UpdateNodeSetParams,
) {
  return requireDefined(backend.updateNodeSet)(params);
}

async function compareAndSetNode(
  backend: Pick<GraphBackend, "compareAndSetNode">,
  params: CompareAndSetNodeParams,
) {
  return requireDefined(backend.compareAndSetNode)(params);
}

/**
 * Shared SQLite/PostgreSQL coverage for the storage primitive that the public
 * set-based Store mutation composes with validation and sidecar maintenance.
 */
export function registerSetNodeMutationIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("set-based node mutation substrate", () => {
    it("keeps guarded and ordinary backend parameters nominally disjoint", () => {
      type CompareAndSetWork = Extract<
        NodeSetUpdateWork,
        { operation: "compareAndSet" }
      >;
      type UpdateWhereWork = Extract<
        NodeSetUpdateWork,
        { operation: "updateWhere" }
      >;
      expectTypeOf<CompareAndSetNodeParams>().not.toExtend<UpdateNodeSetParams>();
      expectTypeOf<UpdateNodeSetParams>().not.toExtend<CompareAndSetNodeParams>();
      expectTypeOf<CompareAndSetWork>().not.toExtend<UpdateWhereWork>();
      expectTypeOf<UpdateWhereWork>().not.toExtend<CompareAndSetWork>();
    });

    it("compareAndSet atomically handles scalar matches, mismatches, and explicit absence", async () => {
      const store = context.getStore();
      type PersonExpected = Parameters<
        typeof store.nodes.Person.compareAndSet
      >[1]["expected"];
      expectTypeOf<{ email: undefined }>().not.toExtend<PersonExpected>();
      const person = await store.nodes.Person.create({
        name: "Guarded",
        age: 40,
        email: "guarded@example.com",
      });

      expect(
        await store.nodes.Person.compareAndSet(person.id, {
          expected: {
            name: "Guarded",
            age: 40,
            email: "guarded@example.com",
          },
          patch: { age: 41 },
        }),
      ).toBe(true);
      expect(
        await store.nodes.Person.compareAndSet(person.id, {
          expected: { age: 40 },
          patch: { age: 42 },
        }),
      ).toBe(false);
      expect(
        await store.nodes.Person.compareAndSet(person.id, {
          expected: { email: "guarded@example.com" },
          patch: { email: undefined },
        }),
      ).toBe(true);
      expect(
        await store.nodes.Person.compareAndSet(person.id, {
          expected: { email: compareAndSetAbsent },
          patch: { age: 42 },
        }),
      ).toBe(true);
      expect(await store.nodes.Person.getById(person.id)).toMatchObject({
        age: 42,
        meta: { version: 4 },
      });
    });

    it("refuses undefined, object, and array expectations before SQL compilation", async () => {
      const store = context.getStore();
      type DocumentExpected = Parameters<
        typeof store.nodes.Document.compareAndSet
      >[1]["expected"];
      expectTypeOf<{
        metadata: { author: string; version: number };
      }>().not.toExtend<DocumentExpected>();
      expectTypeOf<{
        metadata: readonly string[];
      }>().not.toExtend<DocumentExpected>();
      const document = await store.nodes.Document.create({
        title: "Guarded document",
        metadata: { author: "Ada", version: 1 },
      });
      for (const expected of [
        { metadata: undefined },
        { metadata: { version: 1, author: "Ada" } },
        { metadata: ["Ada", 1] },
      ]) {
        await expect(
          store.nodes.Document.compareAndSet(document.id, {
            expected,
            patch: { title: "Updated document" },
          } as never),
        ).rejects.toThrow(
          'compareAndSet() expected property "metadata" must be a JSON scalar or compareAndSetAbsent',
        );
      }
    });

    it("validates refined node schemas on the complete after-image", async () => {
      const Account = defineNode("Account", {
        schema: z
          .object({
            name: z.string(),
            plan: z.enum(["free", "enterprise"]),
            ownerId: z.string().optional(),
          })
          .refine(
            (account) =>
              account.plan !== "enterprise" || account.ownerId !== undefined,
            {
              path: ["ownerId"],
              message: "enterprise accounts need an owner",
            },
          ),
      });
      const store = await context.createStore(
        defineGraph({
          id: "set_update_refined_account",
          nodes: { Account: { type: Account } },
          edges: {},
        }),
      );
      const casSuccess = await store.nodes.Account.create({
        name: "CasSuccess",
        plan: "free",
      });
      const casViolation = await store.nodes.Account.create({
        name: "CasViolation",
        plan: "free",
      });
      const whereSuccess = await store.nodes.Account.create({
        name: "WhereSuccess",
        plan: "free",
      });
      const whereViolation = await store.nodes.Account.create({
        name: "WhereViolation",
        plan: "free",
      });
      const casOwned = await store.nodes.Account.create({
        name: "CasOwned",
        plan: "free",
        ownerId: "rep-1",
      });
      const whereOwned = await store.nodes.Account.create({
        name: "WhereOwned",
        plan: "free",
        ownerId: "rep-1",
      });

      expect(
        await store.nodes.Account.compareAndSet(casSuccess.id, {
          expected: { plan: "free" },
          patch: { plan: "enterprise", ownerId: "rep-3" },
        }),
      ).toBe(true);
      await expect(
        store.nodes.Account.getById(casSuccess.id),
      ).resolves.toMatchObject({
        plan: "enterprise",
        ownerId: "rep-3",
      });

      await expect(
        store.nodes.Account.compareAndSet(casViolation.id, {
          expected: { plan: "free" },
          patch: { plan: "enterprise" },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        store.nodes.Account.getById(casViolation.id),
      ).resolves.toMatchObject({ plan: "free" });

      await expect(
        store.nodes.Account.updateWhere({
          patch: { plan: "enterprise", ownerId: "rep-9" },
          where: (account) => account.name.eq("WhereSuccess"),
        }),
      ).resolves.toEqual({ affectedCount: 1 });
      await expect(
        store.nodes.Account.getById(whereSuccess.id),
      ).resolves.toMatchObject({
        plan: "enterprise",
        ownerId: "rep-9",
      });

      await expect(
        store.nodes.Account.updateWhere({
          patch: { plan: "enterprise" },
          where: (account) => account.name.eq("WhereViolation"),
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        store.nodes.Account.getById(whereViolation.id),
      ).resolves.toMatchObject({ plan: "free" });

      expect(
        await store.nodes.Account.compareAndSet(casOwned.id, {
          expected: { plan: "free" },
          patch: { plan: "enterprise" },
        }),
      ).toBe(true);
      await expect(
        store.nodes.Account.getById(casOwned.id),
      ).resolves.toMatchObject({
        plan: "enterprise",
        ownerId: "rep-1",
      });
      await expect(
        store.nodes.Account.updateWhere({
          patch: { plan: "enterprise" },
          where: (account) => account.name.eq("WhereOwned"),
        }),
      ).resolves.toEqual({ affectedCount: 1 });
      await expect(
        store.nodes.Account.getById(whereOwned.id),
      ).resolves.toMatchObject({
        plan: "enterprise",
        ownerId: "rep-1",
      });
    });

    it("refuses a compare-and-set without a property patch", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const person = await store.nodes.Person.create({
        name: "Alice",
        age: 40,
        email: "alice@example.com",
      });
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.id.eq(person.id))
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      await expect(
        compareAndSetNode(backend, {
          operation: "compareAndSet",
          graphId: store.graphId,
          kind: "Person",
          patch: {},
          candidateIds,
          candidateIdColumn: "person_id",
          expected: { age: { kind: "value", value: 40 } },
        }),
      ).rejects.toThrow(
        "Node compare-and-set requires at least one property patch",
      );
    });

    it("exposes cross-backend property and relationship updates through the Store", async () => {
      const store = context.getStore();
      const acme = await store.nodes.Company.create({
        name: "Acme",
        industry: "technology",
      });
      const bank = await store.nodes.Company.create({
        name: "Bank",
        industry: "finance",
      });
      const alice = await store.nodes.Person.create({
        name: "Alice",
        age: 35,
        email: "alice@example.com",
      });
      const bob = await store.nodes.Person.create({
        name: "Bob",
        age: 35,
        email: "bob@example.com",
      });
      await store.edges.worksAt.create(alice, acme, { role: "engineer" });
      await store.edges.worksAt.create(bob, bank, { role: "engineer" });

      const result = await store.nodes.Person.updateWhere({
        patch: { age: 36, email: undefined },
        where: (person) => person.age.gte(30),
        exists: [
          {
            edgeKind: "worksAt",
            direction: "out",
            relatedKind: "Company",
            whereRelated: (company) =>
              company.field("industry").string().eq("technology"),
          },
        ],
      });

      expect(result).toEqual({ affectedCount: 1 });
      const updatedAlice = requireDefined(
        await store.nodes.Person.getById(alice.id),
      );
      expect(updatedAlice.age).toBe(36);
      expect(updatedAlice).not.toHaveProperty("email");
      expect(await store.nodes.Person.getById(bob.id)).toMatchObject({
        age: 35,
        email: "bob@example.com",
      });
    });

    it("updates candidates selected by a same-store cross-kind property query", async () => {
      const corpus = defineNode("Corpus", {
        schema: z.object({ name: z.string(), state: z.string() }),
      });
      const artifactChunk = defineNode("ArtifactChunk", {
        schema: z.object({ corpusId: z.string(), text: z.string() }),
      });
      const graph = defineGraph({
        id: "update_where_property_candidates",
        nodes: {
          Corpus: { type: corpus },
          ArtifactChunk: { type: artifactChunk },
        },
        edges: {},
      });
      const store = await context.createStore(graph);
      const selected = await store.nodes.Corpus.create({
        name: "selected",
        state: "pending",
      });
      const unselected = await store.nodes.Corpus.create({
        name: "unselected",
        state: "pending",
      });
      await store.nodes.ArtifactChunk.create({
        corpusId: selected.id,
        text: "chunk",
      });

      const candidates = store
        .query()
        .from("Corpus", "corpus")
        .where((expression) =>
          expression.$exists((subquery, outer) =>
            subquery
              .from("ArtifactChunk", "chunk")
              .whereNode("chunk", (_chunk, inner) =>
                expr.eq(inner.chunk.corpusId, outer.corpus.id),
              )
              .project((inner) => ({ id: inner.chunk.id })),
          ),
        )
        // The candidate compiler projects the root id independently of this
        // result selector, so an ordinary projection cannot break the write.
        .select((context) => context.corpus.name);

      await store.nodes.Corpus.updateWhere({
        candidates,
        patch: { state: "processed" },
      });

      await expect(
        store.nodes.Corpus.getById(selected.id),
      ).resolves.toMatchObject({ state: "processed" });
      await expect(
        store.nodes.Corpus.getById(unselected.id),
      ).resolves.toMatchObject({ state: "pending" });
    });

    it("intersects candidate queries with both where and an exists selector", async () => {
      const corpus = defineNode("CandidateCorpus", {
        schema: z.object({ name: z.string(), state: z.string() }),
      });
      const artifactChunk = defineNode("CandidateArtifactChunk", {
        schema: z.object({ corpusId: z.string(), text: z.string() }),
      });
      const reviewer = defineNode("CandidateReviewer", {
        schema: z.object({ name: z.string() }),
      });
      const reviewedBy = defineEdge("candidateReviewedBy", {
        schema: z.object({}),
      });
      const graph = defineGraph({
        id: "update_where_candidate_intersections",
        nodes: {
          CandidateCorpus: { type: corpus },
          CandidateArtifactChunk: { type: artifactChunk },
          CandidateReviewer: { type: reviewer },
        },
        edges: {
          candidateReviewedBy: {
            type: reviewedBy,
            from: [corpus],
            to: [reviewer],
          },
        },
      });
      const store = await context.createStore(graph);
      const approvedReviewer = await store.nodes.CandidateReviewer.create({
        name: "approved",
      });
      const otherReviewer = await store.nodes.CandidateReviewer.create({
        name: "pending review",
      });

      const selected = await store.nodes.CandidateCorpus.create({
        name: "selected",
        state: "pending",
      });
      const wrongState = await store.nodes.CandidateCorpus.create({
        name: "wrong state",
        state: "complete",
      });
      const wrongRelatedNode = await store.nodes.CandidateCorpus.create({
        name: "wrong related node",
        state: "pending",
      });
      const noCandidate = await store.nodes.CandidateCorpus.create({
        name: "no artifact chunk",
        state: "pending",
      });

      for (const candidate of [selected, wrongState, wrongRelatedNode]) {
        await store.nodes.CandidateArtifactChunk.create({
          corpusId: candidate.id,
          text: `chunk for ${candidate.name}`,
        });
      }
      await store.edges.candidateReviewedBy.create(selected, approvedReviewer);
      await store.edges.candidateReviewedBy.create(
        wrongState,
        approvedReviewer,
      );
      await store.edges.candidateReviewedBy.create(
        wrongRelatedNode,
        otherReviewer,
      );
      await store.edges.candidateReviewedBy.create(
        noCandidate,
        approvedReviewer,
      );

      const candidates = store
        .query()
        .from("CandidateCorpus", "corpus")
        .where((expression) =>
          expression.$exists((subquery, outer) =>
            subquery
              .from("CandidateArtifactChunk", "chunk")
              .whereNode("chunk", (_chunk, inner) =>
                expr.eq(inner.chunk.corpusId, outer.corpus.id),
              )
              .project((inner) => ({ id: inner.chunk.id })),
          ),
        )
        .select((query) => query.corpus.name);

      const result = await store.nodes.CandidateCorpus.updateWhere({
        candidates,
        where: (candidate) => candidate.state.eq("pending"),
        exists: [
          {
            edgeKind: "candidateReviewedBy",
            direction: "out",
            relatedKind: "CandidateReviewer",
            whereRelated: (related) =>
              related.field("name").string().eq("approved"),
          },
        ],
        patch: { state: "processed" },
      });

      expect(result).toEqual({ affectedCount: 1 });
      await expect(
        store.nodes.CandidateCorpus.getById(selected.id),
      ).resolves.toMatchObject({ state: "processed" });
      await expect(
        store.nodes.CandidateCorpus.getById(wrongState.id),
      ).resolves.toMatchObject({ state: "complete" });
      await expect(
        store.nodes.CandidateCorpus.getById(wrongRelatedNode.id),
      ).resolves.toMatchObject({ state: "pending" });
      await expect(
        store.nodes.CandidateCorpus.getById(noCandidate.id),
      ).resolves.toMatchObject({ state: "pending" });
    });

    it("treats an empty candidate selection as a no-op", async () => {
      const record = defineNode("EmptyCandidateRecord", {
        schema: z.object({ name: z.string(), state: z.string() }),
      });
      const graph = defineGraph({
        id: "update_where_empty_candidates",
        nodes: { EmptyCandidateRecord: { type: record } },
        edges: {},
      });
      const store = await context.createStore(graph);
      const existing = await store.nodes.EmptyCandidateRecord.create({
        name: "not selected",
        state: "pending",
      });
      const candidates = store
        .query()
        .from("EmptyCandidateRecord", "record")
        .whereNode("record", (candidate) => candidate.name.eq("does not exist"))
        .select((query) => query.record.id);

      await expect(
        store.nodes.EmptyCandidateRecord.updateWhere({
          candidates,
          patch: { state: "processed" },
        }),
      ).resolves.toEqual({ affectedCount: 0 });
      await expect(
        store.nodes.EmptyCandidateRecord.getById(existing.id),
      ).resolves.toMatchObject({ state: "pending" });
    });

    it("refuses subclass-expanded candidates and accepts the exact kind", async () => {
      const content = defineNode("CandidateContent", {
        schema: z.object({ name: z.string() }),
      });
      const article = defineNode("CandidateArticle", {
        schema: z.object({ name: z.string() }),
      });
      const graph = defineGraph({
        id: "update_where_polymorphic_candidates",
        nodes: {
          CandidateContent: { type: content },
          CandidateArticle: { type: article },
        },
        edges: {},
        ontology: [subClassOf(article, content)],
      });
      const store = await context.createStore(graph);
      const baseNode = await store.nodes.CandidateContent.create({
        name: "base",
      });
      const subclassNode = await store.nodes.CandidateArticle.create({
        name: "subclass",
      });
      const polymorphicCandidates = store
        .query()
        .from("CandidateContent", "content")
        .select((query) => query.content.id);

      const refusal = await store.nodes.CandidateContent.updateWhere({
        candidates: polymorphicCandidates,
        patch: { name: "must not change" },
      }).catch((error: unknown) => error);
      if (!(refusal instanceof ConfigurationError)) {
        throw new TypeError("expected a ConfigurationError refusal", {
          cause: refusal,
        });
      }
      expect(refusal).toMatchObject({
        details: {
          code: "SET_UPDATE_CANDIDATE_MULTIPLE_KINDS_UNSUPPORTED",
          operation: "updateWhere",
          expansion: "subclasses",
        },
      });
      expect(refusal.details["candidateKinds"]).toEqual(
        expect.arrayContaining(["CandidateArticle", "CandidateContent"]),
      );
      expect(refusal.suggestion).toContain('{ expansion: "exact" }');
      await expect(
        store.nodes.CandidateContent.getById(baseNode.id),
      ).resolves.toMatchObject({ name: "base" });
      await expect(
        store.nodes.CandidateArticle.getById(subclassNode.id),
      ).resolves.toMatchObject({ name: "subclass" });

      const exactCandidates = store
        .query()
        .from("CandidateContent", "content", { expansion: "exact" })
        .select((query) => query.content.id);

      await expect(
        store.nodes.CandidateContent.updateWhere({
          candidates: exactCandidates,
          patch: { name: "base updated" },
        }),
      ).resolves.toEqual({ affectedCount: 1 });
      await expect(
        store.nodes.CandidateContent.getById(baseNode.id),
      ).resolves.toMatchObject({ name: "base updated" });
      await expect(
        store.nodes.CandidateArticle.getById(subclassNode.id),
      ).resolves.toMatchObject({ name: "subclass" });
    });

    it("refuses parameterized candidate queries before executing the set update", async () => {
      const store = context.getStore();
      const candidates = store
        .query()
        .from("Person", "person")
        .whereNode("person", (_person, expressions) =>
          expr.gte(expressions.person.age, expr.param("minimumAge", "number")),
        )
        .select((query) => query.person.id);

      await expect(
        store.nodes.Person.updateWhere({
          candidates,
          patch: { isActive: false },
        }),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        code: "CONFIGURATION_ERROR",
        details: {
          code: "SET_UPDATE_CANDIDATE_PARAMETERS_UNSUPPORTED",
          operation: "updateWhere",
        },
      });
    });

    it("refuses grouped candidate queries before changing grouping semantics", async () => {
      const store = context.getStore();
      const candidates = store
        .query()
        .from("Person", "person")
        .groupBy("person", "age")
        .select((query) => query.person.id);

      await expect(
        store.nodes.Person.updateWhere({
          candidates,
          patch: { isActive: false },
        }),
      ).rejects.toMatchObject({
        name: "ConfigurationError",
        code: "CONFIGURATION_ERROR",
        details: {
          code: "SET_UPDATE_CANDIDATE_GROUPING_UNSUPPORTED",
          operation: "updateWhere",
        },
      });
    });

    it("refuses checked-read candidates before applying a set update", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create({
        name: "Checked candidate",
        age: 40,
        email: "checked@example.com",
      });

      await store.withCheckedReads(undefined, async (reads) => {
        const candidates = reads
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.id.eq(person.id))
          .select((query) => query.person.id);

        await expect(
          store.nodes.Person.updateWhere({
            candidates,
            patch: { age: 41 },
          }),
        ).rejects.toMatchObject({
          name: "ConfigurationError",
          code: "CONFIGURATION_ERROR",
          details: {
            code: "SET_UPDATE_CANDIDATE_CHECKED_READS_UNSUPPORTED",
            operation: "updateWhere",
          },
        });
      });

      await expect(
        store.nodes.Person.getById(person.id),
      ).resolves.toMatchObject({ age: 40 });
    });

    it("refuses candidate queries with mismatched kind or graph provenance", async () => {
      const store = context.getStore();
      const personCandidates = store
        .query()
        .from("Person", "person")
        .select((context) => context.person.id);

      await expect(
        store.nodes.Company.updateWhere({
          candidates: personCandidates,
          patch: { name: "not applied" },
        }),
      ).rejects.toThrow("collection's node kind");

      const otherGraph = defineGraph({
        id: "different_candidate_graph",
        nodes: {
          Person: {
            type: defineNode("Person", {
              schema: z.object({ name: z.string() }),
            }),
          },
        },
        edges: {},
      });
      const otherStore = await context.createStore(otherGraph);
      const otherCandidates = otherStore
        .query()
        .from("Person", "person")
        .select((context) => context.person.id);

      await expect(
        store.nodes.Person.updateWhere({
          candidates: otherCandidates,
          patch: { age: 99 },
        }),
      ).rejects.toThrow("same graph");

      const historicalCandidates = store
        .query()
        .from("Person", "person")
        .temporal("asOf", "2020-01-01T00:00:00.000Z")
        .select((context) => context.person.id);
      await expect(
        store.nodes.Person.updateWhere({
          candidates: historicalCandidates,
          patch: { age: 99 },
        }),
      ).rejects.toThrow("current temporal coordinate");
    });

    it("updates nodes selected by property and relationship predicates", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const acme = await store.nodes.Company.create({
        name: "Acme",
        industry: "technology",
      });
      const bank = await store.nodes.Company.create({
        name: "Bank",
        industry: "finance",
      });
      const alice = await store.nodes.Person.create({ name: "Alice", age: 35 });
      const bob = await store.nodes.Person.create({ name: "Bob", age: 35 });
      const cara = await store.nodes.Person.create({ name: "Cara", age: 25 });
      await store.edges.worksAt.create(alice, acme, { role: "engineer" });
      await store.edges.worksAt.create(bob, bank, { role: "analyst" });
      await store.edges.worksAt.create(cara, acme, { role: "designer" });

      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) => person.age.gte(30))
          .traverse("worksAt", "employment")
          .to("Company", "company")
          .whereNode("company", (company) => company.industry.eq("technology"))
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        operation: "updateWhere",
        graphId: store.graphId,
        kind: "Person",
        patch: { isActive: true },
        candidateIds,
        candidateIdColumn: "person_id",
      });

      expect(result.affectedCount).toBe(1);
      expect(result.rows.map((row) => row.id)).toEqual([alice.id]);
      expect(result.rows[0]?.version).toBe(2);
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode(store.graphId, "Person", alice.id),
          ).props,
        ),
      ).toMatchObject({
        name: "Alice",
        age: 35,
        isActive: true,
      });
      expect(
        rowPropsToObject(
          requireDefined(await backend.getNode(store.graphId, "Person", bob.id))
            .props,
        ),
      ).not.toHaveProperty("isActive");
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode(store.graphId, "Person", cara.id),
          ).props,
        ),
      ).not.toHaveProperty("isActive");
    });

    it("fences colliding candidate ids to the requested graph and kind", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const sharedId = "shared-set-update-id";
      await store.nodes.Person.create({ name: "Target" }, { id: sharedId });
      await store.nodes.Company.create(
        { name: "Same graph" },
        { id: sharedId },
      );
      await backend.insertNode({
        graphId: "other_graph",
        kind: "Person",
        id: sharedId,
        props: { name: "Other graph" },
      });
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .whereNode("person", (person) => person.id.eq(sharedId))
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        operation: "updateWhere",
        graphId: store.graphId,
        kind: "Person",
        patch: { isActive: true },
        candidateIds,
        candidateIdColumn: "person_id",
      });

      expect(result.affectedCount).toBe(1);
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode(store.graphId, "Person", sharedId),
          ).props,
        ),
      ).toHaveProperty("isActive", true);
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode(store.graphId, "Company", sharedId),
          ).props,
        ),
      ).not.toHaveProperty("isActive");
      expect(
        rowPropsToObject(
          requireDefined(
            await backend.getNode("other_graph", "Person", sharedId),
          ).props,
        ),
      ).not.toHaveProperty("isActive");
    });

    it("keeps hard-delete uniqueness cleanup scoped to concrete node kind", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const sharedId = "shared-unique-owner-id";
      const personKey = "person@example.test";
      const companyKey = "company@example.test";
      const person = await store.nodes.Person.create(
        { name: "Person" },
        { id: sharedId },
      );
      await store.nodes.Company.create({ name: "Company" }, { id: sharedId });
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "Person",
        constraintName: "identity",
        key: personKey,
        nodeId: sharedId,
        concreteKind: "Person",
      });
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "Company",
        constraintName: "identity",
        key: companyKey,
        nodeId: sharedId,
        concreteKind: "Company",
      });

      await store.nodes.Person.hardDelete(person.id);

      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "Person",
          constraintName: "identity",
          key: personKey,
          includeDeleted: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "Company",
          constraintName: "identity",
          key: companyKey,
          includeDeleted: true,
        }),
      ).resolves.toMatchObject({
        concrete_kind: "Company",
        node_id: sharedId,
      });
    });

    it("hard-deletes uniqueness sidecars for a set of concrete nodes", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const nodeIds = ["unique-owner-a", "unique-owner-b"];
      for (const nodeId of nodeIds) {
        await backend.insertUnique({
          graphId: store.graphId,
          nodeKind: "Person",
          constraintName: "identity",
          key: `${nodeId}@example.test`,
          nodeId,
          concreteKind: "Person",
        });
      }

      await requireDefined(backend.hardDeleteUniquesByNodeIds)({
        graphId: store.graphId,
        concreteKind: "Person",
        nodeIds: [...nodeIds, "unique-owner-a"],
      });

      for (const nodeId of nodeIds) {
        await expect(
          backend.checkUnique({
            graphId: store.graphId,
            nodeKind: "Person",
            constraintName: "identity",
            key: `${nodeId}@example.test`,
            includeDeleted: true,
          }),
        ).resolves.toBeUndefined();
      }
      await expect(
        requireDefined(backend.hardDeleteUniquesByNodeIds)({
          graphId: store.graphId,
          concreteKind: "Person",
          nodeIds: [],
        }),
      ).resolves.toBeUndefined();
    });

    it("hard-deletes uniqueness sidecars for every node of a concrete kind", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      // Owned by the reaped kind at its own axis, and owned by it at an axis
      // that is not a kind at all: the member reaps by OWNER, so both go.
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "Person",
        constraintName: "identity",
        key: "kind-owner-a@example.test",
        nodeId: "kind-owner-a",
        concreteKind: "Person",
      });
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "disjoint(Company|Person)",
        constraintName: "identity",
        key: "kind-owner-b@example.test",
        nodeId: "kind-owner-b",
        concreteKind: "Person",
      });
      // Owned by another kind AT the reaped kind's axis: it stays.
      await backend.insertUnique({
        graphId: store.graphId,
        nodeKind: "Person",
        constraintName: "identity",
        key: "kind-bystander@example.test",
        nodeId: "kind-bystander",
        concreteKind: "Company",
      });

      await requireDefined(backend.hardDeleteUniquesByConcreteKind)({
        graphId: store.graphId,
        concreteKind: "Person",
      });

      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "Person",
          constraintName: "identity",
          key: "kind-owner-a@example.test",
          includeDeleted: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "disjoint(Company|Person)",
          constraintName: "identity",
          key: "kind-owner-b@example.test",
          includeDeleted: true,
        }),
      ).resolves.toBeUndefined();
      await expect(
        backend.checkUnique({
          graphId: store.graphId,
          nodeKind: "Person",
          constraintName: "identity",
          key: "kind-bystander@example.test",
          includeDeleted: true,
        }),
      ).resolves.toMatchObject({
        concrete_kind: "Company",
        node_id: "kind-bystander",
      });
    });

    it("replaces top-level values without deleting explicit JSON null", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const document = await store.nodes.Document.create({
        title: "Draft",
        metadata: { author: "Ada", reviewer: "Grace" },
      });
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Document", "document")
          .whereNode("document", (item) => item.id.eq(document.id))
          .select((ctx) => ctx.document.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        operation: "updateWhere",
        graphId: store.graphId,
        kind: "Document",
        patch: {
          metadata: {
            author: "Ada",
            // eslint-disable-next-line unicorn/no-null -- explicit JSON null is the behavior under test
            reviewer: null,
            flags: { archived: true },
          },
        },
        candidateIds,
        candidateIdColumn: "document_id",
      });

      expect(result.affectedCount).toBe(1);
      expect(rowPropsToObject(requireDefined(result.rows[0]).props)).toEqual({
        title: "Draft",
        metadata: {
          author: "Ada",
          // eslint-disable-next-line unicorn/no-null -- explicit JSON null is the behavior under test
          reviewer: null,
          flags: { archived: true },
        },
      });
    });

    it("treats numeric property names as object keys on every backend", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const document = await store.nodes.Document.create({ title: "Draft" });
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Document", "document")
          .whereNode("document", (item) => item.id.eq(document.id))
          .select((ctx) => ctx.document.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        operation: "updateWhere",
        graphId: store.graphId,
        kind: "Document",
        patch: { "0": "zero", "01": "zero-one" },
        candidateIds,
        candidateIdColumn: "document_id",
      });

      expect(rowPropsToObject(requireDefined(result.rows[0]).props)).toEqual({
        title: "Draft",
        "0": "zero",
        "01": "zero-one",
      });
    });

    it("applies patches wider than SQLite's legacy function-argument limit", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const document = await store.nodes.Document.create({ title: "Draft" });
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Document", "document")
          .whereNode("document", (item) => item.id.eq(document.id))
          .select((ctx) => ctx.document.id)
          .toAst(),
      );
      const patch = Object.fromEntries(
        Array.from({ length: 70 }, (_, index) => [`field${index}`, index]),
      );

      const result = await updateNodeSet(backend, {
        operation: "updateWhere",
        graphId: store.graphId,
        kind: "Document",
        patch,
        candidateIds,
        candidateIdColumn: "document_id",
      });

      expect(rowPropsToObject(requireDefined(result.rows[0]).props)).toEqual({
        title: "Draft",
        ...patch,
      });
    });

    it("never resurrects tombstoned candidates", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const deleted = await store.nodes.Person.create({ name: "Deleted" });
      await store.nodes.Person.delete(deleted.id);
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .temporal("includeTombstones")
          .whereNode("person", (person) => person.id.eq(deleted.id))
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        operation: "updateWhere",
        graphId: store.graphId,
        kind: "Person",
        patch: { isActive: true },
        candidateIds,
        candidateIdColumn: "person_id",
      });

      expect(result).toEqual({ affectedCount: 0, rows: [] });
      const row = requireDefined(
        await backend.getNode(store.graphId, "Person", deleted.id),
      );
      expect(row.deleted_at).toBeDefined();
      expect(row.version).toBe(1);
    });

    it("captures every affected row in recorded-time history", async () => {
      const store = await context.createHistoryStore(integrationTestGraph);
      const backend = store.backend;
      const alice = await store.nodes.Person.create({ name: "Alice" });
      const bob = await store.nodes.Person.create({ name: "Bob" });
      const beforeUpdate = requireDefined(await store.recordedNow());
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      const result = await updateNodeSet(backend, {
        operation: "updateWhere",
        graphId: store.graphId,
        kind: "Person",
        patch: { isActive: true },
        candidateIds,
        candidateIdColumn: "person_id",
      });
      const afterUpdate = requireDefined(await store.recordedNow());

      expect(result.affectedCount).toBe(2);
      await expect(
        store.asOfRecorded(beforeUpdate).nodes.Person.getById(alice.id),
      ).resolves.not.toHaveProperty("isActive");
      await expect(
        store.asOfRecorded(afterUpdate).nodes.Person.getById(alice.id),
      ).resolves.toHaveProperty("isActive", true);
      await expect(
        store.asOfRecorded(afterUpdate).nodes.Person.getById(bob.id),
      ).resolves.toHaveProperty("isActive", true);
    });

    it("rejects an empty patch before executing SQL", async () => {
      const store = context.getStore();
      const backend = context.getBackend();
      const candidateIds = compileCandidateIds(
        store.graphId,
        backend,
        store
          .query()
          .from("Person", "person")
          .select((ctx) => ctx.person.id)
          .toAst(),
      );

      await expect(
        updateNodeSet(backend, {
          operation: "updateWhere",
          graphId: store.graphId,
          kind: "Person",
          patch: {},
          candidateIds,
          candidateIdColumn: "person_id",
        }),
      ).rejects.toBeInstanceOf(ConfigurationError);
    });
  });
}
