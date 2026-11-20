import { beforeEach, describe, expect, it } from "vitest";

import { expr } from "../../../src";
import type { IntegrationTestContext } from "./test-context";

export function registerMultiRecursiveTraversalIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("Multiple recursive traversal stages", () => {
    beforeEach(async () => {
      const store = context.getStore();
      const root = await store.nodes.Person.create({ name: "Multi root" });
      const middle = await store.nodes.Person.create({ name: "Multi middle" });
      const leaf = await store.nodes.Person.create({ name: "Multi leaf" });
      const tail = await store.nodes.Person.create({ name: "Multi tail" });
      await store.edges.knows.create(root, middle, {});
      await store.edges.knows.create(middle, leaf, {});
      await store.edges.knows.create(leaf, tail, {});
    });

    it("chains recursive stages from completed source identities", async () => {
      const rows = await context
        .getStore()
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1, depth: "firstDepth" })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2, depth: "secondDepth" })
        .to("Person", "target")
        .orderBy("target", "name", "asc")
        .select((row) => ({
          middle: row.middle.name,
          target: row.target.name,
          firstDepth: row.firstDepth,
          secondDepth: row.secondDepth,
        }))
        .execute();

      expect(rows).toEqual([
        {
          middle: "Multi middle",
          target: "Multi leaf",
          firstDepth: 1,
          secondDepth: 1,
        },
        {
          middle: "Multi middle",
          target: "Multi tail",
          firstDepth: 1,
          secondDepth: 2,
        },
      ]);
    });

    it("retains a prior row when an optional recursive stage has no match", async () => {
      const rows = await context
        .getStore()
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 3, maxHops: 3 })
        .to("Person", "tail")
        .optionalTraverse("knows", "missingEdge", { expand: "none" })
        .recursive({
          minHops: 1,
          maxHops: 1,
          depth: "missingDepth",
          path: { format: "qualified", alias: "missingPath" },
        })
        .to("Person", "missing")
        .select((row) => ({
          tail: row.tail.name,
          missing: row.missing?.name,
          depth: row.missingDepth,
          path: row.missingPath,
        }))
        .execute();

      expect(rows).toEqual([
        {
          tail: "Multi tail",
          missing: undefined,
          depth: undefined,
          path: undefined,
        },
      ]);
    });

    it("applies stop-expansion independently within a later stage", async () => {
      const rows = await context
        .getStore()
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2, depth: "secondDepth" })
        .to("Person", "target")
        .stopExpansion("target", (person) => person.name.eq("Multi leaf"))
        .select((row) => ({
          target: row.target.name,
          depth: row.secondDepth,
        }))
        .execute();

      expect(rows).toEqual([{ target: "Multi leaf", depth: 1 }]);
    });

    it("rejoins a shared downstream expansion to every upstream path", async () => {
      const store = context.getStore();
      const root = await store.nodes.Person.create({ name: "Diamond root" });
      const alternate = await store.nodes.Person.create({
        name: "Diamond alternate",
      });
      const middle = await store.nodes.Person.create({
        name: "Diamond middle",
      });
      const leaf = await store.nodes.Person.create({ name: "Diamond leaf" });
      await store.edges.knows.create(root, middle, {});
      await store.edges.knows.create(root, alternate, {});
      await store.edges.knows.create(alternate, middle, {});
      await store.edges.knows.create(middle, leaf, {});

      const rows = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.id.eq(root.id))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "leaf")
        .where((fields) =>
          expr.eq(fields.leaf.name, expr.literal("Diamond leaf")),
        )
        .select((row) => row.leaf.name)
        .execute();

      expect(rows).toEqual(["Diamond leaf", "Diamond leaf"]);
    });

    it("can branch a later recursive stage from an earlier alias", async () => {
      const rows = await context
        .getStore()
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2 })
        .to("Person", "descendant")
        .traverse("knows", "branchEdge", {
          expand: "none",
          from: "root",
        })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "branch")
        .select((row) => ({
          descendant: row.descendant.name,
          branch: row.branch.name,
        }))
        .execute();

      expect(
        rows.toSorted((left, right) =>
          left.descendant.localeCompare(right.descendant),
        ),
      ).toEqual([
        { descendant: "Multi leaf", branch: "Multi middle" },
        { descendant: "Multi middle", branch: "Multi middle" },
      ]);
    });

    it("applies completed filtering and range after the full chain and preserves terminals", async () => {
      const store = context.getStore();
      const query = store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2 })
        .to("Person", "target")
        .where((fields) =>
          expr.or(
            expr.eq(fields.target.name, expr.literal("Multi leaf")),
            expr.eq(fields.target.name, expr.literal("Multi tail")),
          ),
        )
        .orderBy("target", "name", "desc")
        .limit(1)
        .select((row) => row.target.name);

      expect(await query.execute()).toEqual(["Multi tail"]);
      expect(await query.prepare().execute({})).toEqual(["Multi tail"]);
      expect(await store.batchOnce(() => [query, query])).toEqual([
        ["Multi tail"],
        ["Multi tail"],
      ]);
    });

    it("composes fixed and recursive stages while preserving fixed edge bindings", async () => {
      const store = context.getStore();
      const root = await store.nodes.Person.create({ name: "Mixed root" });
      const middle = await store.nodes.Person.create({ name: "Mixed middle" });
      const leaf = await store.nodes.Person.create({ name: "Mixed leaf" });
      const fixedEdge = await store.edges.knows.create(root, middle, {
        since: "2020",
      });
      await store.edges.knows.create(middle, leaf, { since: "2021" });

      const mixed = store
        .query()
        .from("Person", "rootPerson")
        .whereNode("rootPerson", (person) => person.id.eq(root.id))
        .traverse("knows", "fixedEdge", { expand: "none" })
        .to("Person", "middlePerson")
        .traverse("knows", "recursiveEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "targetPerson")
        .orderBy("targetPerson", "name", "asc");

      const selected = mixed.select((row) => ({
        edge: row.fixedEdge,
        since: row.fixedEdge.since,
        target: row.targetPerson.name,
      }));
      const expected = [
        {
          edge: {
            id: fixedEdge.id,
            kind: fixedEdge.kind,
            fromId: fixedEdge.fromId,
            toId: fixedEdge.toId,
            since: fixedEdge.since,
            meta: fixedEdge.meta,
          },
          since: "2020",
          target: "Mixed leaf",
        },
      ];
      expect(await selected.execute()).toEqual(expected);
      expect(await selected.prepare().execute({})).toEqual(expected);
      expect(await store.batchOnce(() => [selected, selected])).toEqual([
        expected,
        expected,
      ]);

      const relation = mixed
        .project((fields) => ({
          since: fields.fixedEdge.since,
          target: fields.targetPerson.name,
        }))
        .asRelation();
      expect(await relation.execute()).toEqual([
        { since: "2020", target: "Mixed leaf" },
      ]);
      expect(
        await relation
          .groupBy((columns) => [columns.since])
          .aggregate((columns) => ({
            since: columns.since,
            count: expr.count(),
          }))
          .execute(),
      ).toEqual([{ since: "2020", count: 1 }]);

      await store.transaction(async (transaction) => {
        const transactionRoot = await transaction.nodes.Person.create({
          name: "Transaction mixed root",
        });
        const transactionMiddle = await transaction.nodes.Person.create({
          name: "Transaction mixed middle",
        });
        const transactionLeaf = await transaction.nodes.Person.create({
          name: "Transaction mixed leaf",
        });
        await transaction.edges.knows.create(
          transactionRoot,
          transactionMiddle,
          { since: "inside" },
        );
        await transaction.edges.knows.create(
          transactionMiddle,
          transactionLeaf,
          {
            since: "recursive",
          },
        );

        expect(
          await transaction
            .query()
            .from("Person", "root")
            .whereNode("root", (person) => person.id.eq(transactionRoot.id))
            .traverse("knows", "fixedEdge", { expand: "none" })
            .to("Person", "middle")
            .traverse("knows", "recursiveEdge", { expand: "none" })
            .recursive({ minHops: 1, maxHops: 1, depth: true })
            .to("Person", "target")
            .select((row) => ({
              since: row.fixedEdge.since,
              target: row.target.name,
            }))
            .execute(),
        ).toEqual([{ since: "inside", target: "Transaction mixed leaf" }]);
      });
    });

    it("supports recursive-to-fixed and fixed-recursive-fixed chains", async () => {
      const store = context.getStore();
      const recursiveThenFixed = store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "recursiveEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 2 })
        .to("Person", "middle")
        .traverse("knows", "fixedEdge", { expand: "none" })
        .to("Person", "target")
        .orderBy("middle", "name", "desc")
        .select((row) => ({
          middle: row.middle.name,
          target: row.target.name,
        }));
      const expectedRecursiveThenFixed = [
        { middle: "Multi middle", target: "Multi leaf" },
        { middle: "Multi leaf", target: "Multi tail" },
      ];
      expect(await recursiveThenFixed.execute()).toEqual(
        expectedRecursiveThenFixed,
      );
      expect(await store.batchOnce(() => [recursiveThenFixed])).toEqual([
        expectedRecursiveThenFixed,
      ]);

      const fixedRecursiveFixed = await store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "firstFixed", { expand: "none" })
        .to("Person", "middle")
        .traverse("knows", "recursiveEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "leaf")
        .traverse("knows", "lastFixed", { expand: "none" })
        .to("Person", "tail")
        .select((row) => row.tail.name)
        .execute();
      expect(fixedRecursiveFixed).toEqual(["Multi tail"]);
    });

    it("preserves optional first recursive absence and zero-hop eligibility", async () => {
      const store = context.getStore();
      const isolated = await store.nodes.Person.create({
        name: "Optional isolated",
      });
      const absent = store
        .query()
        .from("Person", "rootPerson")
        .whereNode("rootPerson", (person) => person.id.eq(isolated.id))
        .optionalTraverse("knows", "edge", { expand: "none" })
        .recursive({
          minHops: 1,
          maxHops: 1,
          depth: "depth",
          path: { format: "qualified", alias: "path" },
        })
        .to("Person", "target");
      const absentSelection = absent.select((row) => ({
        root: row.rootPerson.name,
        target: row.target?.name,
        depth: row.depth,
        path: row.path,
      }));
      const expectedAbsence = [
        {
          root: "Optional isolated",
          target: undefined,
          depth: undefined,
          path: undefined,
        },
      ];
      expect(await absentSelection.execute()).toEqual(expectedAbsence);
      expect(await absentSelection.prepare().execute({})).toEqual(
        expectedAbsence,
      );
      expect(await store.batchOnce(() => [absentSelection])).toEqual([
        expectedAbsence,
      ]);

      const prunedRoot = await store.nodes.Person.create({
        name: "Optional pruned root",
      });
      const prunedNeighbor = await store.nodes.Person.create({
        name: "Optional pruned neighbor",
      });
      await store.edges.knows.create(prunedRoot, prunedNeighbor, {});
      expect(
        await store
          .query()
          .from("Person", "rootPerson")
          .whereNode("rootPerson", (person) => person.id.eq(prunedRoot.id))
          .optionalTraverse("knows", "edge", { expand: "none" })
          .recursive({ minHops: 1, maxHops: 2 })
          .to("Person", "target")
          .whereNode("target", (person) => person.name.eq("Never matches"))
          .select((row) => row.target?.name)
          .execute(),
      ).toEqual([undefined]);

      const zeroHop = await store
        .query()
        .from("Person", "rootPerson")
        .whereNode("rootPerson", (person) => person.id.eq(isolated.id))
        .optionalTraverse("knows", "edge", { expand: "none" })
        .recursive({ minHops: 0, maxHops: 1, depth: true, path: true })
        .to("Person", "target")
        .select((row) => ({
          target: row.target?.name,
          depth: row.target_depth,
          path: row.target_path,
        }))
        .execute();
      expect(zeroHop).toEqual([
        { target: "Optional isolated", depth: 0, path: [isolated.id] },
      ]);

      const stopped = await store
        .query()
        .from("Person", "rootPerson")
        .whereNode("rootPerson", (person) => person.id.eq(isolated.id))
        .optionalTraverse("knows", "edge", { expand: "none" })
        .recursive({ minHops: 0, maxHops: 1 })
        .to("Person", "target")
        .stopExpansion("target", (person) => person.id.eq(isolated.id), {
          emitStopNode: false,
        })
        .select((row) => row.target?.name)
        .execute();
      expect(stopped).toEqual([undefined]);
    });

    it("composes absent optional recursion into required and optional fixed stages", async () => {
      const store = context.getStore();
      const isolated = await store.nodes.Person.create({
        name: "Optional chain isolated",
      });
      const prefix = store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.id.eq(isolated.id))
        .optionalTraverse("knows", "recursiveEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1 })
        .to("Person", "missing");

      expect(
        await prefix
          .traverse("knows", "requiredEdge", {
            expand: "none",
            from: "missing",
          })
          .to("Person", "requiredTarget")
          .select((row) => row.requiredTarget.name)
          .execute(),
      ).toEqual([]);
      expect(
        await prefix
          .optionalTraverse("knows", "optionalEdge", {
            expand: "none",
            from: "missing",
          })
          .to("Person", "optionalTarget")
          .where((fields) => expr.isNull(fields.optionalTarget.id))
          .select((row) => ({
            root: row.root.name,
            target: row.optionalTarget?.name,
          }))
          .execute(),
      ).toEqual([{ root: "Optional chain isolated", target: undefined }]);

      const selectedEdge = store
        .query()
        .from("Person", "root")
        .traverse("knows", "firstEdge", { expand: "none" })
        .recursive({ maxHops: 1 })
        .to("Person", "middle")
        .traverse("knows", "secondEdge", { expand: "none" })
        .recursive({ maxHops: 1 })
        .to("Person", "target")
        .select((row) => row.secondEdge.id);
      await expect(selectedEdge.execute()).rejects.toThrow(
        'does not support edge alias "secondEdge"',
      );
    });

    it("refuses cross-alias fixed-stage predicates and supports them after the chain", async () => {
      const store = context.getStore();
      const prefix = store
        .query()
        .from("Person", "root")
        .whereNode("root", (person) => person.name.eq("Multi root"))
        .traverse("knows", "recursiveEdge", { expand: "none" })
        .recursive({ minHops: 1, maxHops: 1, depth: true })
        .to("Person", "middle")
        .traverse("knows", "fixedEdge", { expand: "none" })
        .to("Person", "target");

      expect(
        await prefix
          .where((expressions) =>
            expr.neq(expressions.target.name, expressions.middle.name),
          )
          .select((row) => row.target.name)
          .execute(),
      ).toEqual(["Multi leaf"]);

      await expect(
        prefix
          .whereNode("target", (_target, expressions) =>
            expr.neq(expressions.target.name, expressions.middle.name),
          )
          .select((row) => row.target.name)
          .execute(),
      ).rejects.toThrow(/cross-alias reference "middle".*completed where/);
      await expect(
        prefix
          .whereNode("target", (_target, expressions) =>
            expr.eq(expressions.target.name, expressions.root.name),
          )
          .select((row) => row.target.name)
          .execute(),
      ).rejects.toThrow(/cross-alias reference "root".*completed where/);
    });

    it("refuses recursive output aliases that collide with materialized columns", async () => {
      const query = context
        .getStore()
        .query()
        .from("Person", "root")
        .traverse("knows", "edge", { expand: "none" })
        .recursive({ maxHops: 1, depth: "root_id" })
        .to("Person", "target")
        .select((row) => row.target.name);

      await expect(query.execute()).rejects.toThrow(
        'Recursive traversal output alias "root_id" collides with another result column',
      );
    });
  });
}
