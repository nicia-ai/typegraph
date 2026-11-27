/**
 * Captures the cursors a query without a search issues, as golden fixtures
 * for `tests/backends/integration/plain-cursor-compatibility.ts`.
 *
 * Run against the library source of the release whose cursors must keep
 * resuming (a checkout of `main`, not this tree), so the fixtures record what
 * that release issued rather than what the code under test issues:
 *
 *   git archive origin/main packages/typegraph/src \
 *     | tar -x -C packages/typegraph/node_modules/.legacy-main --strip-components=2
 *   node --import tsx scripts/capture-plain-cursor-fixtures.ts \
 *     node_modules/.legacy-main/src \
 *     tests/backends/integration/plain-cursor-fixtures.ts
 *
 * (The source sits under `node_modules` so its dependencies resolve to this
 * package's.) For each local lane, each sortable field type and each
 * direction, it pages {@link PLAIN_CURSOR_SEED} one row at a time through
 * `paginate()` and `page()` (alone and in `store.batchOnce()`), selecting the
 * whole node and selecting fields, and records every distinct cursor with the
 * rows that follow it (`after`) and precede it (`before`). `stream()` issues
 * `paginate()`'s cursors internally and has no cursor input. The server
 * PostgreSQL lanes cannot run here; they resume the PGlite fixtures, which
 * hold the same dialect's values.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { createClient } from "@libsql/client";
import { z } from "zod";

import {
  PLAIN_CURSOR_PGLITE_TIME_ZONE,
  PLAIN_CURSOR_SEED,
  PLAIN_CURSOR_SORTS,
  type PlainCursorFixture,
  type PlainCursorSort,
} from "../tests/backends/integration/plain-cursor-seed";

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- the library under capture is loaded from an arbitrary source root at run time */

type Lane = PlainCursorFixture["lane"];

async function importFrom(root: string, module: string): Promise<any> {
  return import(pathToFileURL(path.resolve(root, module)).href);
}

async function openBackend(
  root: string,
  lane: Lane,
  scratch: string,
): Promise<Readonly<{ backend: any; close: () => Promise<void> }>> {
  switch (lane) {
    case "sqlite": {
      const { createLocalSqliteBackend } = await importFrom(
        root,
        "backend/sqlite/local.ts",
      );
      const { backend } = createLocalSqliteBackend();
      return { backend, close: () => backend.close() };
    }
    case "libsql": {
      const { createLibsqlBackend } = await importFrom(
        root,
        "backend/sqlite/libsql.ts",
      );
      const client = createClient({
        url: `file:${path.join(scratch, "capture.db")}`,
      });
      const { backend } = await createLibsqlBackend(client);
      return {
        backend,
        close: async () => {
          await backend.close();
          client.close();
        },
      };
    }
    case "pglite": {
      const { createLocalPgliteBackend } = await importFrom(
        root,
        "backend/postgres/pglite.ts",
      );
      // The backend owns the client it created: closing it closes both.
      const { backend } = await createLocalPgliteBackend();
      // A batched timestamp key carries the session's offset: capture in a
      // fixed zone, so the fixtures do not depend on the capturing host.
      await backend.executeRaw(
        `SET TIME ZONE '${PLAIN_CURSOR_PGLITE_TIME_ZONE}'`,
        [],
      );
      return { backend, close: () => backend.close() };
    }
  }
}

function sortedQuery(
  store: any,
  sort: PlainCursorSort,
  selection: "node" | "fields",
): any {
  const query = store
    .query()
    .from(sort.kind, "n")
    .orderBy("n", sort.field, sort.direction);
  return selection === "node" ?
      query.select((ctx: any) => ctx.n)
    : query.select((ctx: any) => ({ id: ctx.n.id, value: ctx.n[sort.field] }));
}

type Terminal = "paginate" | "page" | "batchOnce";

async function readPage(
  store: any,
  query: () => any,
  terminal: Terminal,
  options: Record<string, unknown>,
): Promise<any> {
  switch (terminal) {
    case "paginate": {
      return query().paginate(options);
    }
    case "page": {
      return query().page(options).execute();
    }
    case "batchOnce": {
      const [page] = await store.batchOnce(() => [query().page(options)]);
      return page;
    }
  }
}

async function captureLane(
  root: string,
  lane: Lane,
): Promise<readonly PlainCursorFixture[]> {
  const scratch = mkdtempSync(path.join(tmpdir(), "plain-cursor-capture-"));
  const { backend, close } = await openBackend(root, lane, scratch);
  try {
    const library = await importFrom(root, "index.ts");
    const graph = library.defineGraph({
      id: "plain_cursor_capture",
      nodes: {
        Product: {
          type: library.defineNode("Product", {
            schema: z.object({
              name: z.string(),
              price: z.number(),
              category: z.string(),
              inStock: z.boolean().optional(),
              rating: z.number().optional(),
            }),
          }),
        },
        Document: {
          type: library.defineNode("Document", {
            schema: z.object({
              title: z.string(),
              publishedAt: z.date().optional(),
            }),
          }),
        },
      },
      edges: {},
    });
    const [store] = await library.createStoreWithSchema(graph, backend);
    for (const { kind, id, props } of PLAIN_CURSOR_SEED) {
      await store.nodes[kind].create(
        kind === "Document" && typeof props["publishedAt"] === "string" ?
          { ...props, publishedAt: new Date(props["publishedAt"]) }
        : props,
        { id },
      );
    }

    const fixtures = new Map<string, PlainCursorFixture>();
    for (const sort of PLAIN_CURSOR_SORTS) {
      for (const selection of ["node", "fields"] as const) {
        const query = () => sortedQuery(store, sort, selection);
        for (const terminal of ["paginate", "page", "batchOnce"] as const) {
          for (const direction of ["forward", "backward"] as const) {
            let cursor: string | undefined;
            for (let guard = 0; guard < 20; guard += 1) {
              const options =
                direction === "forward" ?
                  {
                    first: 1,
                    ...(cursor === undefined ? {} : { after: cursor }),
                  }
                : {
                    last: 1,
                    ...(cursor === undefined ? {} : { before: cursor }),
                  };
              const page = await readPage(store, query, terminal, options);
              for (const issued of [page.nextCursor, page.prevCursor]) {
                if (issued === undefined) continue;
                const key = `${sort.kind}.${sort.field}.${sort.direction}:${issued}`;
                const existing = fixtures.get(key);
                const issuer = `${terminal}/${selection}`;
                if (existing !== undefined) {
                  if (!existing.issuedBy.includes(issuer))
                    fixtures.set(key, {
                      ...existing,
                      issuedBy: [...existing.issuedBy, issuer],
                    });
                  continue;
                }
                const after = await query().paginate({
                  first: 100,
                  after: issued,
                });
                const before = await query().paginate({
                  last: 100,
                  before: issued,
                });
                fixtures.set(key, {
                  lane,
                  sort,
                  cursor: issued,
                  issuedBy: [issuer],
                  after: after.data.map((row: any) => row.id),
                  before: before.data.map((row: any) => row.id),
                });
              }
              const more =
                direction === "forward" ? page.hasNextPage : page.hasPrevPage;
              cursor =
                direction === "forward" ? page.nextCursor : page.prevCursor;
              if (!more || cursor === undefined) break;
            }
          }
        }
      }
    }
    return [...fixtures.values()];
  } finally {
    await close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [root, output] = process.argv.slice(2);
  if (root === undefined || output === undefined)
    throw new Error(
      "usage: capture-plain-cursor-fixtures.ts <library src root> <output module>",
    );
  const fixtures: PlainCursorFixture[] = [];
  for (const lane of ["sqlite", "libsql", "pglite"] as const)
    fixtures.push(...(await captureLane(root, lane)));
  writeFileSync(
    output,
    [
      "/**",
      " * Golden cursors issued by the release before relevance-ordered cursors.",
      " * Generated by `scripts/capture-plain-cursor-fixtures.ts`; do not edit.",
      " */",
      'import type { PlainCursorFixture } from "./plain-cursor-seed";',
      "",
      `export const PLAIN_CURSOR_FIXTURES: readonly PlainCursorFixture[] = ${JSON.stringify(fixtures)};`,
      "",
    ].join("\n"),
  );
}

await main();
