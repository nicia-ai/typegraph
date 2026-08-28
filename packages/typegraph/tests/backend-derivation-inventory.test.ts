/**
 * THE INVENTORY RATCHET for derived-backend construction in `src/**`.
 *
 * The invariant it enforces: **every place the library builds a backend from
 * another backend is written down, with the reason it exists.** The lint block
 * in `eslint.config.mjs` bans the raw spellings (`{ ...backend }`,
 * `Object.assign`, a rest destructure) and the seam carries the
 * serialized-resource verdict, so a NEW derivation is correct by construction —
 * but it is also invisible. A wrapper nobody reviewed is how the class came
 * back the first time: the hooked query backend was built by spread, dropped
 * the mark, and the import guard then let a read-and-write-through-one-
 * connection stream proceed into a deadlock.
 *
 * So the seam call sites are enumerated here, in both directions: a call with
 * no entry fails, and an entry matching no call fails. Adding a derivation is
 * one line of inventory and one sentence of reason — the cost is deliberate,
 * because the sentence is the review.
 *
 * ## Honest statement of its limits
 *
 * - **It sees CALLS, not derivations.** A backend built some other way — a
 *   class wrapping another backend, a `Proxy` written by hand — is not a call
 *   to any of these five functions and does not appear. The lint block is what
 *   covers the spread/assign/destructure spellings; this covers the sanctioned
 *   one. Neither covers a bespoke wrapper, which is why the runtime provenance
 *   assertions in the cross-backend suite exist as the third net.
 * - **It is scoped to `src/**`.** Test doubles derive backends constantly and
 *   are ratcheted by count instead (`backend-derivation-population.test.ts`).
 * - **The key is `file` + source line, not a line number**, so unrelated edits
 *   above a call do not invalidate its entry. Two identical call lines in one
 *   file therefore share an entry; there are none today, and the failure mode
 *   is a missed stale-entry report rather than a missed new call.
 *
 * Parsed with the TypeScript parser rather than matched with a regex: a
 * multi-line generic call (`deriveBackend<\n  TransactionBackend,\n>(`) is a
 * real shape in this tree, and a scanner that cannot see one reports zero for
 * it and passes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

/**
 * The construction seam's exported constructors — every function in
 * `src/backend/derive-backend.ts` that returns a backend built from another
 * backend, and therefore every function that carries the audit.
 */
const SEAM_CONSTRUCTORS = [
  "deriveBackend",
  "projectBackend",
  "projectBackendWithout",
  "projectGraphBackend",
  "wrapWithManagedClose",
] as const;

type SeamConstructor = (typeof SEAM_CONSTRUCTORS)[number];

/** A declared derivation site: where it is, and why it exists. */
type InventoryEntry = Readonly<{
  /** Path relative to `packages/typegraph/src`. */
  file: string;
  /** The call's own source line, trimmed. */
  line: string;
  /** What this wrapper is for. Mandatory. */
  reason: string;
}>;

const INVENTORY: readonly InventoryEntry[] = [
  {
    file: "backend/derive-backend.ts",
    line: "return projectBackend(base, retained);",
    reason:
      "The seam composing itself: narrowing by omission is a projection of every retained key, so it inherits the carry rather than repeating it.",
  },
  {
    file: "backend/derive-backend.ts",
    line: "return projectBackend<GraphBackend, ProjectedGraphBackendKey>(",
    reason:
      "The seam composing itself: the portable port projection is the key allowlist applied through the one copying constructor.",
  },
  {
    file: "backend/derive-backend.ts",
    line: "return deriveBackend(backend, closeOverlay);",
    reason:
      "The seam composing itself: managed close is an overlay of one member, so the idempotent `close` decorates rather than copies.",
  },
  {
    file: "backend/conformance/atomic-mutation-program.ts",
    line: "projectGraphBackend(fixture.backend),",
    reason:
      "Semantic conformance deliberately probes a projected view of the registered root to prove exact-root mutation-program evidence does not leak through derivation.",
  },
  {
    file: "backend/drizzle/contribution-materializations.ts",
    line: "return deriveBackend<TransactionBackend>(",
    reason:
      "Gates the fulltext members of a transaction-scoped backend until the graph's contributions are materialized, leaving every other member forwarding.",
  },
  {
    file: "backend/drizzle/postgres.ts",
    line: "const trustedTx = deriveBackend(tx, {",
    reason:
      "Trusted import runs its bulk path against the caller's transaction with the temporary-write members overridden; the rest of the transaction backend must stay reachable.",
  },
  {
    file: "backend/postgres/pglite.ts",
    line: "const managedBackend = wrapWithManagedClose(backend, async () => {",
    reason:
      "The batteries-included PGlite factory owns the instance it created, so closing the backend must also close it — once, however many times close is called.",
  },
  {
    file: "backend/sqlite/local.ts",
    line: "const managedBackend = wrapWithManagedClose(backend, () => {",
    reason:
      "The batteries-included better-sqlite3 factory owns the handle it opened, so closing the backend must also close it.",
  },
  {
    file: "store/history-store-backend.ts",
    line: "return Object.freeze(projectBackend(backend, HISTORY_STORE_BACKEND_KEYS));",
    reason:
      "A history store exposes a deliberately narrower port than a live one; the allowlist is what makes the narrowing a decision rather than an omission.",
  },
  {
    file: "store/operations/edge-batch-validation.ts",
    line: "const validationBackend = deriveBackend(backend, {",
    reason:
      "In-batch cardinality accounting reads through the caller's write target, so the reads it issues must see that target's uncommitted rows.",
  },
  {
    file: "store/operations/node-operations.ts",
    line: "reader: deriveBackend(backend, reads),",
    reason:
      "Node constraint validation reads through the caller's write target, so the reads it issues must see that target's uncommitted rows. The same read spec is ALSO handed to the write executor, which decorates its own frame target with it; both applications are the one overlay this seam publishes.",
  },
  {
    file: "store/operations/write-executor.ts",
    line: "mintSessionOver(deriveBackend(target, reads)) as WriteSessionFor<K>;",
    reason:
      "The write frame owns the ONE decoration row work may ask for: a second session over a read overlay of THIS frame's target, so a fused step's uniqueness pre-check sees the pending state its own slice created while the write still lands on the real backend.",
  },
  {
    file: "store/recorded-capture.ts",
    line: "const overlay = deriveBackend(target, {",
    reason:
      "Recorded capture intercepts the write members of a transaction target to append recorded rows in the same frame as the write they record.",
  },
  {
    file: "store/recorded-capture.ts",
    line: "const projectedBackend = projectGraphBackend(backend);",
    reason:
      "The capture decorator overrides members on a projection rather than on the source, because a store backend may be frozen and a Proxy cannot answer for a frozen own property.",
  },
  {
    file: "store/recorded-capture.ts",
    line: "return deriveBackend(projectedBackend, {",
    reason:
      "The capture backend itself: write members forward through the recorded-write path, every other member through the projection.",
  },
  {
    file: "store/recorded-read-service.ts",
    line: "const projectedBackend = projectGraphBackend(backend);",
    reason:
      "Same re-boxing as recorded capture: the recorded-read binding decorates a fresh projection so a frozen source stays decoratable.",
  },
  {
    file: "store/recorded-read-service.ts",
    line: "return deriveBackend(projectedBackend, {",
    reason:
      "Recorded reads rewrite the read members to target the recorded relation at a coordinate; the write members forward untouched.",
  },
  {
    file: "store/store.ts",
    line: "const projected = projectGraphBackend(backend as GraphBackend);",
    reason:
      "The hooked query backend decorates a projection because store backends are frozen — and this is the site whose spread construction dropped the mark in #435.",
  },
  {
    file: "store/store.ts",
    line: "return deriveBackend(projected, {",
    reason:
      "The hooked query backend: `execute`/`executeRaw` are wrapped in the query hooks, and the object must still answer the serialized-connection question its source answers.",
  },
  {
    file: "store/store.ts",
    line: ": Object.freeze(projectGraphBackend(this[STORE_RUNTIME].backend));",
    reason:
      "`store.backend` is the portable port a caller may hold, frozen so a consumer cannot decorate the store's own backend in place.",
  },
];

/** A seam call found in the tree. */
type FoundSite = Readonly<{
  file: string;
  lineNumber: number;
  line: string;
  constructor: SeamConstructor;
}>;

function isSeamConstructor(name: string): name is SeamConstructor {
  return (SEAM_CONSTRUCTORS as readonly string[]).includes(name);
}

/**
 * The called function's name, when the callee is a plain identifier —
 * `deriveBackend(...)` or `deriveBackend<T>(...)`. A method call
 * (`something.deriveBackend()`) is deliberately not a seam call.
 */
function calleeName(call: ts.CallExpression): string | undefined {
  return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

/**
 * Every seam call in `source`, as `{file, lineNumber, line, constructor}`.
 *
 * Exported shape note: the source text is a parameter rather than a path so the
 * scanner can be exercised against a fixture, which is the only way to know it
 * still matches anything at all.
 */
function scanForSeamCalls(file: string, source: string): readonly FoundSite[] {
  const parsed = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const lines = source.split("\n");
  const sites: FoundSite[] = [];

  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name !== undefined && isSeamConstructor(name)) {
        const { line } = parsed.getLineAndCharacterOfPosition(
          node.expression.getStart(parsed),
        );
        sites.push({
          file,
          lineNumber: line + 1,
          line: (lines[line] ?? "").trim(),
          constructor: name,
        });
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }

  visit(parsed);
  return sites;
}

function collectTypeScriptFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectTypeScriptFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

function scanSourceTree(): readonly FoundSite[] {
  return collectTypeScriptFiles(SOURCE_ROOT).flatMap((file) =>
    scanForSeamCalls(
      path.relative(SOURCE_ROOT, file).replaceAll(path.sep, "/"),
      fs.readFileSync(file, "utf8"),
    ),
  );
}

/**
 * `file` and `line` joined on a separator neither can contain, written as the
 * six-character escape and never as the byte: a literal NUL makes the file
 * binary to Git, which then hides every future edit to this ratchet from
 * review.
 */
function siteKey(site: Readonly<{ file: string; line: string }>): string {
  return `${site.file}\u0000${site.line}`;
}

describe("derived-backend inventory ratchet", () => {
  const sites = scanSourceTree();

  it("has no derived-backend construction in src outside the inventory", () => {
    const declared = new Set(INVENTORY.map((entry) => siteKey(entry)));
    const undeclared = sites.filter((site) => !declared.has(siteKey(site)));

    const reported = undeclared.map(
      (site) => `${site.file}:${site.lineNumber}  ${site.line}`,
    );
    if (reported.length > 0) {
      throw new Error(
        `A backend is derived from another backend at a site the inventory does not declare:\n\n${reported.join("\n")}\n\n` +
          `Every wrapper over a backend inherits that backend's connection: the guards that refuse an export/import pair on one serialized connection read the verdict the seam carries. Add an entry to INVENTORY in this file with a one-line reason saying what the wrapper is for — the reason is the review.`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("has no stale inventory entry", () => {
    // An inventory that outlives the code it describes is worse than none: the
    // next reader trusts a list that no longer matches the tree.
    const present = new Set(sites.map((site) => siteKey(site)));
    const stale = INVENTORY.filter((entry) => !present.has(siteKey(entry)));

    const reported = stale.map((entry) => `${entry.file}  ${entry.line}`);
    if (reported.length > 0) {
      throw new Error(
        `These inventory entries match no call in src — the code moved or the derivation was removed. Delete them:\n\n${reported.join("\n")}`,
      );
    }
    expect(reported).toEqual([]);
  });

  it("finds a seam call the source tree does not currently contain", () => {
    // The scanner is load-bearing: one that matched nothing would pass both
    // assertions above with an inventory of 18 stale entries and no tree
    // coverage at all. So it is run against shapes chosen to break a
    // line-oriented matcher — a multi-line generic call and a call whose
    // callee name merely PREFIXES a seam name.
    const fixture = [
      "const decorated = deriveBackend(base, { execute });",
      "const narrowed = projectBackendWithout(base, ['executeRaw']);",
      "const wide = projectBackend<",
      "  GraphBackend,",
      "  ProjectedGraphBackendKey",
      ">(base, KEYS);",
      "const untouched = deriveBackendFromNothing(base);",
      "const method = registry.deriveBackend(base, {});",
    ].join("\n");

    const found = scanForSeamCalls("fixture.ts", fixture);

    expect(
      found.map((site) => `${String(site.lineNumber)}:${site.constructor}`),
    ).toEqual([
      "1:deriveBackend",
      "2:projectBackendWithout",
      "3:projectBackend",
    ]);
    // The reported line is the call's OWN line, which is what the inventory
    // keys on.
    expect(found[2]?.line).toBe("const wide = projectBackend<");
  });

  it("declares every seam constructor the seam exports", () => {
    // A constructor added to `derive-backend.ts` and not to SEAM_CONSTRUCTORS
    // is a whole class of derivation this ratchet stops seeing, silently.
    const seamSource = fs.readFileSync(
      path.join(SOURCE_ROOT, "backend/derive-backend.ts"),
      "utf8",
    );
    const parsed = ts.createSourceFile(
      "derive-backend.ts",
      seamSource,
      ts.ScriptTarget.Latest,
      false,
      ts.ScriptKind.TS,
    );
    const exportedFunctions = parsed.statements
      .filter(
        (statement): statement is ts.FunctionDeclaration =>
          ts.isFunctionDeclaration(statement) &&
          statement.body !== undefined &&
          (statement.modifiers ?? []).some(
            (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
          ),
      )
      .flatMap((statement) =>
        statement.name === undefined ? [] : [statement.name.text],
      );

    expect(exportedFunctions.toSorted()).toEqual(
      [...SEAM_CONSTRUCTORS].toSorted(),
    );
  });

  it("requires a reason on every inventory entry", () => {
    const missing = INVENTORY.filter(
      (entry) => entry.reason.trim().length < 20,
    );
    expect(missing.map((entry) => entry.file)).toEqual([]);
  });
});
