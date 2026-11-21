/**
 * Long query aliases on every backend.
 *
 * The query builder accepts an alias of up to 63 characters, and the compiler
 * derives further SQL identifiers from it (`<alias>_<column>`, `cte_<alias>`,
 * `<alias>_<field>` projections, ...). PostgreSQL clips every identifier to
 * 63 bytes, so before generated names were bounded through one owner, two
 * names that differed only after byte 63 became one identifier there while
 * SQLite kept them apart: the same query ran on one backend and failed (or
 * read the wrong column) on the other. Each case below runs at every alias
 * length around the limit so both sides of every clipping boundary are pinned.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import {
  count,
  defineEdge,
  defineGraph,
  defineNode,
  field,
  param as parameter,
  partOf,
  ValidationError,
} from "../../../src";
import { shortenedIdentifier } from "../../../src/query/generated-identifier";
import { requireDefined } from "../../../src/utils/presence";
import type { IntegrationTestContext } from "./test-context";

/** A multi-byte field name projected at every alias length. */
const MULTI_BYTE_FIELD = "étiquette_ünïcödé";

/**
 * With {@link BYTE_LIMIT_ALIAS}, `<alias>_<field>` is 63 bytes for the first
 * field and 65 bytes for the second, though both are under 63 characters.
 * Clipping the second to 63 bytes ends on a character boundary at the first.
 */
const SIX_TWO_BYTE_CHARACTERS = "éééééé";
const SEVEN_TWO_BYTE_CHARACTERS = "ééééééé";
const BYTE_LIMIT_ALIAS = `a${"b".repeat(49)}`;

/**
 * The tail that makes `prefix + tail` spell exactly the shortened form of
 * `longName`: a name that fits in 63 bytes, is valid on its own, and would be
 * emitted verbatim. Shortening must never hand a longer name the physical
 * name a fitting one already owns.
 */
function shortenedNameTail(prefix: string, longName: string): string {
  const shortened = shortenedIdentifier(longName);
  if (shortened === longName || !shortened.startsWith(prefix))
    throw new Error(`"${longName}" does not shorten under "${prefix}"`);
  return shortened.slice(prefix.length);
}

/** A node alias short enough that its long field names shorten under it. */
const CLASH_ALIAS = "clash_root";
/**
 * A field whose `<alias>_<field>` name exceeds 63 bytes. Like the aliases,
 * runtime-computed field names are typed as a literal label.
 */
const CLASH_LONG_FIELD = `long_field_${"x".repeat(60)}` as "clashLongField";
/** A field whose `<alias>_<field>` name is the shortened form of the long one. */
const CLASH_SHORT_FIELD = shortenedNameTail(
  `${CLASH_ALIAS}_`,
  `${CLASH_ALIAS}_${CLASH_LONG_FIELD}`,
) as "clashShortField";
/** A 63-character alias whose `cte_<alias>` name must be shortened. */
const CLASH_LONG_ALIAS = `a${"b".repeat(61)}c` as "clashLongAlias";
/** A fitting alias whose `cte_<alias>` is the shortened `cte_<long alias>`. */
const CTE_SHORT_ALIAS = shortenedNameTail(
  "cte_",
  `cte_${CLASH_LONG_ALIAS}`,
) as "cteShortAlias";
/** A fitting alias whose `lm_<alias>` is the shortened `lm_<long alias>`. */
const TABLE_SHORT_ALIAS = shortenedNameTail(
  "lm_",
  `lm_${CLASH_LONG_ALIAS}`,
) as "tableShortAlias";

const LongAliasItem = defineNode("LongAliasItem", {
  schema: z.object({
    name: z.string(),
    nameSuffix: z.string(),
    nameSuffixExtra: z.string(),
    category: z.string(),
    rank: z.number(),
    [MULTI_BYTE_FIELD]: z.string(),
    [SIX_TWO_BYTE_CHARACTERS]: z.string().optional(),
    [SEVEN_TWO_BYTE_CHARACTERS]: z.string().optional(),
    [CLASH_LONG_FIELD]: z.string().optional(),
    [CLASH_SHORT_FIELD]: z.string().optional(),
  }),
});

const longAliasLink = defineEdge("longAliasLink", {
  schema: z.object({ note: z.string() }),
});

const LongAliasPart = defineNode("LongAliasPart", {
  schema: z.object({ name: z.string() }),
});

const longAliasPartOf = defineEdge("longAliasPartOf", {
  schema: z.object({ position: z.number() }),
});

const longAliasGraph = defineGraph({
  id: "long_alias_graph",
  nodes: {
    LongAliasItem: { type: LongAliasItem },
    LongAliasPart: { type: LongAliasPart },
  },
  edges: {
    longAliasLink: {
      type: longAliasLink,
      from: [LongAliasItem],
      to: [LongAliasItem],
    },
    longAliasPartOf: {
      type: longAliasPartOf,
      from: [LongAliasPart],
      to: [LongAliasItem],
      cardinality: "one",
    },
  },
  ontology: [partOf(LongAliasPart, LongAliasItem, { via: longAliasPartOf })],
});

type LongAliasStore = Awaited<ReturnType<typeof createLongAliasStore>>;

async function createLongAliasStore(context: IntegrationTestContext) {
  return context.createStore(longAliasGraph);
}

/**
 * A store whose traversal `.select()` queries take the selective path, so an
 * ordered, limited projection reaches late materialization.
 */
async function createLateMaterializingStore(context: IntegrationTestContext) {
  return context.createStore(longAliasGraph, {
    queryDefaults: { traversalExpansion: "none" },
  });
}

/**
 * An alias of exactly `length` characters ending in `last`, so aliases of
 * one length differ only in their last character.
 *
 * The builder types aliases as literal keys, which a runtime-computed string
 * cannot be; `Label` is the literal the type checker sees in its place. The
 * label is only a type-level name — every query runs with the long alias.
 */
function aliasOfLength<const Label extends string>(
  length: number,
  last: string,
  _label: Label,
): Label {
  return `a${"b".repeat(length - 2)}${last}` as Label;
}

const ALIAS_LENGTHS = [59, 60, 61, 62, 63] as const;

type SeededItem = Awaited<
  ReturnType<LongAliasStore["nodes"]["LongAliasItem"]["create"]>
>;

type SeededItems = Readonly<{
  first: SeededItem;
  second: SeededItem;
  third: SeededItem;
}>;

async function seedItems(store: LongAliasStore): Promise<SeededItems> {
  const first = await store.nodes.LongAliasItem.create({
    name: "first",
    nameSuffix: "first-suffix",
    nameSuffixExtra: "first-extra",
    category: "odd",
    rank: 1,
    [MULTI_BYTE_FIELD]: "première",
    [SIX_TWO_BYTE_CHARACTERS]: "six",
    [SEVEN_TWO_BYTE_CHARACTERS]: "seven",
    [CLASH_LONG_FIELD]: "long-field",
    [CLASH_SHORT_FIELD]: "short-field",
  });
  const second = await store.nodes.LongAliasItem.create({
    name: "second",
    nameSuffix: "second-suffix",
    nameSuffixExtra: "second-extra",
    category: "even",
    rank: 2,
    [MULTI_BYTE_FIELD]: "deuxième",
  });
  const third = await store.nodes.LongAliasItem.create({
    name: "third",
    nameSuffix: "third-suffix",
    nameSuffixExtra: "third-extra",
    category: "odd",
    rank: 3,
    [MULTI_BYTE_FIELD]: "troisième",
  });
  const part = await store.nodes.LongAliasPart.create({ name: "first-part" });
  await store.edges.longAliasPartOf.create(part, first, { position: 7 });
  await store.edges.longAliasLink.create(first, second, { note: "1-2" });
  await store.edges.longAliasLink.create(second, third, { note: "2-3" });
  return { first, second, third };
}

export function registerLongAliasIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Long query aliases", () => {
    let store: LongAliasStore;
    let items: SeededItems;

    beforeEach(async () => {
      store = await createLongAliasStore(context);
      items = await seedItems(store);
    });

    describe.each(ALIAS_LENGTHS)("at %i characters", (length) => {
      const alias = aliasOfLength(length, "x", "root");
      const otherAlias = aliasOfLength(length, "y", "target");
      const edgeAlias = aliasOfLength(length, "z", "link");

      it("selects a whole node", async () => {
        const rows = await store
          .query()
          .from("LongAliasItem", alias)
          .select((ctx) => requireDefined(ctx[alias]))
          .orderBy(alias, "rank", "asc")
          .execute();

        expect(alias).toHaveLength(length);
        expect(
          rows.map((row) => ({
            id: row.id,
            kind: row.kind,
            name: row.name,
            rank: row.rank,
            version: row.meta.version,
            deletedAt: row.meta.deletedAt,
          })),
        ).toEqual([
          {
            id: items.first.id,
            kind: "LongAliasItem",
            name: "first",
            rank: 1,
            version: 1,
            deletedAt: undefined,
          },
          {
            id: items.second.id,
            kind: "LongAliasItem",
            name: "second",
            rank: 2,
            version: 1,
            deletedAt: undefined,
          },
          {
            id: items.third.id,
            kind: "LongAliasItem",
            name: "third",
            rank: 3,
            version: 1,
            deletedAt: undefined,
          },
        ]);
      });

      it("reads the root id", async () => {
        const rows = await store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.name.eq("second"))
          .select((ctx) => requireDefined(ctx[alias]).id)
          .execute();

        expect(rows).toEqual([items.second.id]);
      });

      it("projects several fields sharing a long prefix", async () => {
        const rows = await store
          .query()
          .from("LongAliasItem", alias)
          .select((ctx) => {
            const item = requireDefined(ctx[alias]);
            return {
              id: item.id,
              name: item.name,
              nameSuffix: item.nameSuffix,
              nameSuffixExtra: item.nameSuffixExtra,
              multiByte: item[MULTI_BYTE_FIELD],
            };
          })
          .orderBy(alias, "rank", "asc")
          .execute();

        expect(rows).toEqual([
          {
            id: items.first.id,
            name: "first",
            nameSuffix: "first-suffix",
            nameSuffixExtra: "first-extra",
            multiByte: "première",
          },
          {
            id: items.second.id,
            name: "second",
            nameSuffix: "second-suffix",
            nameSuffixExtra: "second-extra",
            multiByte: "deuxième",
          },
          {
            id: items.third.id,
            name: "third",
            nameSuffix: "third-suffix",
            nameSuffixExtra: "third-extra",
            multiByte: "troisième",
          },
        ]);
      });

      it("traverses between two aliases differing only in the last character", async () => {
        const rows = await store
          .query()
          .from("LongAliasItem", alias)
          .traverse("longAliasLink", edgeAlias)
          .to("LongAliasItem", otherAlias)
          .select((ctx) => ({
            from: requireDefined(ctx[alias]).name,
            fromId: requireDefined(ctx[alias]).id,
            note: requireDefined(ctx[edgeAlias]).note,
            to: requireDefined(ctx[otherAlias]).name,
            toId: requireDefined(ctx[otherAlias]).id,
          }))
          .orderBy(alias, "rank", "asc")
          .execute();

        expect(rows).toEqual([
          {
            from: "first",
            fromId: items.first.id,
            note: "1-2",
            to: "second",
            toId: items.second.id,
          },
          {
            from: "second",
            fromId: items.second.id,
            note: "2-3",
            to: "third",
            toId: items.third.id,
          },
        ]);
      });

      it("runs a recursive traversal with default depth and path outputs", async () => {
        // The default outputs are named `<alias>_depth` / `<alias>_path`,
        // past the 63-character alias limit for the longer aliases here.
        const depthKey = `${otherAlias}_depth` as const;
        const pathKey = `${otherAlias}_path` as const;
        const rows = await store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.name.eq("first"))
          .traverse("longAliasLink", edgeAlias)
          .recursive({ depth: true, path: true })
          .to("LongAliasItem", otherAlias)
          .select((ctx) => ({
            from: requireDefined(ctx[alias]).name,
            to: requireDefined(ctx[otherAlias]).name,
            depth: ctx[depthKey],
            path: ctx[pathKey],
          }))
          .execute();

        expect(
          rows.toSorted((left, right) => left.to.localeCompare(right.to)),
        ).toEqual([
          {
            from: "first",
            to: "second",
            depth: 1,
            path: [items.first.id, items.second.id],
          },
          {
            from: "first",
            to: "third",
            depth: 2,
            path: [items.first.id, items.second.id, items.third.id],
          },
        ]);
      });

      it("runs a recursive traversal with default outputs inside batchOnce()", async () => {
        const depthKey = `${otherAlias}_depth` as const;
        const pathKey = `${otherAlias}_path` as const;
        const query = store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.name.eq("first"))
          .traverse("longAliasLink", edgeAlias)
          .recursive({ depth: true, path: true })
          .to("LongAliasItem", otherAlias)
          .select((ctx) => ({
            to: requireDefined(ctx[otherAlias]).name,
            depth: ctx[depthKey],
            path: ctx[pathKey],
          }));

        const [rows] = await store.batchOnce(() => [query] as const);

        expect(
          rows.toSorted((left, right) => left.to.localeCompare(right.to)),
        ).toEqual([
          { to: "second", depth: 1, path: [items.first.id, items.second.id] },
          {
            to: "third",
            depth: 2,
            path: [items.first.id, items.second.id, items.third.id],
          },
        ]);
      });

      it("batches a set operation and a cursor page in batchOnce()", async () => {
        const odd = store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.category.eq("odd"))
          .select((ctx) => requireDefined(ctx[alias]));
        const second = store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.name.eq("second"))
          .select((ctx) => requireDefined(ctx[alias]));
        const page = store
          .query()
          .from("LongAliasItem", alias)
          .orderBy(alias, "rank", "desc")
          .select((ctx) => requireDefined(ctx[alias]))
          .page({ first: 2 });

        const [unioned, firstPage] = await store.batchOnce(
          () => [odd.union(second), page] as const,
        );

        expect({
          unioned: unioned.map((item) => item.name).toSorted(),
          page: firstPage.data.map((item) => item.name),
        }).toEqual({
          unioned: ["first", "second", "third"],
          page: ["third", "second"],
        });
      });

      it("orders whole nodes inside withCheckedReads()", async () => {
        const activeSchema = await context
          .getBackend()
          .getActiveSchema(store.graphId);
        const version = activeSchema?.version;

        const names = await store.withCheckedReads(version, async (reads) => {
          const rows = await reads
            .query()
            .from("LongAliasItem", alias)
            .traverse("longAliasLink", edgeAlias)
            .to("LongAliasItem", otherAlias)
            .select((ctx) => ({
              from: requireDefined(ctx[alias]),
              to: requireDefined(ctx[otherAlias]),
            }))
            .orderBy(otherAlias, "rank", "desc")
            .execute();
          return rows.map((row) => [row.from.name, row.to.name]);
        });

        expect(names).toEqual([
          ["second", "third"],
          ["first", "second"],
        ]);
      });

      it("late-materializes fields of two aliases differing only in the last character", async () => {
        const lateStore = await createLateMaterializingStore(context);
        await seedItems(lateStore);

        const rows = await lateStore
          .query()
          .from("LongAliasItem", alias)
          .traverse("longAliasLink", edgeAlias, { expand: "none" })
          .to("LongAliasItem", otherAlias)
          .select((ctx) => ({
            from: requireDefined(ctx[alias]).name,
            fromCategory: requireDefined(ctx[alias]).category,
            to: requireDefined(ctx[otherAlias]).name,
            toSuffix: requireDefined(ctx[otherAlias]).nameSuffix,
          }))
          .orderBy(otherAlias, "rank", "desc")
          .limit(1)
          .execute();

        expect(rows).toEqual([
          {
            from: "second",
            fromCategory: "even",
            to: "third",
            toSuffix: "third-suffix",
          },
        ]);
      });

      it("navigates composition through the derived edge alias", async () => {
        const derivedEdgeAlias = `${otherAlias}_edge` as const;
        const rows = await store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.name.eq("first"))
          .parts(otherAlias)
          .whereEdge(derivedEdgeAlias, (edge) => edge.field("position").eq(7))
          .select((ctx) => ({
            whole: requireDefined(ctx[alias]).name,
            part: requireDefined(ctx[otherAlias])["name"],
          }))
          .execute();

        expect(rows).toEqual([{ whole: "first", part: "first-part" }]);
      });

      it("paginates in both directions", async () => {
        const query = store
          .query()
          .from("LongAliasItem", alias)
          .orderBy(alias, "rank", "asc")
          .select((ctx) => requireDefined(ctx[alias]).name);

        const firstPage = await query.paginate({ first: 2 });
        const secondPage = await query.paginate({
          first: 2,
          after: requireDefined(firstPage.nextCursor),
        });
        const lastPage = await query.paginate({ last: 1 });

        expect({
          first: firstPage.data,
          second: secondPage.data,
          last: lastPage.data,
        }).toEqual({
          first: ["first", "second"],
          second: ["third"],
          last: ["third"],
        });
      });

      it("unions two queries over the same alias", async () => {
        const odd = store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.category.eq("odd"))
          .select((ctx) => requireDefined(ctx[alias]).name);
        const second = store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.name.eq("second"))
          .select((ctx) => requireDefined(ctx[alias]).name);

        const rows = await odd.union(second).execute();

        expect(rows.toSorted()).toEqual(["first", "second", "third"]);
      });

      it("aggregates grouped by a field", async () => {
        const rows = await store
          .query()
          .from("LongAliasItem", alias)
          .groupBy(alias, "category")
          .aggregate({
            category: field(alias, "category"),
            items: count(alias),
          })
          .execute();

        expect(
          rows.toSorted((left, right) =>
            left.category.localeCompare(right.category),
          ),
        ).toEqual([
          { category: "even", items: 1 },
          { category: "odd", items: 2 },
        ]);
      });

      it("orders by a $meta column", async () => {
        await store.nodes.LongAliasItem.update(items.second.id, {
          rank: 20,
        });

        const rows = await store
          .query()
          .from("LongAliasItem", alias)
          .project((ctx) => ({
            name: requireDefined(ctx[alias]).name,
            version: requireDefined(ctx[alias]).$meta.version,
          }))
          .orderBy((ctx) => requireDefined(ctx[alias]).$meta.version, "desc")
          .orderBy((ctx) => requireDefined(ctx[alias]).name, "asc")
          .execute();

        expect(rows).toEqual([
          { name: "second", version: 2 },
          { name: "first", version: 1 },
          { name: "third", version: 1 },
        ]);
      });

      it("executes a prepared query", async () => {
        const prepared = store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.name.eq(parameter("name")))
          .select((ctx) => ({
            id: requireDefined(ctx[alias]).id,
            node: requireDefined(ctx[alias]),
          }))
          .prepare();

        const firstRows = await prepared.execute({ name: "first" });
        const thirdRows = await prepared.execute({ name: "third" });

        expect(
          [...firstRows, ...thirdRows].map((row) => [row.id, row.node.name]),
        ).toEqual([
          [items.first.id, "first"],
          [items.third.id, "third"],
        ]);
      });

      it("updates through updateWhere({ candidates })", async () => {
        const candidates = store
          .query()
          .from("LongAliasItem", alias)
          .whereNode(alias, (item) => item.category.eq("odd"))
          .select((ctx) => requireDefined(ctx[alias]).id);

        const { affectedCount } = await store.nodes.LongAliasItem.updateWhere({
          candidates,
          patch: { category: "updated" },
        });
        const stored = await Promise.all(
          [items.first.id, items.second.id, items.third.id].map(async (id) =>
            requireDefined(await store.nodes.LongAliasItem.getById(id)),
          ),
        );

        expect({
          affectedCount,
          stored: stored.map((item) => [item.category, item.meta.version]),
        }).toEqual({
          affectedCount: 2,
          stored: [
            ["updated", 2],
            ["even", 1],
            ["updated", 2],
          ],
        });
      });
    });

    it("keeps multi-byte projection names distinct at the 63-byte limit", async () => {
      const encoder = new TextEncoder();
      const sixName = `${BYTE_LIMIT_ALIAS}_${SIX_TWO_BYTE_CHARACTERS}`;
      const sevenName = `${BYTE_LIMIT_ALIAS}_${SEVEN_TWO_BYTE_CHARACTERS}`;
      expect([sixName.length, encoder.encode(sixName).byteLength]).toEqual([
        57, 63,
      ]);
      expect([sevenName.length, encoder.encode(sevenName).byteLength]).toEqual([
        58, 65,
      ]);

      const rows = await store
        .query()
        .from("LongAliasItem", BYTE_LIMIT_ALIAS)
        .whereNode(BYTE_LIMIT_ALIAS, (item) => item.name.eq("first"))
        .select((ctx) => {
          const item = requireDefined(ctx[BYTE_LIMIT_ALIAS]);
          return {
            six: item[SIX_TWO_BYTE_CHARACTERS],
            seven: item[SEVEN_TWO_BYTE_CHARACTERS],
          };
        })
        .execute();

      expect(rows).toEqual([{ six: "six", seven: "seven" }]);
    });

    describe("a fitting name equal to the shortened form of a longer one", () => {
      it("keeps two fields distinct in one select list", async () => {
        expect(`${CLASH_ALIAS}_${CLASH_SHORT_FIELD}`).toBe(
          shortenedIdentifier(`${CLASH_ALIAS}_${CLASH_LONG_FIELD}`),
        );

        const rows = await store
          .query()
          .from("LongAliasItem", CLASH_ALIAS)
          .whereNode(CLASH_ALIAS, (item) => item.name.eq("first"))
          .select((ctx) => {
            const item = requireDefined(ctx[CLASH_ALIAS]);
            return {
              long: item[CLASH_LONG_FIELD],
              short: item[CLASH_SHORT_FIELD],
            };
          })
          .execute();

        expect(rows).toEqual([{ long: "long-field", short: "short-field" }]);
      });

      it("keeps two traversal CTE names distinct in one statement", async () => {
        expect(`cte_${CTE_SHORT_ALIAS}`).toBe(
          shortenedIdentifier(`cte_${CLASH_LONG_ALIAS}`),
        );

        const rows = await store
          .query()
          .from("LongAliasItem", CTE_SHORT_ALIAS)
          .whereNode(CTE_SHORT_ALIAS, (item) => item.name.eq("first"))
          .traverse("longAliasLink", "link")
          .to("LongAliasItem", CLASH_LONG_ALIAS)
          .select((ctx) => ({
            from: requireDefined(ctx[CTE_SHORT_ALIAS]).name,
            to: requireDefined(ctx[CLASH_LONG_ALIAS]).name,
          }))
          .execute();

        expect(rows).toEqual([{ from: "first", to: "second" }]);
      });

      it("keeps two late-materialized table aliases distinct", async () => {
        expect(`lm_${TABLE_SHORT_ALIAS}`).toBe(
          shortenedIdentifier(`lm_${CLASH_LONG_ALIAS}`),
        );
        const lateStore = await createLateMaterializingStore(context);
        await seedItems(lateStore);

        const rows = await lateStore
          .query()
          .from("LongAliasItem", TABLE_SHORT_ALIAS)
          .traverse("longAliasLink", "link", { expand: "none" })
          .to("LongAliasItem", CLASH_LONG_ALIAS)
          .select((ctx) => ({
            from: requireDefined(ctx[TABLE_SHORT_ALIAS]).name,
            fromCategory: requireDefined(ctx[TABLE_SHORT_ALIAS]).category,
            to: requireDefined(ctx[CLASH_LONG_ALIAS]).name,
            toSuffix: requireDefined(ctx[CLASH_LONG_ALIAS]).nameSuffix,
          }))
          .orderBy(CLASH_LONG_ALIAS, "rank", "desc")
          .limit(1)
          .execute();

        expect(rows).toEqual([
          {
            from: "second",
            fromCategory: "even",
            to: "third",
            toSuffix: "third-suffix",
          },
        ]);
      });
    });

    it("refuses a multi-byte alias with the same error on every backend", () => {
      // The alias validator admits only ASCII identifiers, so an alias's
      // character count is its byte count; multi-byte text reaches generated
      // identifiers only through field names, covered by the projection case.
      const multiByteAlias = `é${"b".repeat(30)}`;
      expect(new TextEncoder().encode(multiByteAlias).byteLength).toBe(32);

      expect(() => store.query().from("LongAliasItem", multiByteAlias)).toThrow(
        ValidationError,
      );
    });

    it("refuses a 64-character alias", () => {
      expect(() =>
        store.query().from("LongAliasItem", aliasOfLength(64, "x", "tooLong")),
      ).toThrow(ValidationError);
    });
  });
}
