/**
 * A write that re-validates a stored row stores every property it does not
 * state as it was stored (#851).
 *
 * The store persists a schema's output, and every write that leaves a row
 * behind an existing one validates the whole row it leaves. On main that
 * validation's output was stored for every property, so a schema step that
 * rewrites a value — a non-idempotent transform, an `.overwrite()`, a
 * `.catch()` fallback — was applied again to values the caller never touched:
 * `"x!"` became `"x!!"` on an update of another property. Each case here runs
 * one write path over a row whose untouched value such a step would rewrite,
 * and asserts that the stored bytes of that value are unchanged while a
 * stated value is stored exactly as a create stores it.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  ValidationError,
} from "../../../src";
import { rowPropsToObject } from "../../../src/backend/types";
import { STORED_PROPERTY_INVALID_CODE } from "../../../src/errors";
import { asBranchId, branch, merge } from "../../../src/graph-merge";
import { isErr, unwrap } from "../../../src/graph-merge/result";
import { exportGraph, importGraph } from "../../../src/interchange";
import { canonicalJson } from "../../../src/schema/canonical";
import { requireDefined } from "../../../src/utils/presence";
import {
  type InspectableStore,
  type IntegrationTestContext,
} from "./test-context";

const LATER = "2030-01-01T00:00:00.000Z";

/** Appends `!` on every parse: not idempotent, type-preserving. */
const exclaimed = z.string().transform((value) => `${value}!`);

const Note = defineNode("UntouchedNote", {
  schema: z.object({
    name: exclaimed,
    title: z.string().optional(),
    count: z.number().overwrite((value) => value + 1),
    status: z.string().catch("unknown"),
    tier: z.string().default("basic"),
    address: z.object({ street: exclaimed, city: z.string() }).optional(),
  }),
});

/** A transform that changes the type: its stored output is not valid input. */
const Sized = defineNode("UntouchedSized", {
  schema: z.object({
    title: z.string(),
    size: z
      .string()
      .transform((value) => value.length)
      .optional(),
  }),
});

/** A key derived from another by an object-level `.overwrite()`. */
const Slugged = defineNode("UntouchedSlugged", {
  schema: z
    .object({ title: z.string(), slug: z.string().optional() })
    .overwrite((value) => ({
      ...value,
      slug: value.title.toLowerCase().replaceAll(" ", "-"),
    })),
});

/** A cross-field refinement over a stated and an unstated property. */
const Ranged = defineNode("UntouchedRanged", {
  schema: z
    .object({ low: z.number(), high: z.number() })
    .refine((value) => value.low <= value.high, {
      message: "low must not exceed high",
      path: ["high"],
    }),
});

const Strict = defineNode("UntouchedStrict", {
  schema: z.object({ name: exclaimed, title: z.string() }).strict(),
});

const Loose = defineNode("UntouchedLoose", {
  schema: z.object({ name: exclaimed, title: z.string() }).loose(),
});

const noted = defineEdge("untouchedNoted", {
  schema: z.object({ label: exclaimed, weight: z.number().optional() }),
});

function untouchedGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      UntouchedNote: {
        type: Note,
        unique: [
          {
            name: "untouched_note_name",
            fields: ["name"],
            scope: "kind",
            collation: "binary",
          },
        ],
      },
      UntouchedSized: { type: Sized },
      UntouchedSlugged: { type: Slugged },
      UntouchedRanged: { type: Ranged },
      UntouchedStrict: { type: Strict },
      UntouchedLoose: { type: Loose },
    },
    edges: {
      untouchedNoted: {
        type: noted,
        from: [Note],
        to: [Note],
      },
    },
  });
}

const graph = untouchedGraph("untouched_property_writes");

type UntouchedGraph = typeof graph;
type UntouchedStore = InspectableStore<UntouchedGraph>;

/**
 * Every property of a node as the backend stores it, as JSON text per key
 * with object keys sorted (`canonicalJson`): PostgreSQL's JSONB orders an
 * object's keys its own way, so the text compares the value, not the order.
 */
async function storedNode(
  store: UntouchedStore,
  kind: Extract<keyof UntouchedGraph["nodes"], string>,
  id: string,
): Promise<Record<string, string>> {
  const row = requireDefined(
    await store.backend.getNode(store.graphId, kind, id),
  );
  return Object.fromEntries(
    Object.entries(rowPropsToObject(row.props)).map(([key, value]) => [
      key,
      canonicalJson(value),
    ]),
  );
}

async function storedEdge(
  store: UntouchedStore,
  id: string,
): Promise<Record<string, string>> {
  const row = requireDefined(await store.backend.getEdge(store.graphId, id));
  return Object.fromEntries(
    Object.entries(rowPropsToObject(row.props)).map(([key, value]) => [
      key,
      canonicalJson(value),
    ]),
  );
}

/** The stored props a create of `name: "x"` leaves on a note. */
const CREATED_NOTE = {
  name: canonicalJson("x!"),
  count: canonicalJson(2),
  status: canonicalJson("open"),
  tier: canonicalJson("basic"),
  address: canonicalJson({ street: "elm!", city: "Oslo" }),
};

async function createNote(store: UntouchedStore, name = "x") {
  const note = await store.nodes.UntouchedNote.create({
    name,
    count: 1,
    status: "open",
    address: { street: "elm", city: "Oslo" },
  });
  return note.id;
}

async function refusalOf(write: () => Promise<unknown>): Promise<unknown> {
  return write().then(
    () => "written",
    (error: unknown) => error,
  );
}

export function registerUntouchedPropertyWriteIntegrationTests(
  context: IntegrationTestContext,
): void {
  describe("a write that re-validates a stored row keeps every property it does not state (#851)", () => {
    it("update, upsertById and bulkUpsertById store untouched values as stored and stated values as a create does", async () => {
      const store = await context.createStore(graph);
      const id = await createNote(store);
      expect(await storedNode(store, "UntouchedNote", id)).toEqual(
        CREATED_NOTE,
      );

      await store.nodes.UntouchedNote.update(id, { title: "t1" });
      expect(await storedNode(store, "UntouchedNote", id)).toEqual({
        ...CREATED_NOTE,
        title: canonicalJson("t1"),
      });

      await store.nodes.UntouchedNote.upsertById(id, {
        name: "y",
        count: 5,
        status: "open",
      });
      // `name` and `count` are stated, so their schema steps apply once, as
      // on a create; `address` and `title` are not, so they are kept.
      const afterUpsert = {
        ...CREATED_NOTE,
        name: canonicalJson("y!"),
        count: canonicalJson(6),
        title: canonicalJson("t1"),
      };
      expect(await storedNode(store, "UntouchedNote", id)).toEqual(afterUpsert);

      await store.nodes.UntouchedNote.bulkUpsertById([
        { id, props: { name: "y", count: 5, status: "open", title: "t2" } },
      ]);
      expect(await storedNode(store, "UntouchedNote", id)).toEqual({
        ...afterUpsert,
        title: canonicalJson("t2"),
      });
    });

    it("updateWhere and compareAndSet store untouched values as stored", async () => {
      const store = await context.createStore(graph);
      const id = await createNote(store);

      await store.nodes.UntouchedNote.updateWhere({
        where: (node) => node.id.eq(id),
        patch: { title: "t1" },
      });
      expect(await storedNode(store, "UntouchedNote", id)).toEqual({
        ...CREATED_NOTE,
        title: canonicalJson("t1"),
      });

      const matched = await store.nodes.UntouchedNote.compareAndSet(id, {
        expected: { title: "t1" },
        patch: { title: "t2" },
      });
      expect(matched).toBe(true);
      expect(await storedNode(store, "UntouchedNote", id)).toEqual({
        ...CREATED_NOTE,
        title: canonicalJson("t2"),
      });
    });

    it("an edge update, an edge end and an edge upsert store untouched values as stored", async () => {
      const store = await context.createStore(graph);
      const from = await store.nodes.UntouchedNote.create({
        name: "a",
        count: 1,
        status: "open",
      });
      const to = await store.nodes.UntouchedNote.create({
        name: "b",
        count: 1,
        status: "open",
      });
      const edge = await store.edges.untouchedNoted.create(from, to, {
        label: "l",
      });
      const label = canonicalJson("l!");
      expect(await storedEdge(store, edge.id)).toEqual({ label });

      await store.edges.untouchedNoted.update(edge.id, { weight: 2 });
      expect(await storedEdge(store, edge.id)).toEqual({
        label,
        weight: canonicalJson(2),
      });

      await store.edges.untouchedNoted.bulkUpsertById([
        { id: edge.id, from, to, props: { weight: 3 } as never },
      ]);
      expect(await storedEdge(store, edge.id)).toEqual({
        label,
        weight: canonicalJson(3),
      });

      await store.edges.untouchedNoted.update(edge.id, {}, { validTo: LATER });
      expect(await storedEdge(store, edge.id)).toEqual({
        label,
        weight: canonicalJson(3),
      });
    });

    it("a get-or-create's update leg parses each stated value once and keeps every unstated one", async () => {
      const store = await context.createStore(graph);
      const id = await createNote(store);
      await store.nodes.UntouchedNote.update(id, { tier: "gold" });
      // The create's parse makes the match key ("x!"); the update leg states
      // the caller's props, so `name` is stored as a create stores "x", not
      // parsed again from "x!", and `tier`, `address` are left as stored.
      const single = await store.nodes.UntouchedNote.getOrCreateByConstraint(
        "untouched_note_name",
        { name: "x", count: 5, status: "s" },
        { ifExists: "update" },
      );
      expect(single.action).toBe("updated");
      const afterSingle = {
        ...CREATED_NOTE,
        count: canonicalJson(6),
        status: canonicalJson("s"),
        tier: canonicalJson("gold"),
      };
      expect(await storedNode(store, "UntouchedNote", id)).toEqual(afterSingle);
      const [bulk] =
        await store.nodes.UntouchedNote.bulkGetOrCreateByConstraint(
          "untouched_note_name",
          [{ props: { name: "x", count: 7, status: "t" } }],
          { ifExists: "update" },
        );
      expect(bulk?.action).toBe("updated");
      expect(await storedNode(store, "UntouchedNote", id)).toEqual({
        ...afterSingle,
        count: canonicalJson(8),
        status: canonicalJson("t"),
      });

      const from = await store.nodes.UntouchedNote.create({
        name: "a",
        count: 1,
        status: "open",
      });
      const to = await store.nodes.UntouchedNote.create({
        name: "b",
        count: 1,
        status: "open",
      });
      const created = await store.edges.untouchedNoted.getOrCreateByEndpoints(
        from,
        to,
        { label: "l", weight: 1 },
      );
      expect(await storedEdge(store, created.edge.id)).toEqual({
        label: canonicalJson("l!"),
        weight: canonicalJson(1),
      });
      await store.edges.untouchedNoted.getOrCreateByEndpoints(
        from,
        to,
        { label: "m" },
        { ifExists: "update" },
      );
      expect(await storedEdge(store, created.edge.id)).toEqual({
        label: canonicalJson("m!"),
        weight: canonicalJson(1),
      });
      const [fresh] =
        await store.edges.untouchedNoted.bulkGetOrCreateByEndpoints([
          { from: to, to: from, props: { label: "n" } },
        ]);
      expect(await storedEdge(store, requireDefined(fresh).edge.id)).toEqual({
        label: canonicalJson("n!"),
      });
      await store.edges.untouchedNoted.bulkGetOrCreateByEndpoints(
        [{ from, to, props: { label: "o" } }],
        { ifExists: "update" },
      );
      expect(await storedEdge(store, created.edge.id)).toEqual({
        label: canonicalJson("o!"),
        weight: canonicalJson(1),
      });
    });

    it("an update twice stores the same bytes as once, and a no-op upsert coalesces", async () => {
      const store = await context.createStore(graph, {
        coalesceUnchangedUpserts: true,
      });
      const id = await createNote(store);
      await store.nodes.UntouchedNote.update(id, { title: "t" });
      const once = await storedNode(store, "UntouchedNote", id);
      await store.nodes.UntouchedNote.update(id, { title: "t" });
      expect(await storedNode(store, "UntouchedNote", id)).toEqual(once);

      const before = requireDefined(
        await store.nodes.UntouchedNote.getById(id),
      );
      const replayed = await store.nodes.UntouchedNote.upsertById(id, {
        title: "t",
      } as never);
      // Nothing the upsert states changes, and nothing it does not state is
      // rewritten, so the write is skipped.
      expect(replayed.meta.version).toBe(before.meta.version);
    });

    it("a stated undefined removes an optional property or fills its default; a nested object is stated as a whole", async () => {
      const store = await context.createStore(graph);
      const id = await createNote(store);
      await store.nodes.UntouchedNote.update(id, {
        title: "t",
        tier: "gold",
      });
      await store.nodes.UntouchedNote.update(id, {
        title: undefined,
        tier: undefined,
      });
      const { title, ...withoutTitle } = {
        ...CREATED_NOTE,
        title: canonicalJson("t"),
      };
      expect(title).toBe(canonicalJson("t"));
      expect(await storedNode(store, "UntouchedNote", id)).toEqual(
        withoutTitle,
      );

      await store.nodes.UntouchedNote.update(id, {
        address: { street: "oak", city: "Bergen" },
      });
      expect(await storedNode(store, "UntouchedNote", id)).toEqual({
        ...withoutTitle,
        address: canonicalJson({ street: "oak!", city: "Bergen" }),
      });
    });

    it("an untouched value the schema's `.catch()` would replace is kept", async () => {
      const store = await context.createStore(graph);
      const id = await createNote(store);
      // A stored value the `.catch()` property refuses: the parse falls back
      // to "unknown", but the update does not state `status`.
      await store.backend.updateNode({
        graphId: store.graphId,
        kind: "UntouchedNote",
        id,
        props: { ...propsFromStored(CREATED_NOTE), status: 42 },
        incrementVersion: true,
      });
      await store.nodes.UntouchedNote.update(id, { title: "t" });
      expect(await storedNode(store, "UntouchedNote", id)).toEqual({
        ...CREATED_NOTE,
        status: canonicalJson(42),
        title: canonicalJson("t"),
      });
    });

    it("an untouched stored value that is not valid input to its own schema refuses the write, naming the property", async () => {
      const store = await context.createStore(graph);
      const sized = await store.nodes.UntouchedSized.create({
        title: "a",
        size: "abc",
      });
      const stored = await storedNode(store, "UntouchedSized", sized.id);
      expect(stored).toEqual({
        title: canonicalJson("a"),
        size: canonicalJson(3),
      });

      for (const write of [
        () => store.nodes.UntouchedSized.update(sized.id, { title: "b" }),
        () =>
          store.nodes.UntouchedSized.updateWhere({
            where: (node) => node.id.eq(sized.id),
            patch: { title: "b" },
          }),
      ]) {
        const refusal = await refusalOf(write);
        expect(refusal).toBeInstanceOf(ValidationError);
        expect((refusal as ValidationError).details.issues).toEqual([
          expect.objectContaining({
            path: "size",
            code: STORED_PROPERTY_INVALID_CODE,
          }),
        ]);
      }
      expect(await storedNode(store, "UntouchedSized", sized.id)).toEqual(
        stored,
      );

      // Stating the property writes it as a create would.
      await store.nodes.UntouchedSized.update(sized.id, {
        title: "b",
        size: "abcd",
      });
      expect(await storedNode(store, "UntouchedSized", sized.id)).toEqual({
        title: canonicalJson("b"),
        size: canonicalJson(4),
      });
    });

    it("a cross-field refinement that fails at an unstated property is reported as Zod reports it", async () => {
      const store = await context.createStore(graph);
      const ranged = await store.nodes.UntouchedRanged.create({
        low: 1,
        high: 5,
      });
      const refusal = await refusalOf(() =>
        store.nodes.UntouchedRanged.update(ranged.id, { low: 9 }),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      const issues = (refusal as ValidationError).details.issues;
      expect(issues).toEqual([
        expect.objectContaining({ path: "high", code: "custom" }),
      ]);
    });

    it("a key an object-level `.overwrite()` derives is recomputed only when the write states it", async () => {
      const store = await context.createStore(graph);
      const slugged = await store.nodes.UntouchedSlugged.create({
        title: "Hello World",
      });
      expect(await storedNode(store, "UntouchedSlugged", slugged.id)).toEqual({
        title: canonicalJson("Hello World"),
        slug: canonicalJson("hello-world"),
      });
      // The update states `title` only: `slug` keeps its stored value.
      await store.nodes.UntouchedSlugged.update(slugged.id, {
        title: "Second Title",
      });
      expect(await storedNode(store, "UntouchedSlugged", slugged.id)).toEqual({
        title: canonicalJson("Second Title"),
        slug: canonicalJson("hello-world"),
      });
      // Stating `slug` (with any value) stores what the schema derives.
      await store.nodes.UntouchedSlugged.update(slugged.id, {
        title: "Second Title",
        slug: "",
      });
      expect(await storedNode(store, "UntouchedSlugged", slugged.id)).toEqual({
        title: canonicalJson("Second Title"),
        slug: canonicalJson("second-title"),
      });
    });

    it("a stored key the schema does not declare is kept, refused under `.strict()`, and kept under `.loose()`", async () => {
      const store = await context.createStore(graph);
      const note = await createNote(store);
      const strict = await store.nodes.UntouchedStrict.create({
        name: "s",
        title: "a",
      });
      const loose = await store.nodes.UntouchedLoose.create({
        name: "l",
        title: "a",
      });
      for (const [kind, id, props] of [
        ["UntouchedNote", note, propsFromStored(CREATED_NOTE)],
        ["UntouchedStrict", strict.id, { name: "s!", title: "a" }],
        ["UntouchedLoose", loose.id, { name: "l!", title: "a" }],
      ] as const) {
        await store.backend.updateNode({
          graphId: store.graphId,
          kind,
          id,
          props: { ...props, legacy: "kept" },
          incrementVersion: true,
        });
      }

      await store.nodes.UntouchedNote.update(note, { title: "t" });
      expect(await storedNode(store, "UntouchedNote", note)).toEqual({
        ...CREATED_NOTE,
        title: canonicalJson("t"),
        legacy: canonicalJson("kept"),
      });

      const refusal = await refusalOf(() =>
        store.nodes.UntouchedStrict.update(strict.id, { title: "b" }),
      );
      expect(refusal).toBeInstanceOf(ValidationError);
      expect((refusal as ValidationError).details.issues).toEqual([
        expect.objectContaining({
          path: "legacy",
          code: STORED_PROPERTY_INVALID_CODE,
        }),
      ]);

      await store.nodes.UntouchedLoose.update(loose.id, { title: "b" });
      expect(await storedNode(store, "UntouchedLoose", loose.id)).toEqual({
        name: canonicalJson("l!"),
        title: canonicalJson("b"),
        legacy: canonicalJson("kept"),
      });
    });

    it("an untouched value keeps its uniqueness claim", async () => {
      const store = await context.createStore(graph);
      const id = await createNote(store);
      await store.nodes.UntouchedNote.update(id, { title: "t" });
      // The row still stores "x!" and still holds its claim, so a second
      // create of "x" collides; "x!!" (a create of "x!") is free.
      await expect(createNote(store)).rejects.toThrow();
      await expect(createNote(store, "x!")).resolves.toBeDefined();
    });

    it('an import under `onConflict: "update"` stores the document\'s values as carried, under every unknown-property strategy', async () => {
      const source = await context.createStore(graph);
      const id = await createNote(source);
      await source.nodes.UntouchedNote.update(id, { title: "t" });
      const exported = await exportGraph(source);
      const withLegacy = {
        ...exported,
        nodes: exported.nodes.map((node) => ({
          ...node,
          properties: { ...node.properties, legacy: "doc" },
        })),
      };
      const exportedProps = { ...CREATED_NOTE, title: canonicalJson("t") };

      for (const [strategy, document, expected] of [
        ["error", exported, exportedProps],
        ["strip", withLegacy, exportedProps],
        ["allow", withLegacy, { ...exportedProps, legacy: '"doc"' }],
      ] as const) {
        const target = await context.createStore(
          untouchedGraph(`untouched_import_${strategy}`),
        );
        await target.nodes.UntouchedNote.create(
          { name: "other", count: 0, status: "open" },
          { id },
        );
        const result = await importGraph(target, document, {
          onConflict: "update",
          onUnknownProperty: strategy,
        });
        expect([strategy, result.errors]).toEqual([strategy, []]);
        expect([
          strategy,
          await storedNode(target, "UntouchedNote", id),
        ]).toEqual([strategy, expected]);
      }

      const refusedTarget = await context.createStore(
        untouchedGraph("untouched_import_refused"),
      );
      const refused = await importGraph(refusedTarget, withLegacy, {
        onConflict: "update",
        onUnknownProperty: "error",
      });
      expect(refused.errors.map((error) => error.error)).toEqual([
        "Unknown properties: legacy",
      ]);
    });

    it("a merge writes the branch's row as stored", async () => {
      const base = await context.createStore(graph, {
        revisionTracking: true,
      });
      const id = await createNote(base);
      const fork = unwrap(
        await branch(base, () => context.createIsolatedBackend(), {
          id: asBranchId("untouched"),
        }),
      );
      await fork.store.nodes.UntouchedNote.update(id, { title: "branch" });
      const created = await fork.store.nodes.UntouchedNote.create({
        name: "new",
        count: 1,
        status: "open",
      });
      const merged = await merge(base, [fork]);
      expect(isErr(merged) ? merged.error.message : "merged").toBe("merged");
      expect(await storedNode(base, "UntouchedNote", id)).toEqual({
        ...CREATED_NOTE,
        title: canonicalJson("branch"),
      });
      expect(await storedNode(base, "UntouchedNote", created.id)).toEqual({
        name: canonicalJson("new!"),
        count: canonicalJson(2),
        status: canonicalJson("open"),
        tier: canonicalJson("basic"),
      });
    });
  });
}

/** Per-key JSON text back to the props object it was read from. */
function propsFromStored(
  stored: Readonly<Record<string, string>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(stored).map(([key, text]) => [key, JSON.parse(text)]),
  );
}
