/**
 * A search cursor's PostgreSQL relevance key is the server's float text, which
 * is exact only while `extra_float_digits` is 1 or above (the default). Below
 * that the key renders NULL and the cursor is refused, rather than carrying a
 * rounded score that skips or repeats nearly tied rows. PGlite runs every
 * statement on its one session, so a `SET` reaches the page statements.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createStoreWithSchema,
  defineGraph,
  defineNode,
  embedding,
} from "../../../src";
import { createLocalPgliteBackend } from "../../../src/backend/postgres/pglite";
import { requireDefined } from "../../../src/utils/presence";

const Document = defineNode("Doc", {
  schema: z.object({ embedding: embedding(2) }),
});
const graph = defineGraph({
  id: "search_cursor_float_output",
  nodes: { Doc: { type: Document } },
  edges: {},
});

describe("PostgreSQL search cursor float output", () => {
  it("refuses to issue a search cursor while extra_float_digits is below 1", async () => {
    const { backend } = await createLocalPgliteBackend();
    try {
      const [store] = await createStoreWithSchema(graph, backend);
      // Three tied distances that no 15-digit text renders exactly.
      for (const id of ["t0", "t1", "t2"]) {
        await store.nodes.Doc.create({ embedding: [0.6, 0.8] }, { id });
      }
      const query = () =>
        store
          .query()
          .from("Doc", "d")
          .whereNode("d", (d) => d.embedding.similarTo([0.3, 0.7], 10))
          .select((ctx) => ({ id: ctx.d.id }));

      const exact = await query().paginate({ first: 1 });
      const rest = await query().paginate({
        first: 10,
        after: requireDefined(exact.nextCursor),
      });
      expect([...exact.data, ...rest.data].map((row) => row.id)).toEqual([
        "t0",
        "t1",
        "t2",
      ]);

      await backend.executeDdl?.("SET extra_float_digits = 0");
      const error = await query()
        .paginate({ first: 1 })
        .then(
          () => "issued a cursor",
          (error_: unknown) => error_,
        );
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).details).toEqual(
        expect.objectContaining({ code: "SEARCH_CURSOR_KEY_UNAVAILABLE" }),
      );
    } finally {
      await backend.close();
    }
  });
});
