/**
 * The stamping-site inventory, ratcheted over source text (invariant I5).
 *
 * "No write path stamps a validity bound it did not judge" is a claim about a
 * SET of call sites, and no behavioral test can state it: a fourteenth site
 * added tomorrow with its own `?? timestamp` would leave every existing test
 * green while re-opening issue #407 on whatever path it serves. The claim is
 * structural, so the guard is too.
 *
 * Three parts, each an EQUALITY rather than a denylist, because a denylist only
 * catches the spellings someone already thought of:
 *
 *  (a) INVENTORY — the number of owner call sites in each writer file is exactly
 *      what this file declares. Reverting a site drops a count; adding one
 *      raises it.
 *  (b) LEAK CHECK — inside those files, every non-comment line that names the
 *      column either contains an owner call or is on a declared allowlist of
 *      read/forward lines. This is what catches a site that binds the column
 *      WITHOUT calling an owner, which is precisely how the duplicate resolver
 *      in `trusted-import.ts` survived the last two rounds of review.
 *  (c) FILE SET — the set of files under `src/backend/**` that name the column at
 *      all equals the thirteen declared here, each with the role that earns it. (a)
 *      and (b) only see three files; a NEW file that binds `valid_from` would be
 *      invisible to them, and I5 is quantified over the whole directory.
 *
 * The rule this defends is A2': a write that stamps a lower bound its caller did
 * not state stores the write instant, unless that instant would leave the window
 * readable at no coordinate, in which case it stores none. One owner
 * (`resolveStampedValidityLowerBound`) decides it everywhere; one pass-through
 * owner (`resolveStatedValidityLowerBound`) serves the single site that writes a
 * bound the caller DID state and therefore chooses nothing.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const BACKEND_DIR = fileURLToPath(new URL("../src/backend/", import.meta.url));

const STAMPING_OWNER = "resolveStampedValidityLowerBound";
const STATED_OWNER = "resolveStatedValidityLowerBound";

/** Every way the column can be named in source: the property and the column. */
const COLUMN_MENTION = /validFrom|valid_from/;

/**
 * The writer files, with the exact number of call sites of each owner.
 *
 * `operations/nodes.ts` has eight stamping sites: `buildUpdateNode`'s
 * `clearDeleted` leg RESETS the window rather than retaining it, so it chooses a
 * bound exactly as an insert does — and it is reachable unguarded from a `create`
 * whose id names an existing tombstone. The insert-if-absent fast path is a
 * separate INSERT builder and therefore owns its stamped lower bound too. The
 * two schema-fenced INSERT builders retain that same ownership because their
 * `INSERT ... SELECT` changes the admission predicate, not the write instant.
 *
 * `operations/edges.ts` has six and ONE pass-through: an edge resurrection that
 * names no `validFrom` retains the stored window instead of stamping, so its
 * window-writing leg only runs when the caller stated a bound.
 */
const WRITER_INVENTORY = {
  "drizzle/operations/nodes.ts": { stamping: 8, stated: 0 },
  "drizzle/operations/edges.ts": { stamping: 6, stated: 1 },
  "drizzle/trusted-import.ts": { stamping: 4, stated: 0 },
} as const satisfies Readonly<
  Record<string, Readonly<{ stamping: number; stated: number }>>
>;

/**
 * Lines inside the writer files that may name the column without calling an
 * owner, because they READ or FORWARD it rather than deciding it. Exact trimmed
 * source text: a new line that names the column fails until it is either routed
 * through an owner or declared here with a reason.
 *
 * The check is LINE-oriented, which has one consequence worth knowing before
 * reading a failure: an owner call whose arguments are split across lines leaves
 * `item.validFrom,` on a line of its own, and that line fails. The fix is to keep
 * the call and its arguments on one line, not to widen this allowlist — a line
 * that names the column and does not say what decides it is exactly what this
 * guard exists to notice, and no reader can tell the two cases apart from the
 * line alone either.
 */
const LEAK_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
  "drizzle/operations/nodes.ts": [
    // The compare-and-set fence's column argument — a READ of the bound the
    // caller asserted, never a choice about what to store.
    "nodes.validFrom,",
  ],
  "drizzle/operations/edges.ts": [
    // The gate that makes the site below a pass-through: it runs only when the
    // caller named a bound.
    "if (params.clearDeleted && params.validFrom !== undefined) {",
    // The fence's column argument, as for nodes.
    "edges.validFrom,",
  ],
  "drizzle/trusted-import.ts": [
    // Column lists and projections in the two dialects' INSERT text. They name
    // the column positionally; the VALUES bound into it are the owner calls.
    "(graph_id, kind, id, props, version, valid_from, valid_to, created_at, updated_at)",
    "(graph_id, id, kind, from_kind, from_id, to_kind, to_id, props, valid_from, valid_to, created_at, updated_at)",
    "SELECT graph_id, kind, id, props::jsonb, 1, valid_from, valid_to, created_at, created_at",
    ") AS imported(graph_id, kind, id, props, valid_from, valid_to, created_at)`;",
    "SELECT graph_id, id, kind, from_kind, from_id, to_kind, to_id, props::jsonb,",
    "valid_from, valid_to, created_at, created_at",
    "valid_from, valid_to, created_at",
  ],
};

/**
 * Every file under `src/backend/**` that names the column, and why it may.
 * Equality: a new one fails this test whether or not it writes anything.
 */
const BACKEND_COLUMN_FILES: Readonly<Record<string, string>> = {
  "drizzle/operations/nodes.ts": "writer — five stamping sites",
  "drizzle/operations/edges.ts":
    "writer — four stamping sites, one pass-through",
  "drizzle/trusted-import.ts":
    "writer — four stamping sites (native per-dialect INSERT)",
  "drizzle/operations/shared.ts":
    "expectedValidFromPredicate — the NULL-safe fence",
  "drizzle/operations/collections.ts": "read predicate",
  "live-node-candidates.ts": "read predicate (search currency)",
  "drizzle/operations/hybrid.ts": "projection into the hybrid-search statement",
  "row-mappers.ts": "row mapper — NULL to undefined",
  "drizzle/schema/sqlite.ts": "column declaration",
  "drizzle/schema/postgres.ts": "column declaration",
  "migrate-recorded-time.ts": "copy list naming the column",
  // Not a stamping site and never a fourteenth: the repair only CLEARS a bound
  // that was already stored inverted (`SET valid_from = NULL`), so it chooses
  // no instant and has nothing to route through an owner.
  "repair-validity-windows.ts":
    "offline repair — clears an inverted stored bound",
  "types.ts": "parameter types",
};

function backendSource(relativePath: string): string {
  return readFileSync(path.join(BACKEND_DIR, relativePath), "utf8");
}

/**
 * The source with comments removed, so a mention inside a doc block or a `//`
 * note is not mistaken for a call site — and, just as important, so a call site
 * cannot be forged by writing one inside a comment.
 */
function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
}

function countCalls(source: string, owner: string): number {
  return withoutComments(source).split(`${owner}(`).length - 1;
}

function columnLines(source: string): readonly string[] {
  return withoutComments(source)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => COLUMN_MENTION.test(line));
}

/** Every `.ts` file under `src/backend/**`, relative to that directory. */
function backendFiles(directory: string, prefix: string): readonly string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = path.join(directory, entry);
    const relative = prefix === "" ? entry : `${prefix}/${entry}`;
    if (statSync(absolute).isDirectory())
      return backendFiles(absolute, relative);
    return entry.endsWith(".ts") ? [relative] : [];
  });
}

describe("the stamping-site inventory (I5)", () => {
  it("has exactly the declared number of owner call sites per writer file", () => {
    const counted = Object.fromEntries(
      Object.keys(WRITER_INVENTORY).map((relativePath) => {
        const source = backendSource(relativePath);
        return [
          relativePath,
          {
            stamping: countCalls(source, STAMPING_OWNER),
            stated: countCalls(source, STATED_OWNER),
          },
        ];
      }),
    );
    // Equality over the whole map, so a site MOVING between files fails too.
    expect(counted).toStrictEqual({ ...WRITER_INVENTORY });
  });

  it("routes every line that names the column through an owner or a declared read", () => {
    for (const [relativePath, allowed] of Object.entries(LEAK_ALLOWLIST)) {
      const undeclared = columnLines(backendSource(relativePath)).filter(
        (line) =>
          !line.includes(`${STAMPING_OWNER}(`) &&
          !line.includes(`${STATED_OWNER}(`) &&
          !allowed.includes(line),
      );
      expect({ file: relativePath, undeclared }).toStrictEqual({
        file: relativePath,
        undeclared: [],
      });
    }
  });

  it("names the column in exactly the declared files under src/backend", () => {
    const mentioning = backendFiles(BACKEND_DIR, "")
      .filter((relativePath) =>
        COLUMN_MENTION.test(backendSource(relativePath)),
      )
      .toSorted();
    expect(mentioning).toStrictEqual(
      Object.keys(BACKEND_COLUMN_FILES).toSorted(),
    );
  });

  it("declares a role for every file it admits", () => {
    // The role strings are the point of the previous assertion: a file added to
    // the set without one would pass set equality while documenting nothing.
    for (const role of Object.values(BACKEND_COLUMN_FILES)) {
      expect(role.length).toBeGreaterThan(0);
    }
    expect(Object.keys(BACKEND_COLUMN_FILES)).toHaveLength(13);
  });
});
