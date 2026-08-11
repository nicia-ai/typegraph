/**
 * THE RATCHET for the write-pipeline seam.
 *
 * The invariant it enforces: **no module outside the declared exemptions calls
 * a backend mutation member.** ESLint enforces that on the files it lints;
 * this file enforces the things ESLint cannot — that the exemption list has no
 * stale entry and no missing violator (set EQUALITY, both directions), that
 * the `.mjs` inventory the flat config reads still names exactly the members
 * the TypeScript classification calls writes, and that the generated lint
 * blocks partition their scope instead of quietly dropping a guardrail from a
 * file.
 *
 * ## Why the TypeScript AST rather than a regex
 *
 * Check (b) is an EQUALITY, so a false positive is as fatal as a false
 * negative, and both are reachable with text matching: `provenance-store.ts`
 * mentions `backend.insertNode` in a docstring (a regex scan would call it a
 * violator that ESLint does not), and a line-wrapped `target\n  .insertNode(`
 * would be a violation a regex scan misses. Parsing removes both classes
 * instead of documenting them, and `typescript` is already a devDependency.
 *
 * The scan implements the rule's three selectors exactly — a call through a
 * member expression, a hoist of a member into a local, and a
 * `requireDefined(...)` wrap — and, like the rule, deliberately does NOT match
 * capability probes (`x.member === undefined`), which are legitimate.
 *
 * Following `data-keyed-bag-ratchet.test.ts`'s rationale: no ESLint API, no
 * custom rule package. A file scan is cheap and the list-with-reasons is more
 * legible than inline disables scattered across the tree.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import {
  matchesFilePattern,
  profileCovers,
  WRITE_MEMBER_NAMES,
  WRITE_PIPELINE_EXEMPTIONS,
  writePipelineBlocks,
} from "../eslint/write-pipeline-inventory.mjs";
import { GRAPH_BACKEND_MEMBER_CLASSES } from "../src/backend/member-classes";
import { WRITE_MEMBER_KEYS } from "../src/store/operations/write-members";

const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const SOURCE_ROOT = path.join(PACKAGE_ROOT, "src");

/**
 * `src/backend/**` is deliberately out of scope: it IS the backend, and its
 * files legitimately implement and call these members.
 */
const SCAN_EXCLUDED_DIRECTORY = path.join(SOURCE_ROOT, "backend");

/**
 * Ratchet constants. Each may only ever DECREASE, and the batch that lowers
 * one lowers it in the same commit that changes what it counts.
 */
const RATCHET = {
  /**
   * Exemption entries that are migration debt rather than reasoned carve-outs.
   * ZERO from the batch that moved interchange import onto the executor: every
   * remaining entry states why it cannot route through a write plan.
   */
  nonPermanentExemptions: 0,
  /**
   * `runInWriteTransaction` / `runHookedWriteOperation` call sites outside
   * their owner module. The two that remain (`identity/service-facade.ts`,
   * `store.ts`) are the permanent floor: they gain no session, no fences and
   * no sidecars from a plan.
   */
  managedWriteEntryPoints: 2,
  /**
   * `unfencedTarget()` escapes — the typed hole that hands row work the full
   * backend union back. It was nonzero from the first batch that moved call
   * sites onto the executor and fell to one as the union-typed preparation
   * helpers, constraint and uniqueness probes, and identity hooks were
   * re-typed onto the read projection.
   *
   * ONE is a reasoned floor, not slack. The bulk getOrCreate's nested legs
   * re-enter the executor against their enclosing frame's target, and re-entry
   * mints a session, which writes — so it needs the full union by
   * construction. Removing it would mean inlining those legs' row work, which
   * would drop the nested frames' schema fence and revision-clock advance: a
   * behavior change. A SECOND escape is migration debt, and fails here.
   */
  unfencedTargetEscapes: 1,
} as const;

/**
 * `GraphBackend`'s member count, recorded so the classification's size is
 * visible. Adding a member moves this number and forces the new member into a
 * class — which is the point: whoever adds it decides whether it is a write.
 */
const MEMBER_COUNT = 112;

type Violation = Readonly<{ file: string; member: string; line: number }>;

function collectTypeScriptFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (full === SCAN_EXCLUDED_DIRECTORY) continue;
      found.push(...collectTypeScriptFiles(full));
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

function relativeToPackage(file: string): string {
  return path.relative(PACKAGE_ROOT, file).replaceAll(path.sep, "/");
}

/** The rule's three selectors, as an AST walk. */
function scanFile(file: string, banned: ReadonlySet<string>): Violation[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
  );
  const found: Violation[] = [];
  const record = (node: ts.Node, member: string): void => {
    found.push({
      file: relativeToPackage(file),
      member,
      line:
        source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
    });
  };

  const visit = (node: ts.Node): void => {
    // 1. direct call: target.insertNode(params)
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      banned.has(node.expression.name.text)
    ) {
      record(node, node.expression.name.text);
    }
    // 2. hoist to local: const updateNodeSet = target.updateNodeSet;
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer !== undefined &&
      ts.isPropertyAccessExpression(node.initializer) &&
      banned.has(node.initializer.name.text)
    ) {
      record(node, node.initializer.name.text);
    }
    // 3. requireDefined wrap: requireDefined(backend.insertNodesBatch)(params)
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "requireDefined"
    ) {
      for (const argument of node.arguments) {
        if (
          ts.isPropertyAccessExpression(argument) &&
          banned.has(argument.name.text)
        ) {
          record(node, argument.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

function scanSourceTree(banned: ReadonlySet<string>): readonly Violation[] {
  return collectTypeScriptFiles(SOURCE_ROOT).flatMap((file) =>
    scanFile(file, banned),
  );
}

/**
 * The two modules allowed to call `runInWriteTransaction` /
 * `runHookedWriteOperation`: the one that OWNS the lock decision, and the
 * executor that is the seam's single sanctioned entry into it. Every other
 * call is an unsanctioned managed-write entry point, and the count of those
 * only ever decreases.
 */
const SANCTIONED_TRANSACTION_CALLERS = new Set([
  "src/store/operations/write-transaction.ts",
  "src/store/operations/write-executor.ts",
]);

const MANAGED_WRITE_ENTRY_FUNCTIONS = new Set([
  "runInWriteTransaction",
  "runHookedWriteOperation",
]);

function countManagedWriteEntryPoints(): number {
  let count = 0;
  for (const file of collectTypeScriptFiles(SOURCE_ROOT)) {
    if (SANCTIONED_TRANSACTION_CALLERS.has(relativeToPackage(file))) continue;
    const source = ts.createSourceFile(
      file,
      fs.readFileSync(file, "utf8"),
      ts.ScriptTarget.ESNext,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        MANAGED_WRITE_ENTRY_FUNCTIONS.has(node.expression.text)
      ) {
        count += 1;
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return count;
}

function countOccurrences(pattern: RegExp): number {
  return collectTypeScriptFiles(SOURCE_ROOT)
    .map((file) => fs.readFileSync(file, "utf8").match(pattern)?.length ?? 0)
    .reduce((total, count) => total + count, 0);
}

const bannedMembers = new Set(WRITE_MEMBER_NAMES);
const violations = scanSourceTree(bannedMembers);
const violatingFiles = new Set(violations.map((violation) => violation.file));

describe("the GraphBackend member classification", () => {
  const classified = Object.values(GRAPH_BACKEND_MEMBER_CLASSES).flatMap(
    (members) => [...members],
  );

  it("classifies every member exactly once", () => {
    // The compile-time pins in `member-classes.ts` are the enforcement — a new
    // member fails the totality assertion, a doubly-classified one fails the
    // disjointness assertion by NAME. This is their runtime witness: it makes
    // the recorded size of the surface visible in a failure message rather
    // than only in a type error, and it is what keeps the ten classes from
    // being written and then never referenced.
    const duplicates = classified.filter(
      (member, index) => classified.indexOf(member) !== index,
    );
    expect(duplicates).toEqual([]);
    expect(classified).toHaveLength(MEMBER_COUNT);
  });

  it("derives the ban from exactly the three write classes", () => {
    expect([...WRITE_MEMBER_KEYS]).toEqual([
      ...GRAPH_BACKEND_MEMBER_CLASSES.entityWrite,
      ...GRAPH_BACKEND_MEMBER_CLASSES.sidecarWrite,
      ...GRAPH_BACKEND_MEMBER_CLASSES.bulkWrite,
    ]);
  });
});

describe("write-pipeline ratchet", () => {
  it("keeps the lint inventory and the typed member classification in step", () => {
    // Neither list is copied from the other: the TypeScript one is derived
    // from `GraphBackend` by the member classification, the `.mjs` one is what
    // the flat config can actually import. Drift in EITHER direction is a lie
    // about what the ban covers.
    expect([...WRITE_MEMBER_NAMES].toSorted()).toEqual(
      [...WRITE_MEMBER_KEYS].toSorted(),
    );
  });

  it("lists every violating file, and no file that does not violate", () => {
    const exempt = new Set(
      WRITE_PIPELINE_EXEMPTIONS.map((entry) => entry.path),
    );
    const unlisted = [...violatingFiles].filter((file) => !exempt.has(file));
    const stale = [...exempt].filter((file) => !violatingFiles.has(file));

    if (unlisted.length > 0 || stale.length > 0) {
      throw new Error(
        `The write-pipeline exemption list no longer matches the tree.\n\n` +
          (unlisted.length === 0 ?
            ""
          : `These files call a banned backend member and are NOT exempt. Route the write through the session (src/store/operations/write-session.ts), or add an entry with a reason if the call genuinely cannot:\n${unlisted.join("\n")}\n\n`) +
          (stale.length === 0 ?
            ""
          : `These exemption entries no longer describe a violating file — the calls moved or were migrated. Delete them:\n${stale.join("\n")}\n`),
      );
    }
    expect([...violatingFiles].toSorted()).toEqual([...exempt].toSorted());
  });

  it("requires a reason and an explicit permanence on every entry", () => {
    const malformed = WRITE_PIPELINE_EXEMPTIONS.filter(
      (entry) =>
        entry.reason.trim().length < 20 || typeof entry.permanent !== "boolean",
    );
    expect(malformed.map((entry) => entry.path)).toEqual([]);
  });

  it("does not grow the migration debt it is ratcheting down", () => {
    const nonPermanent = WRITE_PIPELINE_EXEMPTIONS.filter(
      (entry) => !entry.permanent,
    );
    expect(nonPermanent.length).toBeLessThanOrEqual(
      RATCHET.nonPermanentExemptions,
    );
  });

  it("does not grow the set of unsanctioned managed-write entry points", () => {
    expect(countManagedWriteEntryPoints()).toBeLessThanOrEqual(
      RATCHET.managedWriteEntryPoints,
    );
  });

  it("does not grow the counted `unfencedTarget` widening escapes", () => {
    // Definition and re-export excluded: only CALLS are escapes.
    expect(countOccurrences(/\bunfencedTarget\(/g) - 1).toBeLessThanOrEqual(
      RATCHET.unfencedTargetEscapes,
    );
  });

  it("catches a violation the exemption list does not cover", () => {
    // The scanner is itself load-bearing: one that matched nothing would pass
    // every assertion above. Each of the rule's three spellings is exercised
    // against source text, in a file path no exemption covers.
    const probe = path.join(SOURCE_ROOT, "store", "ratchet-probe.ts");
    const write = (body: string): readonly Violation[] => {
      fs.writeFileSync(probe, body);
      try {
        return scanFile(probe, bannedMembers);
      } finally {
        fs.rmSync(probe);
      }
    };

    expect(
      write("export const go = (b: B) => b.insertNode(p);\n"),
    ).toHaveLength(1);
    expect(write("const insertNode = backend.insertNode;\n")).toHaveLength(1);
    expect(
      write("export const go = () => requireDefined(b.insertNodesBatch)(p);\n"),
    ).toHaveLength(1);

    // …and the shapes it must NOT flag: capability probes and unrelated names.
    expect(
      write("export const has = (b: B) => b.insertNode === undefined;\n"),
    ).toEqual([]);
    expect(write("export const go = (b: B) => b.getNode(g, k, i);\n")).toEqual(
      [],
    );
  });
});

describe("write-pipeline lint blocks", () => {
  const profiles = [
    {
      name: "store",
      files: ["src/store/**/*.ts"],
      ignores: ["src/store/store.ts"],
      restrictions: [{ selector: "A", message: "a" }],
    },
    {
      name: "audited",
      files: ["src/store/store.ts"],
      restrictions: [{ selector: "B", message: "b" }],
    },
  ] as const;
  const exemptions = [
    {
      path: "src/store/claims/node-claims.ts",
      reason: "sidecar",
      permanent: true,
    },
    { path: "src/store/store.ts", reason: "lifecycle", permanent: true },
  ] as const;
  const blocks = writePipelineBlocks({ profiles, exemptions });

  it("gives every file in scope exactly its profile's restriction list", () => {
    // A block that forgot to respell its profile's list would silently switch
    // that guardrail off for its files, because flat-config rule entries
    // REPLACE rather than merge. Asserting the generated array directly is
    // what keeps "the lint output is otherwise unchanged" honest.
    for (const block of blocks) {
      const profile = profiles.find((candidate) =>
        block.name.startsWith(`typegraph/write-pipeline/${candidate.name}`),
      );
      const restrictions = block.rules["no-restricted-syntax"].slice(1);
      expect(profile).toBeDefined();
      expect(restrictions.slice(0, profile?.restrictions.length)).toEqual(
        profile?.restrictions,
      );
    }
  });

  it("adds the ban to the in-scheme half and only to it", () => {
    const inScheme = blocks.filter((block) => !block.name.endsWith("/exempt"));
    const exempt = blocks.filter((block) => block.name.endsWith("/exempt"));
    expect(inScheme).toHaveLength(2);
    expect(exempt).toHaveLength(2);
    for (const block of inScheme) {
      expect(block.rules["no-restricted-syntax"].length).toBe(1 + 1 + 3);
    }
    for (const block of exempt) {
      expect(block.rules["no-restricted-syntax"].length).toBe(1 + 1);
    }
  });

  it("places every exempt path in exactly one block, its own profile's", () => {
    for (const entry of exemptions) {
      const covering = blocks.filter(
        (block) =>
          block.files.some((pattern) =>
            matchesFilePattern(entry.path, pattern),
          ) &&
          !(block.ignores ?? []).some((pattern) =>
            matchesFilePattern(entry.path, pattern),
          ),
      );
      expect(covering.map((block) => block.name)).toHaveLength(1);
      expect(covering[0]?.name).toMatch(/\/exempt$/);
    }
  });

  it("matches paths against a pattern the way the blocks are scoped", () => {
    expect(
      matchesFilePattern("src/store/operations/x.ts", "src/store/**/*.ts"),
    ).toBe(true);
    expect(matchesFilePattern("src/store/x.ts", "src/store/**/*.ts")).toBe(
      true,
    );
    expect(matchesFilePattern("src/query/x.ts", "src/store/**/*.ts")).toBe(
      false,
    );
    expect(matchesFilePattern("src/store/x.mts", "src/store/**/*.ts")).toBe(
      false,
    );
    expect(
      profileCovers("src/store/store.ts", {
        files: ["src/store/**/*.ts"],
        ignores: ["src/store/store.ts"],
      }),
    ).toBe(false);
  });
});
