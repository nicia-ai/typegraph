/**
 * The Lead ruling's condition on the identity transition log's "no-log
 * line": *a ratchet test asserts no code path reads membership from
 * `typegraph_identity_transitions`.*
 *
 * §2.1 of the design note states the invariant directly: "a transition row
 * carries no membership... every membership answer in the replay API is
 * produced by calling `historicalIdentityReconstructionCtes`". That is
 * enforced by construction inside `src/identity/replay.ts` (see its own
 * top-of-file docblock), but nothing previously stopped a FUTURE writer
 * elsewhere in `src/**` from reaching into the relation directly — through
 * `SqlSchema.identityTransitionsTable`, a Drizzle table object's
 * `identityTransitions` field, or the raw `"typegraph_identity_transitions"`
 * string — and deriving a membership answer from it. This file is that
 * stop: it scans every `.ts` file under `src/` for a reference to the
 * relation and fails on any file outside `MODULE_ALLOWLIST`, in both
 * directions (an allowlisted file whose reference disappeared is stale and
 * must be removed, so the list stays an honest map of the tree rather than
 * a rubber stamp).
 *
 * The allowlist is MODULE-level (a file may reference the relation more than
 * once — write plumbing, an index, a doc comment — for one already-reviewed
 * reason), matching how the ruling itself is phrased ("no CODE PATH reads
 * membership"): a module either legitimately touches the physical relation
 * (as a writer, a reader, a DDL/schema declaration, or the whole-graph
 * `clear()` sweep) or it does not.
 *
 * *Mutation*: add a `readIdentityTransitions(...)`-shaped call — or any
 * bare reference to `identityTransitionsTable` / `tables.identityTransitions`
 * / the raw table name — to a module not on `MODULE_ALLOWLIST` (for example,
 * reintroduce the fold-vs-restore probe this PR removed from
 * `service-maintenance.ts`, see G1-04) → the "undeclared" assertion fails,
 * naming the file. *Mutation*: remove the ONE writer (`flush.ts`) from the
 * allowlist while its INSERT still stands → also fails "undeclared" (the
 * file is unnamed but the reference still exists). *Mutation*: delete an
 * allowlisted file's only reference (e.g. rewrite `clear.ts` to skip the
 * relation) while its entry survives → the "stale" assertion fails, naming
 * the entry.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SOURCE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src",
);

/**
 * Matches the SqlSchema field (`identityTransitionsTable`) and the bare
 * table-name identifier (`identityTransitions`, as in
 * `tables.identityTransitions` or the `DEFAULT_TABLE_NAMES` key) — but NOT
 * `identityTransitionsOf` (the replay-facing function — see
 * {@link READ_TRANSITIONS_REFERENCE} for the relation access IT makes, one
 * level down through `readIdentityTransitions`) and NOT
 * `identityTransitionRetentionTable` / `identityTransitionRetention` (the
 * SEPARATE, singular-"Transition" retention-watermark relation, which is
 * out of this ratchet's scope). The raw string literal
 * `"typegraph_identity_transitions"` is not scanned for separately: every
 * site that carries it today does so as this identifier's value, on the
 * same line.
 */
const TRANSITION_LOG_REFERENCE = /\bidentityTransitions(Table)?\b/;

/**
 * Matches the relation's ONE read primitive by name — a module can reach the
 * relation's ROWS through this call without ever naming
 * `identityTransitionsTable` or `tables.identityTransitions` itself (a
 * probe appending a `membersFromLog(rows)`-shaped helper to
 * `service-read.ts`, deriving membership from rows a caller already fetched
 * via `readIdentityTransitions`, is exactly this shape — see G1R2-05).
 */
const READ_TRANSITIONS_REFERENCE = /\breadIdentityTransitions\b/;

/**
 * Matches an import statement pulling ANYTHING from the transition-log
 * module, regardless of which name it imports — a backstop against a
 * renamed re-export (`export { readIdentityTransitions as X }`) slipping a
 * membership-capable import past {@link READ_TRANSITIONS_REFERENCE}'s bare
 * identifier match. Every current import from this module (types, the
 * `diffClosureTransitions` predicate, the one writer) is reviewed and
 * allowlisted below; a NEW import path match is a new module to review, not
 * necessarily a violation.
 */
const TRANSITION_LOG_IMPORT_PATH =
  /from ["'](?:\.\/|(?:\.\.\/)+identity\/)transition-log["']/;

function referencesTransitionLog(line: string): boolean {
  return (
    TRANSITION_LOG_REFERENCE.test(line) ||
    READ_TRANSITIONS_REFERENCE.test(line) ||
    TRANSITION_LOG_IMPORT_PATH.test(line)
  );
}

type AllowedModule = Readonly<{
  /** Path relative to `packages/typegraph/src`. */
  file: string;
  /** Why this module legitimately references the relation. Mandatory. */
  reason: string;
}>;

const MODULE_ALLOWLIST: readonly AllowedModule[] = [
  {
    file: "identity/transition-log.ts",
    reason:
      "The relation's one owner: the row shape, the encoder, readIdentityTransitions (SELECT — boundaries and explanations only, never membership), and pruneIdentityTransitionsForContext (DELETE, retention).",
  },
  {
    file: "store/recorded-capture/flush.ts",
    reason:
      "The ONE writer: flushIdentityTransitions INSERTs the buffered notes against the recorded commit the same flush allocates for every other recorded relation.",
  },
  {
    file: "backend/drizzle/operations/clear.ts",
    reason:
      "store.clear()'s whole-graph sweep DELETEs every row for the graph, exactly as it does for every other graph-scoped relation — not a membership read.",
  },
  {
    file: "query/compiler/schema.ts",
    reason:
      "SqlSchema / SqlTableNames declare the `identityTransitionsTable` fragment and the `identityTransitions` default table name — structural schema wiring, not a read.",
  },
  {
    file: "backend/drizzle/schema/sqlite.ts",
    reason:
      "SqliteTableNames / DEFAULT_TABLE_NAMES name the relation for DDL generation.",
  },
  {
    file: "backend/drizzle/schema/postgres.ts",
    reason:
      "The Drizzle `pgTable` definition (columns, PK, the three indexes from §2.2) and the default table name.",
  },
  {
    file: "backend/drizzle/sqlite.ts",
    reason:
      "Resolves the configured/default table name into the SQLite backend's `SqlTableNames`, mirroring every other relation.",
  },
  {
    file: "backend/drizzle/postgres.ts",
    reason:
      "Resolves the configured/default table name into the PostgreSQL backend's `SqlTableNames`, mirroring every other relation.",
  },
  {
    file: "backend/types.ts",
    reason:
      "IdentityTableNames names the relation as one of the six Operational Identity table-name fields a backend port speaks about — structural, not a read.",
  },
  {
    file: "backend/drizzle/engine/members/identity-members.ts",
    reason:
      "IDENTITY_TABLE_LOGICAL_NAMES scopes ensureIdentityTables/identityTableDdl's DDL provisioning to include the relation — DDL as data, never executed here and never a membership read.",
  },
  {
    file: "identity/schema-transition.ts",
    reason:
      "identityTableNames() resolves the relation's configured physical name into the IdentityTableNames struct handed to the DDL-provisioning ports above — structural wiring, not a read.",
  },
  {
    file: "identity/replay.ts",
    reason:
      "The one consumer of readIdentityTransitions: reads rows for boundary/cause/provenance data ONLY — every membership answer it returns comes from historicalIdentityReconstructionCtes instead (its own top-of-file docblock), structurally pinned by tests/identity-replay.test.ts (L3).",
  },
  {
    file: "identity/service-mutation.ts",
    reason:
      "Imports diffClosureTransitions — the pure before/after class-diff predicate, not the relation — to compute the record a caller's own noteTransition then writes.",
  },
  {
    file: "identity/service-maintenance.ts",
    reason:
      "Imports diffClosureTransitions for the same reason as service-mutation.ts — a pure predicate over closure snapshots, never the relation's rows.",
  },
  {
    file: "identity/service-interchange-write.ts",
    reason:
      "Imports the IdentityDecisionProvenance type only, to type a governed-apply's decision metadata before handing it to noteTransition — no relation access.",
  },
  {
    file: "store/recorded-capture.ts",
    reason:
      "Imports IdentityDecisionProvenance / IdentityTransitionDraft / IdentityTransitionNote — the touch/noteTransition callback types the capture session's public surface is typed against. The one writer (flush.ts) INSERTs; this file only buffers notes callers hand it.",
  },
  {
    file: "store/runtime-port.ts",
    reason:
      "Imports the IdentityDecisionProvenance type only, to declare the optional `decision` parameter graph-merge's identity apply threads through applyIdentityMergeAtTarget — a port signature, no relation access.",
  },
  {
    file: "store/store.ts",
    reason:
      "Imports the IdentityDecisionProvenance type only, to implement that same port method and pass the decision through to applyIdentityChangesForContext — no relation access.",
  },
  {
    file: "graph-merge/typegraph-internal.ts",
    reason:
      "Re-exports the IdentityDecisionProvenance type through graph-merge's one seam onto the rest of the package, so the merge builds its decision against the owner's shape instead of re-spelling it — a type re-export, no relation access.",
  },
  {
    file: "store/recorded-capture/relations.ts",
    reason:
      "Imports IDENTITY_TRANSITION_COLUMN_NAMES for its .length only, to derive the per-statement chunk size flush.ts binds — column-count arithmetic, never a row.",
  },
];

type FoundSite = Readonly<{ file: string; lineNumber: number; line: string }>;

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

function scanForTransitionLogReferences(): readonly FoundSite[] {
  const sites: FoundSite[] = [];
  for (const file of collectTypeScriptFiles(SOURCE_ROOT)) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      if (!referencesTransitionLog(line)) continue;
      sites.push({
        file: path.relative(SOURCE_ROOT, file).replaceAll(path.sep, "/"),
        lineNumber: index + 1,
        line: line.trim(),
      });
    }
  }
  return sites;
}

describe("identity transition log module ratchet", () => {
  const sites = scanForTransitionLogReferences();
  const filesWithReferences = new Set(sites.map((site) => site.file));
  const allowedFiles = new Set(MODULE_ALLOWLIST.map((entry) => entry.file));

  it("references the relation only from an allowlisted module", () => {
    const undeclared = [...filesWithReferences].filter(
      (file) => !allowedFiles.has(file),
    );
    if (undeclared.length > 0) {
      const reported = undeclared.flatMap((file) =>
        sites
          .filter((site) => site.file === file)
          .map((site) => `${site.file}:${site.lineNumber}  ${site.line}`),
      );
      throw new Error(
        `A module outside MODULE_ALLOWLIST references the identity transition log:\n\n${reported.join("\n")}\n\n` +
          `Membership must never be derived from typegraph_identity_transitions — every membership answer comes from historicalIdentityReconstructionCtes (see src/identity/replay.ts). ` +
          `If this reference does not read membership (a writer, a DDL/schema declaration, or a whole-graph clear/prune sweep), add it to MODULE_ALLOWLIST in this file with a one-line reason.`,
      );
    }
    expect(undeclared).toEqual([]);
  });

  it("has no stale allowlist entry", () => {
    const stale = MODULE_ALLOWLIST.filter(
      (entry) => !filesWithReferences.has(entry.file),
    );
    if (stale.length > 0) {
      throw new Error(
        `These allowlist entries no longer reference the identity transition log — the code moved or was removed. Delete them:\n\n${stale.map((entry) => entry.file).join("\n")}`,
      );
    }
    expect(stale).toEqual([]);
  });

  it("requires a reason on every allowlist entry", () => {
    const missing = MODULE_ALLOWLIST.filter(
      (entry) => entry.reason.trim().length < 20,
    );
    expect(missing.map((entry) => entry.file)).toEqual([]);
  });

  it("does not flag identityTransitionsOf, the retention relation, or a Set named `live`", () => {
    // The scanner is itself load-bearing: it must distinguish the
    // replay-facing function name and the SEPARATE retention relation from a
    // genuine reference to typegraph_identity_transitions.
    expect(
      TRANSITION_LOG_REFERENCE.test("identityTransitionsOf(ctx, ref)"),
    ).toBe(false);
    expect(
      TRANSITION_LOG_REFERENCE.test(
        "await pruneIdentityTransitionsForContext(ctx, options)",
      ),
    ).toBe(false);
    expect(
      TRANSITION_LOG_REFERENCE.test(
        "identityTransitionRetentionTable: SqlFragment;",
      ),
    ).toBe(false);
    // ...and it DOES catch the shapes it exists to catch.
    expect(
      TRANSITION_LOG_REFERENCE.test("ctx.schema.identityTransitionsTable"),
    ).toBe(true);
    expect(TRANSITION_LOG_REFERENCE.test("tables.identityTransitions")).toBe(
      true,
    );
  });
});
