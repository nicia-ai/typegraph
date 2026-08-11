import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createStoreWithSchema,
  defineEdge,
  defineGraph,
  defineGraphExtension,
  defineNode,
  type GraphBackend,
  IdentityContradictionError,
  IdentityEndpointValidityError,
  rebuildIdentityClosure,
} from "../../../src";
import { exportGraph } from "../../../src/interchange";
import { inverseOf } from "../../../src/ontology";
import { createSqlSchema } from "../../../src/query/compiler/schema";
import { sql } from "../../../src/query/sql-fragment";
import {
  asCompiledRowsSql,
  asCompiledStatementSql,
} from "../../../src/query/sql-intent";
import { storeRuntime } from "../../../src/store/runtime-port";
import { compareStrings } from "../../../src/utils/compare";
import { requireDefined } from "../../../src/utils/presence";
import { type IntegrationTestContext } from "./test-context";

/**
 * Dedicated graph for identity-EXPANDED traversal parity tests. It is
 * provisioned on the same per-test backend as the shared fixture (they coexist
 * by graph_id) so these cases run on every backend via `createIntegrationTestSuite`.
 *
 * `link`/`bridge` accept both kinds on both endpoints so a genuine edge can
 * connect two folded peers that share an id. `bridge` is declared its own
 * inverse so `expand: "all"` follows it in both directions — the shape that
 * exercises the folded-peer self-loop dedup guard.
 */
const IdentityTravPerson = defineNode("Person", {
  schema: z.object({ name: z.string() }),
});
const IdentityTravCompany = defineNode("Company", {
  schema: z.object({ name: z.string() }),
});
const identityTravLink = defineEdge("link", { schema: z.object({}) });
const identityTravBridge = defineEdge("bridge", { schema: z.object({}) });

const identityTraversalGraph = defineGraph({
  id: "identity_traversal_parity",
  nodes: {
    Person: { type: IdentityTravPerson },
    Company: { type: IdentityTravCompany },
  },
  edges: {
    link: {
      type: identityTravLink,
      from: [IdentityTravPerson, IdentityTravCompany],
      to: [IdentityTravPerson, IdentityTravCompany],
    },
    bridge: {
      type: identityTravBridge,
      from: [IdentityTravPerson, IdentityTravCompany],
      to: [IdentityTravPerson, IdentityTravCompany],
    },
  },
  ontology: [inverseOf(identityTravBridge, identityTravBridge)],
  identity: { sameIdAcrossKinds: "fold" },
});

/**
 * Provisions {@link identityTraversalGraph} on the same per-test backend as the
 * shared fixture. `history: true` yields a store that supports `asOfRecorded`.
 */
async function provisionIdentityTraversalStore(
  context: IntegrationTestContext,
  history: boolean,
) {
  const backend = context.getStore().backend;
  const [store] = await createStoreWithSchema(
    identityTraversalGraph,
    backend,
    history ? { history: true } : {},
  );
  return store;
}

/**
 * Same node and edge kinds as {@link identityTraversalGraph} under the other
 * identity profile: `sameIdAcrossKinds: "ignore"` keeps the assertion ledger
 * but never folds two nodes just because they share an id.
 */
const identityIgnoreGraph = defineGraph({
  id: "identity_ignore_profile",
  nodes: {
    Person: { type: IdentityTravPerson },
    Company: { type: IdentityTravCompany },
  },
  edges: {
    link: {
      type: identityTravLink,
      from: [IdentityTravPerson, IdentityTravCompany],
      to: [IdentityTravPerson, IdentityTravCompany],
    },
  },
  identity: { sameIdAcrossKinds: "ignore" },
});

async function provisionIdentityIgnoreStore(context: IntegrationTestContext) {
  const [store] = await createStoreWithSchema(
    identityIgnoreGraph,
    context.getStore().backend,
  );
  return store;
}

/**
 * Reads the raw assertion ledger rows touching a node, including rows the
 * public reads hide (retracted assertions are ended, not visible). Used to
 * assert on persistence itself — row removal and stored window bounds.
 */
async function readAssertionRows(
  store: Readonly<{ backend: GraphBackend; graphId: string }>,
  ref: Readonly<{ kind: string; id: string }>,
): Promise<readonly RawAssertionRow[]> {
  const schema = createSqlSchema(store.backend.tableNames);
  return store.backend.execute<RawAssertionRow>(
    asCompiledRowsSql(sql`
      SELECT id, valid_from, valid_to
      FROM ${schema.identityAssertionsTable}
      WHERE graph_id = ${store.graphId}
        AND (
          (a_kind = ${ref.kind} AND a_id = ${ref.id})
          OR (b_kind = ${ref.kind} AND b_id = ${ref.id})
        )
    `),
  );
}

type RawAssertionRow = Readonly<{
  id: string;
  valid_from: unknown;
  valid_to: unknown;
}>;

/** An assertion row is ended once its `valid_to` bound is set. */
function isEndedRow(row: RawAssertionRow): boolean {
  return row.valid_to instanceof Date || typeof row.valid_to === "string";
}

/**
 * Canonicalizes a raw stored timestamp so a stored-window assertion means the
 * same thing on every backend. SQLite keeps ISO-8601 text; the PostgreSQL
 * drivers hand back either a `Date` (node-postgres) or the server's own
 * `YYYY-MM-DD HH:MM:SS.mmm+00` rendering (postgres-js).
 */
function toInstant(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "string") {
    throw new TypeError(`Unexpected stored timestamp: ${String(value)}`);
  }
  const isoCandidate = value
    .replaceAll(" ", "T")
    .replace(/([+-]\d\d)$/, "$1:00");
  const parsed = new Date(isoCandidate);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`Unparsable stored timestamp: ${value}`);
  }
  return parsed.toISOString();
}

/**
 * Row order is not guaranteed across backends, so traversal path assertions
 * compare sorted sets rather than a specific row order.
 */
function sortPaths(
  paths: readonly (readonly string[])[],
): readonly (readonly string[])[] {
  return [...paths].toSorted((left, right) =>
    compareStrings(left.join("/"), right.join("/")),
  );
}

export function registerIdentityIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Operational Identity", () => {
    it("asserts, reads, retracts, and folds classes", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "shared-id" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "shared-id" },
      );
      const product = await store.nodes.Product.create(
        { name: "Alice Product", price: 1, category: "test" },
        { id: "product-id" },
      );

      expect(await store.identity.membersOf(person)).toEqual([
        { kind: "Company", id: "shared-id" },
        { kind: "Person", id: "shared-id" },
      ]);
      const assertion = await store.identity.assertSame(company, product);
      expect(await store.identity.areSame(person, product)).toBe(true);
      expect(await store.identity.representativeOf(person)).toEqual({
        kind: "Company",
        id: "shared-id",
      });

      await store.identity.retractAssertion(assertion.assertion.id);
      expect(await store.identity.areSame(person, product)).toBe(false);
    });

    it("applies bounded and open identity assertion validity windows", async () => {
      const store = context.getStore();
      const endpointStart = "2019-01-01T00:00:00.000Z";
      const validFrom = "2020-01-01T00:00:00.000Z";
      const inside = "2021-01-01T00:00:00.000Z";
      const validTo = "2022-01-01T00:00:00.000Z";
      const person = await store.nodes.Person.create(
        { name: "Windowed person" },
        { id: "windowed-person", validFrom: endpointStart },
      );
      const company = await store.nodes.Company.create(
        { name: "Windowed company" },
        { id: "windowed-company", validFrom: endpointStart },
      );

      const historical = await store.identity.assertSame(person, company, {
        validFrom,
        validTo,
      });
      expect(historical.assertion).toMatchObject({ validFrom, validTo });
      expect(await store.identity.areSame(person, company)).toBe(false);
      expect(await store.asOf(inside).identity.areSame(person, company)).toBe(
        true,
      );
      expect(await store.asOf(validTo).identity.areSame(person, company)).toBe(
        false,
      );
      await storeRuntime(store).validateIdentity();
      await rebuildIdentityClosure(store);
      expect(await store.identity.areSame(person, company)).toBe(false);
      expect(await store.asOf(inside).identity.areSame(person, company)).toBe(
        true,
      );

      const repeated = await store.identity.assertSame(person, company, {
        validFrom,
        validTo,
      });
      expect(repeated).toMatchObject({
        action: "existing",
        assertion: { id: historical.assertion.id },
      });

      const current = await store.identity.assertSame(person, company, {
        validFrom: validTo,
      });
      expect(current.action).toBe("created");
      expect(await store.identity.areSame(person, company)).toBe(true);
    });

    it("checks temporal identity contradictions over every overlapping segment", async () => {
      const store = context.getStore();
      const endpointStart = "2019-01-01T00:00:00.000Z";
      const first = await store.nodes.Person.create(
        { name: "Temporal first" },
        { id: "temporal-first", validFrom: endpointStart },
      );
      const bridge = await store.nodes.Person.create(
        { name: "Temporal bridge" },
        { id: "temporal-bridge", validFrom: endpointStart },
      );
      const last = await store.nodes.Person.create(
        { name: "Temporal last" },
        { id: "temporal-last", validFrom: endpointStart },
      );

      await store.identity.assertDifferent(first, last, {
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2022-01-01T00:00:00.000Z",
      });
      await store.identity.assertSame(first, bridge, {
        validFrom: "2020-06-01T00:00:00.000Z",
        validTo: "2023-01-01T00:00:00.000Z",
      });
      await expect(
        store.identity.assertSame(bridge, last, {
          validFrom: "2021-01-01T00:00:00.000Z",
          validTo: "2024-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(IdentityContradictionError);

      await expect(
        store.identity.assertSame(bridge, last, {
          validFrom: "2022-01-01T00:00:00.000Z",
          validTo: "2024-01-01T00:00:00.000Z",
        }),
      ).resolves.toMatchObject({ action: "created" });
    });

    it("refuses unsupported identity windows and endpoints outside the interval", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Validity person" },
        { id: "validity-person", validFrom: "2021-01-01T00:00:00.000Z" },
      );
      const company = await store.nodes.Company.create(
        { name: "Validity company" },
        { id: "validity-company", validFrom: "2019-01-01T00:00:00.000Z" },
      );

      await expect(
        store.identity.assertSame(person, company, {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2022-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(IdentityEndpointValidityError);
      await expect(
        store.identity.assertSame(person, company, {
          validFrom: "2099-01-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({
        code: "IDENTITY_VALIDITY_FUTURE_START",
        category: "user",
        details: { reason: "future-valid-from" },
      });
      await expect(
        store.identity.assertSame(person, company, {
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2099-01-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({
        code: "IDENTITY_VALIDITY_FUTURE_END",
        category: "user",
        details: { reason: "future-valid-to" },
      });
      await expect(
        store.identity.assertSame(person, company, {
          validFrom: "2024-01-01T00:00:00.000Z",
          validTo: "2023-01-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject({
        code: "IDENTITY_VALIDITY_INVERTED",
        category: "user",
        details: { reason: "inverted" },
      });
    });

    it("refuses a second non-identical open window in scalar and bulk writes", async () => {
      const store = context.getStore();
      const nodes = await store.nodes.Person.bulkCreate(
        ["scalar-a", "scalar-b", "bulk-a", "bulk-b"].map((id) => ({
          id: `open-window-${id}`,
          props: { name: `Open window ${id}` },
          validFrom: "2019-01-01T00:00:00.000Z",
        })),
      );
      const scalarA = requireDefined(nodes[0]);
      const scalarB = requireDefined(nodes[1]);
      const bulkA = requireDefined(nodes[2]);
      const bulkB = requireDefined(nodes[3]);
      await store.identity.assertSame(scalarA, scalarB, {
        validFrom: "2021-01-01T00:00:00.000Z",
      });
      await store.identity.assertSame(bulkA, bulkB, {
        validFrom: "2021-01-01T00:00:00.000Z",
      });
      const expectedError = {
        code: "IDENTITY_VALIDITY_OPEN_WINDOW_CONFLICT",
        category: "constraint",
        details: { reason: "overlapping-open-window" },
      } as const;

      await expect(
        store.identity.assertSame(scalarA, scalarB, {
          validFrom: "2020-01-01T00:00:00.000Z",
        }),
      ).rejects.toMatchObject(expectedError);
      await expect(
        store.identity.bulkAssertSame([
          {
            a: bulkA,
            b: bulkB,
            validFrom: "2020-01-01T00:00:00.000Z",
          },
        ]),
      ).rejects.toMatchObject(expectedError);
    });

    it("applies one validity window per bulk identity pair", async () => {
      const store = context.getStore();
      const endpointStart = "2019-01-01T00:00:00.000Z";
      const nodes = await store.nodes.Person.bulkCreate(
        ["a", "b", "c", "d"].map((id) => ({
          id: `bulk-window-${id}`,
          props: { name: `Bulk ${id}` },
          validFrom: endpointStart,
        })),
      );
      const first = requireDefined(nodes[0]);
      const second = requireDefined(nodes[1]);
      const third = requireDefined(nodes[2]);
      const fourth = requireDefined(nodes[3]);
      const results = await store.identity.bulkAssertSame([
        {
          a: first,
          b: second,
          validFrom: "2020-01-01T00:00:00.000Z",
          validTo: "2021-01-01T00:00:00.000Z",
        },
        {
          a: third,
          b: fourth,
          validFrom: "2022-01-01T00:00:00.000Z",
        },
      ]);

      expect(results.map((result) => result.assertion.validTo)).toEqual([
        "2021-01-01T00:00:00.000Z",
        undefined,
      ]);
      expect(await store.identity.areSame(first, second)).toBe(false);
      expect(await store.identity.areSame(third, fourth)).toBe(true);
    });

    it("preserves unwindowed semantics in mixed bulk calls and empty windows", async () => {
      const store = context.getStore();
      const endpointStart = "2019-01-01T00:00:00.000Z";
      const nodes = await store.nodes.Person.bulkCreate(
        ["a", "b", "c", "d"].map((id) => ({
          id: `mixed-window-${id}`,
          props: { name: `Mixed ${id}` },
          validFrom: endpointStart,
        })),
      );
      const first = requireDefined(nodes[0]);
      const second = requireDefined(nodes[1]);
      const third = requireDefined(nodes[2]);
      const fourth = requireDefined(nodes[3]);
      const existing = await store.identity.assertSame(first, second);

      await expect(
        store.identity.assertSame(first, second, {}),
      ).resolves.toMatchObject({
        action: "existing",
        assertion: { id: existing.assertion.id },
      });
      await expect(
        store.identity.bulkAssertSame([
          { a: first, b: second },
          {
            a: third,
            b: fourth,
            validFrom: "2020-01-01T00:00:00.000Z",
            validTo: "2021-01-01T00:00:00.000Z",
          },
        ]),
      ).resolves.toMatchObject([
        { action: "existing", assertion: { id: existing.assertion.id } },
        { action: "created" },
      ]);
    });

    it("requires endpoints to cover the full assertion upper bound", async () => {
      const store = context.getStore();
      const validFrom = "2020-01-01T00:00:00.000Z";
      const endpointEnd = "2022-01-01T00:00:00.000Z";
      const first = await store.nodes.Person.create(
        { name: "Upper first" },
        {
          id: "upper-first",
          validFrom: "2019-01-01T00:00:00.000Z",
          validTo: endpointEnd,
        },
      );
      const second = await store.nodes.Company.create(
        { name: "Upper second" },
        { id: "upper-second", validFrom: "2019-01-01T00:00:00.000Z" },
      );

      await expect(
        store.identity.assertSame(first, second, {
          validFrom,
          validTo: endpointEnd,
        }),
      ).resolves.toMatchObject({ action: "created" });
      await expect(
        store.identity.assertSame(first, second, {
          validFrom,
          validTo: "2023-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(IdentityEndpointValidityError);
      await expect(
        store.identity.assertDifferent(first, second, { validFrom }),
      ).rejects.toBeInstanceOf(IdentityEndpointValidityError);
    });

    it("keeps retrospective assertions behind their recorded-time commit", async () => {
      const store = await provisionIdentityTraversalStore(context, true);
      const endpointStart = "2019-01-01T00:00:00.000Z";
      const person = await store.nodes.Person.create(
        { name: "Recorded person" },
        { id: "recorded-window-person", validFrom: endpointStart },
      );
      const company = await store.nodes.Company.create(
        { name: "Recorded company" },
        { id: "recorded-window-company", validFrom: endpointStart },
      );
      const beforeAssertion = requireDefined(await store.recordedNow());

      await store.identity.assertSame(person, company, {
        validFrom: "2020-01-01T00:00:00.000Z",
        validTo: "2022-01-01T00:00:00.000Z",
      });

      const validView = store.asOf("2021-01-01T00:00:00.000Z");
      expect(await validView.identity.areSame(person, company)).toBe(true);
      expect(
        await validView
          .asOfRecorded(beforeAssertion)
          .identity.areSame(person, company),
      ).toBe(false);
    });

    it("grows a materialized folded class without closure conflicts", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "folded-shared" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "folded-company" },
      );
      await store.identity.assertSame(person, company);

      await store.nodes.Product.create(
        { name: "Alice Product", price: 1, category: "test" },
        { id: "folded-shared" },
      );

      expect(await store.identity.membersOf(person)).toEqual([
        { kind: "Company", id: "folded-company" },
        { kind: "Person", id: "folded-shared" },
        { kind: "Product", id: "folded-shared" },
      ]);
    });

    it("recreates tombstones through single and bulk create paths", async () => {
      const store = context.getStore();
      const originalValidFrom = "2020-01-01T00:00:00.000Z";
      const recreatedValidFrom = "2021-01-01T00:00:00.000Z";
      const recreatedValidTo = "2030-01-01T00:00:00.000Z";
      const singleOriginal = await store.nodes.Person.create(
        { name: "Single original" },
        { id: "single-recreate", validFrom: originalValidFrom },
      );
      await store.nodes.Person.delete(singleOriginal.id);

      const single = await store.nodes.Person.create(
        { name: "Single recreated" },
        {
          id: "single-recreate",
          validFrom: recreatedValidFrom,
          validTo: recreatedValidTo,
        },
      );
      expect(single.meta.validFrom).toBe(recreatedValidFrom);
      expect(single.meta.validTo).toBe(recreatedValidTo);

      const bulkOriginal = await store.nodes.Person.create(
        { name: "Bulk original" },
        { id: "bulk-recreate", validFrom: originalValidFrom },
      );
      const bulkAlias = await store.nodes.Company.create({
        name: "Bulk alias",
      });
      await store.identity.assertSame(bulkOriginal, bulkAlias);
      await store.nodes.Person.delete(bulkOriginal.id);
      const bulk = await store.nodes.Person.bulkCreate([
        {
          id: "bulk-recreate",
          props: { name: "Bulk recreated" },
          validFrom: recreatedValidFrom,
          validTo: recreatedValidTo,
        },
        { id: "bulk-new", props: { name: "Bulk new" } },
      ]);
      expect(bulk.map((node) => node.id)).toEqual([
        "bulk-recreate",
        "bulk-new",
      ]);
      expect(bulk[0]?.meta.validFrom).toBe(recreatedValidFrom);
      expect(bulk[0]?.meta.validTo).toBe(recreatedValidTo);
      expect(bulk[0]?.name).toBe("Bulk recreated");
      expect(
        await store.identity.assertionsOf(requireDefined(bulk[0])),
      ).toEqual([]);

      const bulkNewId = requireDefined(bulk[1]).id;
      await store.nodes.Person.delete(bulkNewId);
      await store.nodes.Person.bulkInsert([
        {
          id: "bulk-new",
          props: { name: "Bulk inserted again" },
          validFrom: recreatedValidFrom,
          validTo: recreatedValidTo,
        },
      ]);
      expect(
        await store.backend.getNode(store.graphId, "Person", "bulk-new"),
      ).toMatchObject({ deleted_at: undefined });
      const reinserted = await store.nodes.Person.getById(bulkNewId);
      expect(reinserted?.name).toBe("Bulk inserted again");
      expect(reinserted?.meta.validFrom).toBe(recreatedValidFrom);
      expect(reinserted?.meta.validTo).toBe(recreatedValidTo);
    });

    it("lifts different assertions to whole classes", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const alias = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "alice-company" },
      );
      const other = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "bob" },
      );
      await store.identity.assertSame(person, alias);
      await store.identity.assertDifferent(alias, other);

      expect(await store.identity.areDifferent(person, other)).toBe(true);
    });

    it("serializes opposing concurrent writers through one graph lock", async () => {
      const store = context.getStore();
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });

      const results = await Promise.allSettled([
        store.identity.assertSame(first, second),
        store.identity.assertDifferent(first, second),
      ]);

      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        (await store.identity.areSame(first, second)) !==
          (await store.identity.areDifferent(first, second)),
      ).toBe(true);
    });

    it("runs eager bulk mutations once and reports identity write intents", async () => {
      const store = context.getStore();
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });
      const third = await store.nodes.Person.create({ name: "Third" });

      const outcome = await store.transactionWithReceipt(async (tx) => {
        const assertions = await tx.identity.bulkAssertSame([
          { a: first, b: second },
          { a: second, b: third },
        ]);
        await tx.identity.bulkRetractAssertions([
          requireDefined(assertions[0]).assertion.id,
        ]);
      });

      expect(outcome.receipt.writes.identity).toEqual({
        sameAssertions: 2,
        differentAssertions: 0,
        retractions: 1,
        total: 3,
      });
      expect(outcome.receipt.writes.total).toBe(3);
    });

    it("supports symmetric bulk assertions and pair-based retractions", async () => {
      const store = context.getStore();
      const first = await store.nodes.Person.create({ name: "First" });
      const second = await store.nodes.Person.create({ name: "Second" });
      const third = await store.nodes.Person.create({ name: "Third" });
      const separate = await store.nodes.Person.create({ name: "Separate" });

      const same = await store.identity.bulkAssertSame([
        { a: first, b: second },
        { a: second, b: third },
      ]);
      expect(same.map((result) => result.assertion.relation)).toEqual([
        "same",
        "same",
      ]);
      expect(await store.identity.areSame(first, third)).toBe(true);

      const different = await store.identity.bulkAssertDifferent([
        { a: first, b: separate },
        { a: second, b: separate },
      ]);
      expect(different.map((result) => result.assertion.relation)).toEqual([
        "different",
        "different",
      ]);
      expect(await store.identity.areDifferent(third, separate)).toBe(true);

      await store.identity.retractDifferentAssertion(second, separate);
      expect(await store.identity.areDifferent(third, separate)).toBe(true);
      await store.identity.retractDifferentAssertion(first, separate);
      expect(await store.identity.areDifferent(third, separate)).toBe(false);

      await store.identity.retractSameAssertion(second, third);
      expect(await store.identity.areSame(first, third)).toBe(false);
      const [firstSame] = same;
      await store.identity.bulkRetractAssertions([
        requireDefined(firstSame).assertion.id,
        requireDefined(firstSame).assertion.id,
      ]);
      expect(await store.identity.areSame(first, second)).toBe(false);
    });

    it("preserves first-occurrence input order in bulk retraction results", async () => {
      const store = context.getStore();
      const nodes = await store.nodes.Person.bulkCreate(
        Array.from({ length: 6 }, (_, index) => ({
          id: `ordered-retraction-${index}`,
          props: { name: `Ordered ${index}` },
        })),
      );
      const assertions = await store.identity.bulkAssertDifferent([
        { a: requireDefined(nodes[0]), b: requireDefined(nodes[1]) },
        { a: requireDefined(nodes[2]), b: requireDefined(nodes[3]) },
        { a: requireDefined(nodes[4]), b: requireDefined(nodes[5]) },
      ]);
      const ids = assertions.map((result) => result.assertion.id);
      const requested = [
        requireDefined(ids[2]),
        requireDefined(ids[0]),
        requireDefined(ids[1]),
        requireDefined(ids[2]),
      ];

      const ended = await store.identity.bulkRetractAssertions(requested);

      expect(ended.map((assertion) => assertion.id)).toEqual(
        requested.slice(0, 3),
      );
    });

    it("filters identity assertions with omitted endpoint kinds", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Filtered person" },
        { id: "filtered-person" },
      );
      const company = await store.nodes.Company.create(
        { name: "Filtered company" },
        { id: "filtered-company" },
      );
      await store.identity.assertSame(person, company);

      const document = await exportGraph(store, { nodeKinds: ["Person"] });

      expect(document.nodes.map((node) => node.kind)).toEqual(["Person"]);
      expect(document.identity?.assertions).toEqual([]);
    });

    it("filters archival identity assertions with omitted deleted endpoints", async () => {
      const store = context.getStore();
      const first = await store.nodes.Person.create(
        { name: "Archival live" },
        { id: "archival-live" },
      );
      const deleted = await store.nodes.Person.create(
        { name: "Archival deleted" },
        { id: "archival-deleted" },
      );
      await store.identity.assertSame(first, deleted);
      await store.nodes.Person.delete(deleted.id);

      const document = await exportGraph(store, { identityMode: "archival" });

      expect(document.nodes.map((node) => node.id)).toEqual([first.id]);
      expect(document.identity?.assertions).toEqual([]);
    });

    it("makes current reads equal a valid-time view at now", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "now-person" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "now-company" },
      );
      await store.identity.assertSame(person, company);
      const now = new Date().toISOString();

      // Pin the class against the pair constructed above before comparing the
      // two coordinates, so the law cannot be satisfied by both sides being
      // empty.
      const expectedClass = [
        { kind: "Company", id: "now-company" },
        { kind: "Person", id: "now-person" },
      ];
      expect(await store.identity.membersOf(person)).toEqual(expectedClass);
      expect(await store.asOf(now).identity.membersOf(person)).toEqual(
        await store.identity.membersOf(person),
      );

      const currentPeople = await store
        .query()
        .from("Person", "person")
        .select((queryContext) => queryContext.person.id)
        .execute();
      const asOfPeople = await store
        .asOf(now)
        .query()
        .from("Person", "person")
        .select((queryContext) => queryContext.person.id)
        .execute();
      expect(currentPeople).toEqual([person.id]);
      expect(asOfPeople).toEqual(currentPeople);
    });

    /**
     * A same-id fold is a derived consequence of two nodes existing, and node
     * existence is a write event: the materialized closure can only track when
     * a row was created or deleted, never the validity window the caller
     * declared for it. These cases pin that decided semantics from both sides.
     */
    describe("fold conduction follows node lifecycle events (record time), not validity windows", () => {
      it("conducts through a future-valid folded bridge and filters it at read time", async () => {
        const store = context.getStore();
        const seed = await store.nodes.Person.create(
          { name: "Seed" },
          { id: "seed" },
        );
        const bridgePerson = await store.nodes.Person.create(
          { name: "Future bridge" },
          { id: "bridge" },
        );
        await store.nodes.Company.create(
          { name: "Future bridge company" },
          {
            id: "bridge",
            validFrom: new Date(Date.now() + 60_000).toISOString(),
          },
        );
        const far = await store.nodes.Product.create(
          { name: "Far", price: 1, category: "test" },
          { id: "far" },
        );
        await store.identity.assertSame(seed, bridgePerson);
        await store.identity.assertSame({ kind: "Company", id: "bridge" }, far);

        // The company was written now, so it conducts now, even though its
        // validity window has not opened.
        expect(await store.identity.membersOf(seed)).toEqual([
          { kind: "Person", id: "bridge" },
          { kind: "Person", id: "seed" },
          { kind: "Product", id: "far" },
        ]);
        // Ordinary reads still apply the validity window: the bridge company
        // conducts identity without being visible.
        const visibleCompanies = await store
          .query()
          .from("Company", "company")
          .select((queryContext) => queryContext.company.id)
          .execute();
        expect(visibleCompanies).toEqual([]);
      });

      it("does not conduct a backdated same-id fold before the nodes were written", async () => {
        const store = context.getStore();
        const backdatedValidFrom = "2020-01-01T00:00:00.000Z";
        const asOfInstant = "2021-01-01T00:00:00.000Z";
        const person = await store.nodes.Person.create(
          { name: "Backdated" },
          { id: "backdated", validFrom: backdatedValidFrom },
        );
        await store.nodes.Company.create(
          { name: "Backdated LLC" },
          { id: "backdated", validFrom: backdatedValidFrom },
        );

        // Both nodes are visible at 2021 — their validity windows opened in
        // 2020 — so this is not a visibility effect.
        const visiblePeople = await store
          .asOf(asOfInstant)
          .query()
          .from("Person", "person")
          .select((queryContext) => queryContext.person.id)
          .execute();
        const visibleCompanies = await store
          .asOf(asOfInstant)
          .query()
          .from("Company", "company")
          .select((queryContext) => queryContext.company.id)
          .execute();
        expect(visiblePeople).toEqual(["backdated"]);
        expect(visibleCompanies).toEqual(["backdated"]);

        // The fold itself was written now, so at 2021 the class is a singleton.
        expect(
          await store.asOf(asOfInstant).identity.membersOf(person),
        ).toEqual([{ kind: "Person", id: "backdated" }]);

        const currentMembers = await store.identity.membersOf(person);
        expect(currentMembers).toEqual([
          { kind: "Company", id: "backdated" },
          { kind: "Person", id: "backdated" },
        ]);
        expect(
          await store.asOf(new Date().toISOString()).identity.membersOf(person),
        ).toEqual(currentMembers);
      });
    });

    it("reconstructs a same-id fold before a later bridge deletion", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
        const store = context.getStore();
        const seed = await store.nodes.Person.create(
          { name: "Seed" },
          { id: "historical-seed" },
        );
        const bridgePerson = await store.nodes.Person.create(
          { name: "Bridge person" },
          { id: "historical-bridge" },
        );
        const bridgeCompany = await store.nodes.Company.create(
          { name: "Bridge company" },
          { id: "historical-bridge" },
        );
        const far = await store.nodes.Product.create(
          { name: "Far", price: 1, category: "test" },
          { id: "historical-far" },
        );
        await store.identity.assertSame(seed, bridgePerson);
        await store.identity.assertSame(bridgeCompany, far);
        const beforeDeletion = "2026-01-01T00:00:01.000Z";

        vi.setSystemTime(new Date("2026-01-01T00:01:00.000Z"));
        await store.nodes.Company.delete(bridgeCompany.id);

        expect(await store.identity.areSame(seed, far)).toBe(false);
        expect(
          await store.asOf(beforeDeletion).identity.areSame(seed, far),
        ).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it("uses code-point ordering for mixed-case and astral ids", async () => {
      const store = context.getStore();
      const upper = await store.nodes.Person.create(
        { name: "Upper" },
        { id: "A" },
      );
      const lower = await store.nodes.Person.create(
        { name: "Lower" },
        { id: "a" },
      );
      const astral = await store.nodes.Person.create(
        { name: "Astral" },
        { id: "😀" },
      );
      await store.identity.bulkAssertSame([
        { a: lower, b: astral },
        { a: upper, b: lower },
      ]);

      expect(await store.identity.membersOf(astral)).toEqual([
        { kind: "Person", id: "A" },
        { kind: "Person", id: "a" },
        { kind: "Person", id: "😀" },
      ]);
      expect(await store.identity.representativeOf(astral)).toEqual({
        kind: "Person",
        id: "A",
      });
    });

    it("reconstructs mixed explicit-folded-explicit chains on recorded time", async () => {
      const [store] = await createStoreWithSchema(
        context.getStore().graph,
        context.getStore().backend,
        { history: true },
      );
      const seed = await store.nodes.Person.create(
        { name: "Seed" },
        { id: "seed" },
      );
      const bridgePerson = await store.nodes.Person.create(
        { name: "Bridge" },
        { id: "bridge" },
      );
      const bridgeCompany = await store.nodes.Company.create(
        { name: "Bridge company" },
        { id: "bridge" },
      );
      const far = await store.nodes.Product.create(
        { name: "Far", price: 1, category: "test" },
        { id: "far" },
      );
      await store.identity.assertSame(seed, bridgePerson);
      await store.identity.assertSame(bridgeCompany, far);
      const beforeDelete = await store.recordedNow();
      expect(beforeDelete).toBeDefined();
      await store.nodes.Company.hardDelete(bridgeCompany.id);

      expect(await store.identity.areSame(seed, far)).toBe(false);
      expect(
        await store
          .asOfRecorded(requireDefined(beforeDelete))
          .identity.membersOf(seed),
      ).toEqual([
        { kind: "Company", id: "bridge" },
        { kind: "Person", id: "bridge" },
        { kind: "Person", id: "seed" },
        { kind: "Product", id: "far" },
      ]);
    });

    it("clears current and recorded identity state and remains reusable", async () => {
      const [store] = await createStoreWithSchema(
        context.getStore().graph,
        context.getStore().backend,
        { history: true },
      );
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "clear-fold" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "clear-fold" },
      );
      const product = await store.nodes.Product.create(
        { name: "Alice Product", price: 1, category: "test" },
        { id: "clear-product" },
      );
      await store.identity.assertSame(company, product);
      const beforeClear = await store.recordedNow();
      expect(beforeClear).toBeDefined();

      await store.clear();

      expect(await store.nodes.Person.getById(person.id)).toBeUndefined();
      expect(await store.identity.assertionsOf(person)).toEqual([]);
      expect(await store.identity.membersOf(person)).toEqual([]);
      expect(
        await store
          .asOfRecorded(requireDefined(beforeClear))
          .identity.membersOf(person),
      ).toEqual([]);

      const recreatedPerson = await store.nodes.Person.create(
        { name: "Recreated Alice" },
        { id: "clear-fold" },
      );
      await store.nodes.Company.create(
        { name: "Recreated Alice LLC" },
        { id: "clear-fold" },
      );
      expect(await store.identity.membersOf(recreatedPerson)).toEqual([
        { kind: "Company", id: "clear-fold" },
        { kind: "Person", id: "clear-fold" },
      ]);
    });

    it("records identity assertion removal when an extension kind is removed", async () => {
      const [store] = await createStoreWithSchema(
        context.getStore().graph,
        context.getStore().backend,
        { history: true },
      );
      const evolved = await store.evolve(
        defineGraphExtension({
          nodes: { Tag: { properties: { label: { type: "string" } } } },
        }),
      );
      const person = await evolved.nodes.Person.create({ name: "Alice" });
      const tag = await evolved.getNodeCollectionOrThrow("Tag").create({
        label: "author",
      });
      await evolved.identity.assertSame(person, tag);
      expect(await evolved.identity.membersOf(person)).toEqual([
        { kind: "Person", id: person.id },
        { kind: "Tag", id: tag.id },
      ]);
      const beforeRemoval = await evolved.recordedNow();
      expect(beforeRemoval).toBeDefined();

      const removed = await evolved.removeKinds(["Tag"]);
      const afterRemoval = await removed.recordedNow();
      expect(afterRemoval).toBeDefined();

      expect(await removed.identity.assertionsOf(person)).toEqual([]);
      expect(
        await removed
          .asOfRecorded(requireDefined(beforeRemoval))
          .identity.assertionsOf(person),
      ).toHaveLength(1);
      expect(
        await removed
          .asOfRecorded(requireDefined(afterRemoval))
          .identity.assertionsOf(person),
      ).toEqual([]);
    });

    it("detaches on delete, does not revive assertions, and folds on recreate", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "alice" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "company" },
      );
      await store.identity.assertSame(person, company);
      await store.nodes.Person.delete(person.id);
      const recreated = await store.nodes.Person.create(
        { name: "Alice Again" },
        { id: "alice" },
      );

      expect(await store.identity.assertionsOf(recreated)).toEqual([]);
      expect(await store.identity.membersOf(recreated)).toEqual([
        { kind: "Person", id: "alice" },
      ]);
    });

    it("bulk deletion detaches every deleted identity member", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "bulk-delete-alice" },
      );
      const aliceCompany = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "bulk-delete-alice-company" },
      );
      const bob = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "bulk-delete-bob" },
      );
      const bobCompany = await store.nodes.Company.create(
        { name: "Bob LLC" },
        { id: "bulk-delete-bob-company" },
      );
      await store.identity.assertSame(alice, aliceCompany);
      await store.identity.assertSame(bob, bobCompany);

      await store.nodes.Person.bulkDelete([alice.id, bob.id]);

      for (const [person, company] of [
        [alice, aliceCompany],
        [bob, bobCompany],
      ] as const) {
        const rows = await readAssertionRows(store, person);
        expect(rows).toHaveLength(1);
        expect(rows.every((row) => isEndedRow(row))).toBe(true);
        expect(await store.identity.assertionsOf(company)).toEqual([]);
        expect(await store.identity.membersOf(company)).toEqual([
          { kind: "Company", id: company.id },
        ]);
      }
    });

    it("repairs corrupted derived closure without changing truth", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create({ name: "Alice" });
      const company = await store.nodes.Company.create({ name: "Alice LLC" });
      const { assertion } = await store.identity.assertSame(person, company);
      const schema = createSqlSchema(store.backend.tableNames);
      if (store.backend.executeStatement === undefined) {
        throw new Error("Integration backend cannot corrupt derived closure");
      }
      await store.backend.executeStatement(
        asCompiledStatementSql(sql`
          DELETE FROM ${schema.identityClosureTable}
          WHERE graph_id = ${store.graphId}
        `),
      );
      expect(await store.identity.areSame(person, company)).toBe(false);

      await rebuildIdentityClosure(store);

      expect(await store.identity.areSame(person, company)).toBe(true);
      expect(await store.identity.assertionsOf(person)).toEqual([assertion]);
    });

    it("hydrates a folded multi-kind class into discriminated nodes", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice", age: 33 },
        { id: "hydrate" },
      );
      await store.nodes.Company.create(
        { name: "Alice LLC", industry: "books" },
        { id: "hydrate" },
      );
      const product = await store.nodes.Product.create(
        { name: "Alice Product", price: 7, category: "test" },
        { id: "hydrate-product" },
      );
      await store.identity.assertSame(person, product);

      const nodes = await store.identity.nodesOf(person);

      expect(nodes).toHaveLength(3);
      const byKind = new Map(nodes.map((node) => [node.kind, node]));
      expect(byKind.get("Person")).toMatchObject({
        id: "hydrate",
        name: "Alice",
        age: 33,
      });
      expect(byKind.get("Company")).toMatchObject({
        id: "hydrate",
        name: "Alice LLC",
        industry: "books",
      });
      expect(byKind.get("Product")).toMatchObject({
        id: "hydrate-product",
        name: "Alice Product",
        price: 7,
        category: "test",
      });
    });

    it("hydrates classes through valid-time and recorded views", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Vera" },
        { id: "view-hydrate" },
      );
      await store.nodes.Company.create(
        { name: "Vera LLC" },
        { id: "view-hydrate" },
      );
      const now = new Date().toISOString();

      const expectClassNodes = (
        nodes: readonly { kind: string; id: string }[],
      ) => {
        expect(nodes).toHaveLength(2);
        const byKind = new Map(nodes.map((node) => [node.kind, node]));
        expect(byKind.get("Person")).toMatchObject({
          id: "view-hydrate",
          name: "Vera",
        });
        expect(byKind.get("Company")).toMatchObject({
          id: "view-hydrate",
          name: "Vera LLC",
        });
      };

      expectClassNodes(await store.asOf(now).identity.nodesOf(person));
      expectClassNodes(
        await store.view({ mode: "includeEnded" }).identity.nodesOf(person),
      );

      const [recordedStore] = await createStoreWithSchema(
        context.getStore().graph,
        context.getStore().backend,
        { history: true },
      );
      const recordedPerson = await recordedStore.nodes.Person.create(
        { name: "Vera" },
        { id: "view-hydrate-recorded" },
      );
      await recordedStore.nodes.Company.create(
        { name: "Vera LLC" },
        { id: "view-hydrate-recorded" },
      );
      const pin = await recordedStore.recordedNow();
      expect(pin).toBeDefined();
      const recordedNodes = await recordedStore
        .asOfRecorded(requireDefined(pin))
        .identity.nodesOf(recordedPerson);
      expect(recordedNodes).toHaveLength(2);
      expect(
        new Map(recordedNodes.map((node) => [node.kind, node])).get("Company"),
      ).toMatchObject({ id: "view-hydrate-recorded", name: "Vera LLC" });
    });

    it("hydrates a tombstoned member the includeTombstones coordinate surfaces", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Tomb" },
        { id: "tomb-seed" },
      );
      // Deleting a PEER detaches it from the class (event-driven identity),
      // but the deleted SEED itself stays visible under includeTombstones —
      // the closure's singleton fallback names it and the all-rows-visible
      // predicate keeps it. membersOf and nodesOf must agree on it.
      await store.nodes.Person.delete(person.id);
      const view = store.view({ mode: "includeTombstones" });

      expect(await view.identity.membersOf(person)).toEqual([
        { kind: "Person", id: "tomb-seed" },
      ]);
      const nodes = await view.identity.nodesOf(person);
      expect(nodes).toHaveLength(1);
      expect(nodes[0]).toMatchObject({ id: "tomb-seed", name: "Tomb" });

      // Outside the tombstone lens the seed is gone from both reads alike.
      expect(await store.identity.membersOf(person)).toEqual([]);
      expect(await store.identity.nodesOf(person)).toEqual([]);
    });

    it("ends assertion rows on soft delete and removes them on hard delete", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "erased-person" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "erased-company" },
      );
      await store.identity.assertSame(person, company);
      const personRef = { kind: "Person", id: "erased-person" };

      await store.nodes.Person.delete(person.id);
      const afterSoftDelete = await readAssertionRows(store, personRef);
      expect(afterSoftDelete).toHaveLength(1);
      expect(afterSoftDelete.every((row) => isEndedRow(row))).toBe(true);
      expect(await store.identity.assertionsOf(company)).toEqual([]);

      await store.nodes.Person.hardDelete(person.id);

      expect(await readAssertionRows(store, personRef)).toEqual([]);
      expect(await store.identity.assertionsOf(company)).toEqual([]);
      expect(await store.identity.membersOf(company)).toEqual([
        { kind: "Company", id: "erased-company" },
      ]);
    });

    it("stamps the deleting node on the assertions its soft delete ends", async () => {
      const store = context.getStore();
      const alice = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "cause-alice" },
      );
      const aliceCo = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "cause-alice-co" },
      );
      const bob = await store.nodes.Person.create(
        { name: "Bob" },
        { id: "cause-bob" },
      );
      const bobCo = await store.nodes.Company.create(
        { name: "Bob LLC" },
        { id: "cause-bob-co" },
      );
      const cascaded = await store.identity.assertSame(alice, aliceCo);
      const retracted = await store.identity.assertSame(bob, bobCo);

      await store.identity.retractAssertion(retracted.assertion.id);
      await store.nodes.Person.delete(alice.id);

      const rows = await storeRuntime(store).identityAssertionRowsByIds([
        cascaded.assertion.id,
        retracted.assertion.id,
      ]);
      // The cascade names the node that caused it — one of the row's own
      // endpoints, never the surviving one.
      expect(rows.get(cascaded.assertion.id)?.endedBy).toEqual({
        kind: "Person",
        id: "cause-alice",
      });
      // An explicit retraction ended nothing on anyone's behalf.
      expect(rows.get(retracted.assertion.id)?.validTo).toBeDefined();
      expect(rows.get(retracted.assertion.id)?.endedBy).toBeUndefined();
    });

    it("leaves no cause on a retraction issued in the deletion's own instant", async () => {
      // The residue the stored cause exists to remove: at millisecond
      // resolution these two acts are one instant, so nothing about the stored
      // WINDOW can tell them apart. Only the absent stamp can.
      const instant = new Date();
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(instant);
      try {
        const store = context.getStore();
        const person = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "tie-person" },
        );
        const company = await store.nodes.Company.create(
          { name: "Alice LLC" },
          { id: "tie-company" },
        );
        const assertion = await store.identity.assertSame(person, company);
        await store.identity.retractAssertion(assertion.assertion.id);
        await store.nodes.Person.delete(person.id);

        const rows = await readAssertionRows(store, {
          kind: "Person",
          id: "tie-person",
        });
        const row = requireDefined(rows[0]);
        const deleted = requireDefined(
          await store
            .view({ mode: "includeTombstones" })
            .nodes.Person.getById(person.id),
        );
        // Same stored instant on both sides — the equality the superseded
        // derivation read as proof of a cascade.
        expect(toInstant(row.valid_to)).toBe(deleted.meta.deletedAt);
        const stored = await storeRuntime(store).identityAssertionRowsByIds([
          assertion.assertion.id,
        ]);
        expect(stored.get(assertion.assertion.id)?.endedBy).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it("mirrors the stored cause into recorded time", async () => {
      const backend = context.getStore().backend;
      const [store] = await createStoreWithSchema(
        context.getStore().graph,
        backend,
        { history: true },
      );
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "recorded-cause-person" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "recorded-cause-company" },
      );
      const assertion = await store.identity.assertSame(person, company);

      await store.nodes.Person.delete(person.id);

      const schema = createSqlSchema(backend.tableNames);
      const recorded = await backend.execute<
        Readonly<{ op: string; ended_by_kind: unknown; ended_by_id: unknown }>
      >(
        asCompiledRowsSql(sql`
          SELECT op, ended_by_kind, ended_by_id
          FROM ${schema.recordedIdentityAssertionsTable}
          WHERE graph_id = ${store.graphId} AND id = ${assertion.assertion.id}
          ORDER BY recorded_from
        `),
      );
      // The mirror carries the cause with the ending it recorded: the creating
      // image has none, the updating image names the deleted endpoint.
      expect(recorded.map((row) => row.op)).toEqual(["create", "update"]);
      expect(requireDefined(recorded[0]).ended_by_kind ?? undefined).toBe(
        undefined,
      );
      expect(requireDefined(recorded[1]).ended_by_kind).toBe("Person");
      expect(requireDefined(recorded[1]).ended_by_id).toBe(
        "recorded-cause-person",
      );
    });

    it("persists a zero-width window when the clock skews backward", async () => {
      // Both instants are ahead of the real clock so the endpoints stay visible;
      // only their order (retraction before assertion) drives the clamp.
      const assertedAt = new Date(Date.now() + 120_000);
      const retractedAt = new Date(Date.now() + 60_000);
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const store = context.getStore();
        const person = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "skew-person" },
        );
        const company = await store.nodes.Company.create(
          { name: "Alice LLC" },
          { id: "skew-company" },
        );
        vi.setSystemTime(assertedAt);
        const assertion = await store.identity.assertSame(person, company);
        vi.setSystemTime(retractedAt);
        const ended = await store.identity.retractAssertion(
          assertion.assertion.id,
        );

        expect(ended?.validTo).toBe(assertion.assertion.validFrom);
        const rows = await readAssertionRows(store, {
          kind: "Person",
          id: "skew-person",
        });
        const row = requireDefined(rows[0]);
        // The stored window must be zero-width after both bounds pass through
        // the same dialect canonicalization, and must match what the API
        // reported — a truncating dialect would otherwise widen it silently.
        expect(toInstant(row.valid_to)).toBe(toInstant(row.valid_from));
        expect(toInstant(row.valid_to)).toBe(assertion.assertion.validFrom);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-asserts a retracted pair into a live class over a new ledger row", async () => {
      const store = context.getStore();
      const person = await store.nodes.Person.create(
        { name: "Alice" },
        { id: "reassert-person" },
      );
      const company = await store.nodes.Company.create(
        { name: "Alice LLC" },
        { id: "reassert-company" },
      );
      const first = await store.identity.assertSame(person, company);
      await store.identity.retractSameAssertion(person, company);
      expect(await store.identity.areSame(person, company)).toBe(false);
      expect(await store.identity.membersOf(person)).toEqual([
        { kind: "Person", id: "reassert-person" },
      ]);

      const second = await store.identity.assertSame(person, company);

      expect(second.action).toBe("created");
      expect(second.assertion.id).not.toBe(first.assertion.id);
      expect(await store.identity.areSame(person, company)).toBe(true);
      expect(await store.identity.membersOf(person)).toEqual([
        { kind: "Company", id: "reassert-company" },
        { kind: "Person", id: "reassert-person" },
      ]);
      expect(await store.identity.assertionsOf(person)).toEqual([
        second.assertion,
      ]);
      // The retraction ended the first row; it did not replace it.
      const rows = await readAssertionRows(store, {
        kind: "Person",
        id: "reassert-person",
      });
      expect(rows).toHaveLength(2);
      expect(rows.filter((row) => isEndedRow(row))).toHaveLength(1);
    });

    describe("identity-expanded traversal", () => {
      it("expands a single hop through an asserted-same member", async () => {
        const store = await provisionIdentityTraversalStore(context, false);
        const alice = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const alias = await store.nodes.Person.create(
          { name: "Alias" },
          { id: "alias" },
        );
        const bob = await store.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        await store.identity.assertSame(alice, alias);
        await store.edges.link.create(alias, bob, {}, { id: "alias-bob" });

        const ordinary = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", { expand: "none" })
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();
        const expanded = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();

        expect(ordinary).toEqual([]);
        expect(expanded).toEqual([bob.id]);

        // asOf valid-time at "now" agrees with the current expansion.
        const asOfExpanded = await store
          .asOf(new Date().toISOString())
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();
        expect(asOfExpanded).toEqual([bob.id]);
      });

      it("expands identity membership across recursive hops", async () => {
        const store = await provisionIdentityTraversalStore(context, false);
        const alice = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const alias = await store.nodes.Person.create(
          { name: "Alias" },
          { id: "alias" },
        );
        const bob = await store.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        const carol = await store.nodes.Person.create(
          { name: "Carol" },
          { id: "carol" },
        );
        await store.identity.assertSame(alice, alias);
        await store.edges.link.create(alias, bob, {}, { id: "alias-bob" });
        await store.edges.link.create(bob, carol, {}, { id: "bob-carol" });

        const results = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .recursive()
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();

        expect([...results].toSorted()).toEqual([bob.id, carol.id]);
      });

      it("crosses a real edge between folded peers in both directions", async () => {
        const store = await provisionIdentityTraversalStore(context, false);
        const person = await store.nodes.Person.create(
          { name: "Peer person" },
          { id: "peer" },
        );
        const company = await store.nodes.Company.create(
          { name: "Peer company" },
          { id: "peer" },
        );
        // A genuine two-node edge whose endpoints share an id (from_id = to_id)
        // but differ in kind. `expand: "all"` follows the self-inverse `bridge`
        // in both directions; the dedup guard must not mistake this for a
        // true self-loop and suppress one direction.
        await store.edges.bridge.create(
          person,
          company,
          {},
          { id: "peer-peer" },
        );

        const fromPerson = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Peer person"))
          .traverse("bridge", "edge", { expand: "all" })
          .to("Company", "company")
          .select((queryContext) => queryContext.company.id)
          .execute();
        const fromCompany = await store
          .query()
          .from("Company", "company")
          .whereNode("company", (node) => node.name.eq("Peer company"))
          .traverse("bridge", "edge", { expand: "all" })
          .to("Person", "person")
          .select((queryContext) => queryContext.person.id)
          .execute();

        expect(fromPerson).toEqual(["peer"]);
        expect(fromCompany).toEqual(["peer"]);
      });

      it("does not prune a folded peer sharing a visited id on a recursive path", async () => {
        const store = await provisionIdentityTraversalStore(context, false);
        const start = await store.nodes.Person.create(
          { name: "Start" },
          { id: "shared" },
        );
        await store.nodes.Company.create({ name: "Mid" }, { id: "mid" });
        // Folded peer of `start`: same id, different kind. A bare-id cycle token
        // would treat landing on it as a revisit of the start and prune it.
        await store.nodes.Company.create({ name: "Peer" }, { id: "shared" });
        await store.edges.link.create(
          start,
          { kind: "Company", id: "mid" },
          {},
          { id: "start-mid" },
        );
        await store.edges.link.create(
          { kind: "Company", id: "mid" },
          { kind: "Company", id: "shared" },
          {},
          { id: "mid-peer" },
        );

        const results = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Start"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .recursive()
          .to("Company", "company")
          .select((queryContext) => queryContext.company.id)
          .execute();

        expect([...results].toSorted()).toEqual(["mid", "shared"]);
      });

      it("does not route a view(includeEnded) traversal through a retracted assertion", async () => {
        const store = await provisionIdentityTraversalStore(context, false);
        const alice = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const alias = await store.nodes.Person.create(
          { name: "Alias" },
          { id: "alias" },
        );
        const bob = await store.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        const assertion = await store.identity.assertSame(alice, alias);
        await store.edges.link.create(alias, bob, {}, { id: "alias-bob" });
        await store.identity.retractAssertion(assertion.assertion.id);

        const current = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();
        // includeEnded widens NODE visibility to ended rows, but a retracted
        // (ended) assertion must still stop conducting identity.
        const ended = await store
          .view({ mode: "includeEnded" })
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();

        expect(current).toEqual([]);
        expect(ended).toEqual([]);
      });

      it("expands at a recorded instant before a later retraction", async () => {
        const store = await provisionIdentityTraversalStore(context, true);
        const alice = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const alias = await store.nodes.Person.create(
          { name: "Alias" },
          { id: "alias" },
        );
        const bob = await store.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        const assertion = await store.identity.assertSame(alice, alias);
        await store.edges.link.create(alias, bob, {}, { id: "alias-bob" });
        const beforeRetraction = await store.recordedNow();
        expect(beforeRetraction).toBeDefined();
        await store.identity.retractAssertion(assertion.assertion.id);

        const current = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();
        const recorded = await store
          .asOfRecorded(requireDefined(beforeRetraction))
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();

        expect(current).toEqual([]);
        expect(recorded).toEqual([bob.id]);
      });

      it("returns bare node ids in identity-expanded recursive paths", async () => {
        const store = await provisionIdentityTraversalStore(context, false);
        const start = await store.nodes.Person.create(
          { name: "Start" },
          { id: "shared" },
        );
        await store.nodes.Company.create({ name: "Mid" }, { id: "mid" });
        // Folded peer of `start`: same id, different kind. Reaching it makes the
        // compiler's composite (kind, id) path token observable, so this is the
        // case where an unstripped token would leak a kind-prefixed entry.
        await store.nodes.Company.create({ name: "Peer" }, { id: "shared" });
        await store.edges.link.create(
          start,
          { kind: "Company", id: "mid" },
          {},
          { id: "start-mid" },
        );
        await store.edges.link.create(
          { kind: "Company", id: "mid" },
          { kind: "Company", id: "shared" },
          {},
          { id: "mid-peer" },
        );

        const expanded = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Start"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .recursive({ path: "hops" })
          .to("Company", "company")
          .select((queryContext) => queryContext.hops)
          .execute();
        const control = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Start"))
          .traverse("link", "edge", { expand: "none" })
          .recursive({ path: "hops" })
          .to("Company", "company")
          .select((queryContext) => queryContext.hops)
          .execute();

        // Public contract: an array of bare node IDs, identical in shape to a
        // non-identity traversal's path on both dialects.
        expect(sortPaths(expanded)).toEqual([
          ["shared", "mid"],
          ["shared", "mid", "shared"],
        ]);
        // The control stops one hop short: with a bare-id cycle token the peer
        // reads as a revisit of the start. That divergence is exactly what the
        // composite token exists for, and it must not reach the path output.
        expect(sortPaths(control)).toEqual([["shared", "mid"]]);
      });

      it("expands recursively at a historical coordinate", async () => {
        const store = await provisionIdentityTraversalStore(context, true);
        const alice = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "alice" },
        );
        const alias = await store.nodes.Person.create(
          { name: "Alias" },
          { id: "alias" },
        );
        const bob = await store.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        const carol = await store.nodes.Person.create(
          { name: "Carol" },
          { id: "carol" },
        );
        const assertion = await store.identity.assertSame(alice, alias);
        await store.edges.link.create(alias, bob, {}, { id: "alias-bob" });
        await store.edges.link.create(bob, carol, {}, { id: "bob-carol" });
        const beforeRetraction = await store.recordedNow();
        expect(beforeRetraction).toBeDefined();

        // The identity reconstruction is itself a WITH RECURSIVE, so pinning a
        // coordinate nests it inside the traversal's WITH RECURSIVE. Exercise
        // both coordinate kinds against that compiled shape.
        const asOfExpanded = await store
          .asOf(new Date().toISOString())
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .recursive()
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();
        expect([...asOfExpanded].toSorted()).toEqual([bob.id, carol.id]);

        await store.identity.retractAssertion(assertion.assertion.id);

        const current = await store
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .recursive()
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();
        const recorded = await store
          .asOfRecorded(requireDefined(beforeRetraction))
          .query()
          .from("Person", "person")
          .whereNode("person", (node) => node.name.eq("Alice"))
          .traverse("link", "edge", {
            expand: "none",
            includeIdentityMembers: true,
          })
          .recursive()
          .to("Person", "friend")
          .select((queryContext) => queryContext.friend.id)
          .execute();

        expect(current).toEqual([]);
        expect([...recorded].toSorted()).toEqual([bob.id, carol.id]);
      });
    });

    describe('sameIdAcrossKinds: "ignore"', () => {
      it("keeps the assertion ledger without folding same-id nodes", async () => {
        const store = await provisionIdentityIgnoreStore(context);
        const person = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "shared" },
        );
        const company = await store.nodes.Company.create(
          { name: "Alice LLC" },
          { id: "shared" },
        );

        expect(await store.identity.areSame(person, company)).toBe(false);
        expect(await store.identity.membersOf(person)).toEqual([
          { kind: "Person", id: "shared" },
        ]);
        expect(await store.identity.membersOf(company)).toEqual([
          { kind: "Company", id: "shared" },
        ]);

        const assertion = await store.identity.assertSame(person, company);

        expect(await store.identity.areSame(person, company)).toBe(true);
        expect(await store.identity.membersOf(person)).toEqual([
          { kind: "Company", id: "shared" },
          { kind: "Person", id: "shared" },
        ]);

        await store.identity.retractAssertion(assertion.assertion.id);

        expect(await store.identity.areSame(person, company)).toBe(false);
        expect(await store.identity.membersOf(person)).toEqual([
          { kind: "Person", id: "shared" },
        ]);
      });

      it("expands traversal over the asserted class only, never over a shared id", async () => {
        const store = await provisionIdentityIgnoreStore(context);
        const person = await store.nodes.Person.create(
          { name: "Alice" },
          { id: "shared" },
        );
        const company = await store.nodes.Company.create(
          { name: "Alice LLC" },
          { id: "shared" },
        );
        const bob = await store.nodes.Person.create(
          { name: "Bob" },
          { id: "bob" },
        );
        await store.edges.link.create(company, bob, {}, { id: "company-bob" });

        async function expandedFriends(): Promise<readonly string[]> {
          return store
            .query()
            .from("Person", "person")
            .whereNode("person", (node) => node.name.eq("Alice"))
            .traverse("link", "edge", {
              expand: "none",
              includeIdentityMembers: true,
            })
            .to("Person", "friend")
            .select((queryContext) => queryContext.friend.id)
            .execute();
        }

        // Sharing an id is not identity under this profile, so the expansion
        // agrees with the closure: no members, no extra reach.
        expect(await expandedFriends()).toEqual([]);

        await store.identity.assertSame(person, company);

        expect(await store.identity.membersOf(person)).toEqual([
          { kind: "Company", id: "shared" },
          { kind: "Person", id: "shared" },
        ]);
        expect(await expandedFriends()).toEqual([bob.id]);
      });
    });
  });
}
