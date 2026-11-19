import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  expr,
  param as parameter,
} from "../../../src";
import { requireDefined } from "../../../src/utils/presence";
import { TEMPORAL_ANCHORS } from "../../test-utils";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

/**
 * A kind whose own properties reuse metadata names, so every test also proves
 * `$meta.version` / `$meta.createdAt` read the system column and the bare
 * names stay the declared properties.
 */
const MetaRelease = defineNode("MetaRelease", {
  schema: z.object({
    title: z.string(),
    version: z.string(),
    createdAt: z.string().optional(),
  }),
});
const metaSupersedes = defineEdge("metaSupersedes", {
  schema: z.object({ version: z.number() }),
});

const metadataGraph = defineGraph({
  id: "metadata_predicates",
  nodes: { MetaRelease: { type: MetaRelease } },
  edges: {
    metaSupersedes: {
      type: metaSupersedes,
      from: [MetaRelease],
      to: [MetaRelease],
    },
  },
});

type MetadataStore = InspectableStore<typeof metadataGraph>;

const { PAST, BEFORE, EDGE_ENDED, FUTURE } = TEMPORAL_ANCHORS;

/**
 * Three releases at stored versions 1, 2 and 3. Every one declares the
 * property `version: "2.0"`, which a `$meta.version` predicate must ignore.
 */
async function seedVersions(store: MetadataStore) {
  const first = await store.nodes.MetaRelease.create({
    title: "first",
    version: "2.0",
  });
  const second = await store.nodes.MetaRelease.create({
    title: "second",
    version: "2.0",
  });
  await store.nodes.MetaRelease.update(second.id, { title: "second" });
  const third = await store.nodes.MetaRelease.create({
    title: "third",
    version: "2.0",
  });
  await store.nodes.MetaRelease.update(third.id, { title: "third" });
  await store.nodes.MetaRelease.update(third.id, { title: "third" });
  return { first, second, third };
}

function titles(rows: readonly string[]): string[] {
  return rows.toSorted();
}

/**
 * The error class `run` refuses with, building and executing the query, or
 * `"ran"` when it executes. A driver error carries the engine's class, so a
 * refusal that only one engine raises reads differently on each backend.
 */
async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return "ran";
  } catch (error) {
    return error instanceof Error ? error.name : typeof error;
  }
}

export function registerMetadataPredicateIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Metadata predicates ($meta)", () => {
    it("filters a node alias by its stored version, not a property named version", async () => {
      const store = await context.createStore(metadataGraph);
      await seedVersions(store);
      const releases = () => store.query().from("MetaRelease", "r");

      const results = {
        inList: titles(
          await releases()
            .whereNode("r", (r) => r.$meta.version.in([1, 3]))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        atLeastTwo: titles(
          await releases()
            .whereNode("r", (r) => r.$meta.version.gte(2))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        between: titles(
          await releases()
            .whereNode("r", (r) => r.$meta.version.between(2, 3))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        notIn: titles(
          await releases()
            .whereNode("r", (r) => r.$meta.version.notIn([2]))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        property: titles(
          await releases()
            .whereNode("r", (r) =>
              r.version.eq("2.0").and(r.$meta.version.eq(2)),
            )
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
      };

      expect(results).toEqual({
        inList: ["first", "third"],
        atLeastTwo: ["second", "third"],
        between: ["second", "third"],
        notIn: ["first", "third"],
        property: ["second"],
      });
    });

    it("filters by validity timestamps with Date and ISO string operands", async () => {
      const store = await context.createStore(metadataGraph);
      await store.nodes.MetaRelease.create(
        { title: "past", version: "1" },
        { validFrom: PAST },
      );
      await store.nodes.MetaRelease.create(
        { title: "before", version: "1" },
        { validFrom: BEFORE, validTo: FUTURE },
      );
      const releases = () => store.query().from("MetaRelease", "r");

      const results = {
        startedBefore: titles(
          await releases()
            .whereNode("r", (r) => r.$meta.validFrom.lt(new Date(BEFORE)))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        startedFrom: titles(
          await releases()
            .whereNode("r", (r) => r.$meta.validFrom.gte(BEFORE))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        startedBetween: titles(
          await releases()
            .whereNode("r", (r) =>
              r.$meta.validFrom.between(new Date(PAST), new Date(EDGE_ENDED)),
            )
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        startedExactly: titles(
          await releases()
            .whereNode("r", (r) => r.$meta.validFrom.eq(new Date(PAST)))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        bounded: titles(
          await releases()
            .whereNode("r", (r) => r.$meta.validTo.isNotNull())
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
      };

      expect(results).toEqual({
        startedBefore: ["past"],
        startedFrom: ["before"],
        startedBetween: ["before", "past"],
        startedExactly: ["past"],
        bounded: ["before"],
      });
    });

    it("compares the system created and updated timestamps, not a property named createdAt", async () => {
      const store = await context.createStore(metadataGraph);
      const created = await store.nodes.MetaRelease.create({
        title: "stamped",
        version: "1",
        createdAt: PAST,
      });
      const createdAt = new Date(created.meta.createdAt);
      const releases = () => store.query().from("MetaRelease", "r");

      const results = {
        exact: await releases()
          .whereNode("r", (r) => r.$meta.createdAt.eq(createdAt))
          .select((ctx) => ctx.r.title)
          .execute(),
        future: await releases()
          .whereNode("r", (r) => r.$meta.createdAt.gt(new Date(FUTURE)))
          .select((ctx) => ctx.r.title)
          .execute(),
        updatedSinceCreation: await releases()
          .whereNode("r", (r) => r.$meta.updatedAt.gte(createdAt))
          .select((ctx) => ctx.r.title)
          .execute(),
        property: await releases()
          .whereNode("r", (r) => r.createdAt.eq(PAST))
          .select((ctx) => ctx.r.title)
          .execute(),
      };

      expect(results).toEqual({
        exact: ["stamped"],
        future: [],
        updatedSinceCreation: ["stamped"],
        property: ["stamped"],
      });
    });

    it("narrows the rows the temporal mode admits and never widens them, like the $meta expression form", async () => {
      const store = await context.createStore(metadataGraph);
      const deleted = await store.nodes.MetaRelease.create({
        title: "deleted",
        version: "1",
      });
      await store.nodes.MetaRelease.create({ title: "live", version: "1" });
      await store.nodes.MetaRelease.create(
        { title: "ended", version: "1" },
        { validFrom: PAST, validTo: EDGE_ENDED },
      );
      await store.nodes.MetaRelease.delete(deleted.id);

      async function deletedTitles(
        mode: "current" | "includeEnded" | "includeTombstones",
      ) {
        const releases = () =>
          store.query().from("MetaRelease", "r").temporal(mode);
        return {
          predicate: titles(
            await releases()
              .whereNode("r", (r) => r.$meta.deletedAt.isNotNull())
              .select((ctx) => ctx.r.title)
              .execute(),
          ),
          expression: titles(
            await releases()
              .where((ctx) => expr.isNotNull(ctx.r.$meta.deletedAt))
              .select((ctx) => ctx.r.title)
              .execute(),
          ),
          ended: titles(
            await releases()
              .whereNode("r", (r) => r.$meta.validTo.lte(new Date()))
              .select((ctx) => ctx.r.title)
              .execute(),
          ),
          live: titles(
            await releases()
              .whereNode("r", (r) => r.$meta.deletedAt.isNull())
              .select((ctx) => ctx.r.title)
              .execute(),
          ),
        };
      }

      expect({
        current: await deletedTitles("current"),
        includeEnded: await deletedTitles("includeEnded"),
        includeTombstones: await deletedTitles("includeTombstones"),
      }).toEqual({
        current: { predicate: [], expression: [], ended: [], live: ["live"] },
        includeEnded: {
          predicate: [],
          expression: [],
          ended: ["ended"],
          live: ["ended", "live"],
        },
        includeTombstones: {
          predicate: ["deleted"],
          expression: ["deleted"],
          ended: ["ended"],
          live: ["ended", "live"],
        },
      });
    });

    it("filters an edge alias by its metadata from both builder stages", async () => {
      const store = await context.createStore(metadataGraph);
      const newest = await store.nodes.MetaRelease.create({
        title: "newest",
        version: "3",
      });
      const middle = await store.nodes.MetaRelease.create({
        title: "middle",
        version: "2",
      });
      const oldest = await store.nodes.MetaRelease.create({
        title: "oldest",
        version: "1",
      });
      await store.edges.metaSupersedes.create(
        newest,
        middle,
        { version: 2 },
        { validFrom: BEFORE },
      );
      const removed = await store.edges.metaSupersedes.create(
        middle,
        oldest,
        { version: 1 },
        { validFrom: PAST },
      );

      const traversalStage = await store
        .query()
        .from("MetaRelease", "newer")
        .traverse("metaSupersedes", "link")
        .whereEdge("link", (link) => link.$meta.validFrom.lt(new Date(BEFORE)))
        .to("MetaRelease", "older")
        .select((ctx) => ctx.older.title)
        .execute();
      const builderStage = await store
        .query()
        .from("MetaRelease", "newer")
        .traverse("metaSupersedes", "link")
        .to("MetaRelease", "older")
        .whereEdge("link", (link) =>
          link.version.eq(2).and(link.$meta.validFrom.gte(BEFORE)),
        )
        .select((ctx) => ctx.older.title)
        .execute();

      await store.edges.metaSupersedes.delete(removed.id);
      const deletedLinks = await store
        .query()
        .from("MetaRelease", "newer")
        .temporal("includeTombstones")
        .traverse("metaSupersedes", "link")
        .whereEdge("link", (link) => link.$meta.deletedAt.isNotNull())
        .to("MetaRelease", "older")
        .select((ctx) => ctx.older.title)
        .execute();

      expect({ traversalStage, builderStage, deletedLinks }).toEqual({
        traversalStage: ["oldest"],
        builderStage: ["middle"],
        deletedLinks: ["oldest"],
      });
    });

    it("filters a traversal target node by its metadata", async () => {
      const store = await context.createStore(metadataGraph);
      const { first, second, third } = await seedVersions(store);
      await store.edges.metaSupersedes.create(first, second, { version: 1 });
      await store.edges.metaSupersedes.create(first, third, { version: 1 });

      const rows = await store
        .query()
        .from("MetaRelease", "newer")
        .traverse("metaSupersedes", "link")
        .to("MetaRelease", "older")
        .whereNode("older", (older) => older.$meta.version.eq(3))
        .select((ctx) => ctx.older.title)
        .execute();

      expect(rows).toEqual(["third"]);
    });

    it("reads version in the expression context", async () => {
      const store = await context.createStore(metadataGraph);
      await seedVersions(store);

      const rows = await store
        .query()
        .from("MetaRelease", "r")
        .where((ctx) => expr.gte(ctx.r.$meta.version, expr.literal(2)))
        .project((ctx) => ({
          title: ctx.r.title,
          version: ctx.r.$meta.version,
        }))
        .orderBy((ctx) => ctx.r.$meta.version, "asc")
        .execute();

      expect(rows).toEqual([
        { title: "second", version: 2 },
        { title: "third", version: 3 },
      ]);
    });

    it("binds metadata parameters in a prepared query on every execution", async () => {
      const store = await context.createStore(metadataGraph);
      await seedVersions(store);
      const byVersion = store
        .query()
        .from("MetaRelease", "r")
        .whereNode("r", (r) => r.$meta.version.eq(parameter("version")))
        .select((ctx) => ctx.r.title)
        .prepare();
      const byVersions = store
        .query()
        .from("MetaRelease", "r")
        .whereNode("r", (r) => r.$meta.version.in(parameter("versions")))
        .select((ctx) => ctx.r.title)
        .prepare();
      const createdUntil = store
        .query()
        .from("MetaRelease", "r")
        .whereNode("r", (r) => r.$meta.createdAt.lte(parameter("until")))
        .select((ctx) => ctx.r.title)
        .prepare();

      const beforeLate = titles(
        await createdUntil.execute({ until: new Date(FUTURE) }),
      );
      await store.nodes.MetaRelease.create({ title: "late", version: "1" });

      expect({
        two: await byVersion.execute({ version: 2 }),
        three: await byVersion.execute({ version: 3 }),
        oneOrThree: titles(await byVersions.execute({ versions: [1, 3] })),
        beforeLate,
        afterLate: titles(
          await createdUntil.execute({ until: new Date(FUTURE) }),
        ),
        none: await createdUntil.execute({ until: new Date(PAST) }),
      }).toEqual({
        two: ["second"],
        three: ["third"],
        oneOrThree: ["first", "late", "third"],
        beforeLate: ["first", "second", "third"],
        afterLate: ["first", "late", "second", "third"],
        none: [],
      });
    });

    it("refuses a version operand that is not a 32-bit integer before any SQL runs, literal or bound", async () => {
      const store = await context.createStore(metadataGraph);
      await seedVersions(store);
      const releases = () => store.query().from("MetaRelease", "r");
      const boundScalar = releases()
        .whereNode("r", (r) => r.$meta.version.gt(parameter("version")))
        .select((ctx) => ctx.r.title)
        .prepare();
      const boundList = releases()
        .whereNode("r", (r) => r.$meta.version.in(parameter("versions")))
        .select((ctx) => ctx.r.title)
        .prepare();
      const boundBetween = releases()
        .whereNode("r", (r) =>
          r.$meta.version.between(parameter("low"), parameter("high")),
        )
        .select((ctx) => ctx.r.title)
        .prepare();

      const outcomes = {
        fractional: await refusal(() =>
          releases()
            .whereNode("r", (r) => r.$meta.version.gt(1.5))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        fractionalListElement: await refusal(() =>
          releases()
            .whereNode("r", (r) => r.$meta.version.in([1.5, 2]))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        fractionalBound: await refusal(() =>
          releases()
            .whereNode("r", (r) => r.$meta.version.between(1, 2.5))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        beyondInt32: await refusal(() =>
          releases()
            .whereNode("r", (r) => r.$meta.version.lt(2 ** 31))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        boundFractional: await refusal(() =>
          boundScalar.execute({ version: 1.5 }),
        ),
        boundFractionalListElement: await refusal(() =>
          boundList.execute({ versions: [1.5, 2] }),
        ),
        boundFractionalBetween: await refusal(() =>
          boundBetween.execute({ low: 1, high: 2.5 }),
        ),
        boundInteger: titles(await boundScalar.execute({ version: 1 })),
        boundIntegerBetween: titles(
          await boundBetween.execute({ low: 2, high: 3 }),
        ),
      };

      expect(outcomes).toEqual({
        fractional: "ValidationError",
        fractionalListElement: "ValidationError",
        fractionalBound: "ValidationError",
        beyondInt32: "ValidationError",
        boundFractional: "ValidationError",
        boundFractionalListElement: "ValidationError",
        boundFractionalBetween: "ValidationError",
        boundInteger: ["second", "third"],
        boundIntegerBetween: ["second", "third"],
      });
    });

    it("refuses a non-canonical timestamp string operand, literal or bound, so both engines compare the same instant", async () => {
      const store = await context.createStore(metadataGraph);
      await store.nodes.MetaRelease.create(
        { title: "boundary", version: "1" },
        { validFrom: BEFORE },
      );
      const releases = () => store.query().from("MetaRelease", "r");
      // The same instant as BEFORE ("2021-01-01T00:00:00.000Z"), but text
      // that sorts after it: a text comparison and an instant comparison
      // disagree on it.
      const shortForm = "2021-01-01T00:00:00Z";
      const boundScalar = releases()
        .whereNode("r", (r) => r.$meta.validFrom.lt(parameter("until")))
        .select((ctx) => ctx.r.title)
        .prepare();
      const boundList = releases()
        .whereNode("r", (r) => r.$meta.validFrom.in(parameter("instants")))
        .select((ctx) => ctx.r.title)
        .prepare();

      const outcomes = {
        literal: await refusal(() =>
          releases()
            .whereNode("r", (r) => r.$meta.validFrom.lt(shortForm))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        listElement: await refusal(() =>
          releases()
            // A typed caller cannot pass a string element; an untyped one can.
            // @ts-expect-error -- a date in() list is typed Date[]
            .whereNode("r", (r) => r.$meta.validFrom.in([shortForm]))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        betweenBound: await refusal(() =>
          releases()
            .whereNode("r", (r) => r.$meta.validFrom.between(PAST, shortForm))
            .select((ctx) => ctx.r.title)
            .execute(),
        ),
        bound: await refusal(() => boundScalar.execute({ until: shortForm })),
        boundListElement: await refusal(() =>
          boundList.execute({ instants: [shortForm] }),
        ),
        canonicalBefore: await releases()
          .whereNode("r", (r) => r.$meta.validFrom.lt(BEFORE))
          .select((ctx) => ctx.r.title)
          .execute(),
        canonicalAtOrBefore: await releases()
          .whereNode("r", (r) => r.$meta.validFrom.lte(BEFORE))
          .select((ctx) => ctx.r.title)
          .execute(),
        boundCanonical: await boundScalar.execute({ until: BEFORE }),
        boundDate: await boundList.execute({ instants: [new Date(BEFORE)] }),
      };

      expect(outcomes).toEqual({
        literal: "ValidationError",
        listElement: "ValidationError",
        betweenBound: "ValidationError",
        bound: "ValidationError",
        boundListElement: "ValidationError",
        canonicalBefore: [],
        canonicalAtOrBefore: ["boundary"],
        boundCanonical: [],
        boundDate: ["boundary"],
      });
    });

    it("applies the same operand checks to $meta comparisons in the expression context", async () => {
      const store = await context.createStore(metadataGraph);
      await seedVersions(store);
      await store.nodes.MetaRelease.create(
        { title: "boundary", version: "1" },
        { validFrom: BEFORE },
      );
      const releases = () => store.query().from("MetaRelease", "r");
      const boundVersion = releases()
        .where((ctx) =>
          expr.gt(ctx.r.$meta.version, expr.param("version", "number")),
        )
        .project((ctx) => ({ title: ctx.r.title }))
        .prepare();
      const boundUntil = releases()
        .where((ctx) =>
          expr.gt(expr.param("until", "string"), ctx.r.$meta.validFrom),
        )
        .project((ctx) => ({ title: ctx.r.title }))
        .prepare();

      const boundIntegerRows = await boundVersion.execute({ version: 2 });

      const outcomes = {
        fractionalLiteral: await refusal(() =>
          releases()
            .where((ctx) => expr.gt(ctx.r.$meta.version, expr.literal(1.5)))
            .project((ctx) => ({ title: ctx.r.title }))
            .execute(),
        ),
        boundFractional: await refusal(() =>
          boundVersion.execute({ version: 1.5 }),
        ),
        shortTimestampLiteral: await refusal(() =>
          releases()
            .where((ctx) =>
              expr.lt(
                ctx.r.$meta.validFrom,
                expr.literal("2021-01-01T00:00:00Z"),
              ),
            )
            .project((ctx) => ({ title: ctx.r.title }))
            .execute(),
        ),
        boundShortTimestamp: await refusal(() =>
          boundUntil.execute({ until: "2021-01-01T00:00:00Z" }),
        ),
        boundInteger: titles(boundIntegerRows.map((row) => row.title)),
        boundCanonical: await boundUntil.execute({ until: BEFORE }),
      };

      expect(outcomes).toEqual({
        fractionalLiteral: "ValidationError",
        boundFractional: "ValidationError",
        shortTimestampLiteral: "ValidationError",
        boundShortTimestamp: "ValidationError",
        boundInteger: ["third"],
        boundCanonical: [],
      });
    });

    it("accepts $meta in collection find and updateWhere predicates", async () => {
      const store = await context.createStore(metadataGraph);
      await seedVersions(store);

      const found = await store.nodes.MetaRelease.find({
        where: (r) => r.$meta.version.gte(2),
      });
      const { affectedCount } = await store.nodes.MetaRelease.updateWhere({
        patch: { title: "renamed" },
        where: (r) => r.$meta.version.eq(1),
      });
      const renamed = await store.nodes.MetaRelease.find({
        where: (r) => r.title.eq("renamed"),
      });

      expect({
        found: titles(found.map((node) => node.title)),
        affectedCount,
        renamedVersion: requireDefined(renamed[0]).meta.version,
      }).toEqual({
        found: ["second", "third"],
        affectedCount: 1,
        renamedVersion: 2,
      });
    });
  });
}
