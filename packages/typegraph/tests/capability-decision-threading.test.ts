/**
 * T13 — the decision-threading pattern: a verdict is resolved ONCE against
 * `GraphBackend` and threaded; binding happens locally, off whichever port
 * the call site holds, and the bound value is `===` the port's own member.
 *
 * (a) types `resolveBundle(tx, …)` as a compile error — a transaction port
 * is not where the support question is answered.
 * (b) pins the pattern behaviorally: resolve at entry, enter
 * `store.transaction()`, bind through the bundle's member accessor inside —
 * the verdict is `toBe`-identical and each bound member is `===` the
 * corresponding transaction member.
 *
 * B6 ships no production call site that threads a verdict through
 * `store.transaction()` — this test PINS the pattern; B7/B8 anchor it in
 * production code (`claimSupport`'s move onto the framework, and the
 * `uniqueSidecarBatch`/`batchPointRead` call sites).
 *
 * (c) B7's `ClaimsVerdictThunk`: interning (one thunk per backend object),
 * memoization (at most one `resolveBundle` per thunk, ever — including across
 * a simulated write loop), a production anchor through `store.transaction()`,
 * and the one-owner ratchet — a source scan proving `claimsVerdict`/
 * `resolveBundle` are never called, as bare identifiers, from `src/store/**`,
 * `src/interchange/**` or `src/provenance/**`. The scan is AST-based
 * (`ts.isIdentifier`, not a substring match) for the same reason
 * `backend-derivation-inventory.test.ts` is: `ctx.claimsVerdict()` calls the
 * THUNK field of that name and must not trip a scan meant to catch a bare
 * `claimsVerdict(...)` call, which only a direct import of the raw accessor
 * can spell.
 *
 * B8 extends the ratchet to all six named verdict accessors
 * (`batchPointReadVerdict`, `uniqueSidecarBatchVerdict`,
 * `statementExecutionVerdict`, `contributionHealthVerdict`,
 * `recordedRevisionOriginsVerdict`, alongside `claimsVerdict`), each of which
 * genuinely does resolve eagerly (no thunk — B8's rationale is that no pilot
 * bundle below has a `crossCheck`), so a blanket zero-tolerance ban would be
 * false: `store.ts`'s constructor, `guards.ts`'s construction gates,
 * `recorded-capture.ts`'s overlay, and `import.ts`'s write-plan context are
 * the named minting sites, each measured and pinned by `(file, name, count)`
 * below. `resolveBundle` and `claimsVerdict` keep their EXISTING zero
 * tolerance — the allowlist adds no entry for either.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createStore, defineEdge, defineGraph, defineNode } from "../src";
import { claimsMembers } from "../src/backend/capabilities/bind";
import { CONTRIBUTION_HEALTH } from "../src/backend/capabilities/bundle-registry";
import {
  claimsVerdict,
  createClaimsVerdictThunk,
  resolveBundle,
} from "../src/backend/capabilities/resolve";
import {
  type GraphBackend,
  type TransactionBackend,
} from "../src/backend/types";
import { storeBackend } from "../src/store/runtime-port";
import { createTestBackend } from "./test-utils";

/** Every directory the one-owner ratchet (T13(c)) scans. */
const ONE_OWNER_SCANNED_DIRECTORIES = [
  "store",
  "interchange",
  "provenance",
] as const;

/** The bare identifiers the one-owner ratchet (T13(c)) bans. */
const ONE_OWNER_BANNED_NAMES = new Set([
  "resolveBundle",
  "claimsVerdict",
  "batchPointReadVerdict",
  "uniqueSidecarBatchVerdict",
  "statementExecutionVerdict",
  "contributionHealthVerdict",
  "recordedRevisionOriginsVerdict",
]);

/**
 * The measured minting sites for the five EAGER accessors (ruling B8 spec
 * item 2 — no pilot bundle below has a `crossCheck`, so eager resolution
 * cannot throw, unlike `claims`'s thunk). Keyed on `${file}#${name}`; a name
 * with no entry for a file keeps the pre-B8 zero-tolerance ban (`resolveBundle`
 * and `claimsVerdict` have no entries at all — the allowlist adds none for
 * either). Any call beyond the pinned count — a new site, or one more call at
 * an already-listed site — is an offender, named by file and line.
 */
const ONE_OWNER_MINTING_ALLOWLIST = new Map<string, number>([
  ["store/store.ts#batchPointReadVerdict", 1],
  // The public facade constructor is also a minting boundary for legacy
  // callers that cannot supply the newly threaded optional verdict. Store
  // callers pass the verdict minted above, so each facade still resolves it
  // exactly once.
  ["store/search-facade.ts#batchPointReadVerdict", 1],
  ["store/store.ts#uniqueSidecarBatchVerdict", 1],
  ["store/store.ts#contributionHealthVerdict", 1],
  ["store/store.ts#recordedRevisionOriginsVerdict", 1],
  ["store/store.ts#statementExecutionVerdict", 1],
  ["store/recorded-capture/guards.ts#statementExecutionVerdict", 2],
  ["store/recorded-capture/guards.ts#recordedRevisionOriginsVerdict", 1],
  ["store/recorded-capture.ts#batchPointReadVerdict", 1],
  ["interchange/import.ts#batchPointReadVerdict", 1],
  ["interchange/import.ts#uniqueSidecarBatchVerdict", 1],
]);

function collectTypeScriptFiles(directory: string): readonly string[] {
  if (!fs.existsSync(directory)) return [];
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

/**
 * The called function's name, when the callee is a plain identifier —
 * `claimsVerdict(backend)`. A property-access call (`ctx.claimsVerdict()`) is
 * deliberately not this: it calls the THUNK field of that name, not the raw
 * accessor import, and must not trip this ratchet.
 */
function bareCalleeName(call: ts.CallExpression): string | undefined {
  return ts.isIdentifier(call.expression) ? call.expression.text : undefined;
}

/** One bare banned-identifier call, located for the allowlist diff below. */
type BannedCallSite = Readonly<{ file: string; name: string; line: number }>;

function scanFileForBannedCalls(
  relativeFile: string,
  source: string,
): readonly BannedCallSite[] {
  const parsed = ts.createSourceFile(
    relativeFile,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TS,
  );
  const found: BannedCallSite[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const name = bareCalleeName(node);
      if (name !== undefined && ONE_OWNER_BANNED_NAMES.has(name)) {
        const { line } = parsed.getLineAndCharacterOfPosition(
          node.expression.getStart(parsed),
        );
        found.push({ file: relativeFile, name, line: line + 1 });
      }
    }
    ts.forEachChild(node, (child) => {
      visit(child);
    });
  }
  visit(parsed);
  return found;
}

/**
 * The allowlist diff: groups every scanned call site by `${file}#${name}`,
 * keeps only the calls beyond the pinned count for that pair (all of them,
 * when the pair has no allowlist entry — the pre-B8 zero-tolerance ban), and
 * names each offender by file and line.
 */
function offendersBeyondAllowlist(
  callSites: readonly BannedCallSite[],
): readonly string[] {
  const byPair = new Map<string, BannedCallSite[]>();
  for (const site of callSites) {
    const key = `${site.file}#${site.name}`;
    const group = byPair.get(key) ?? [];
    group.push(site);
    byPair.set(key, group);
  }
  const offenders: string[] = [];
  for (const [key, sites] of byPair) {
    const allowed = ONE_OWNER_MINTING_ALLOWLIST.get(key) ?? 0;
    if (sites.length <= allowed) continue;
    for (const site of sites.slice(allowed)) {
      offenders.push(`${site.file}:${site.line} — ${site.name}(...)`);
    }
  }
  return offenders;
}

/** The claim-member function every counted getter below resolves to. */
function resolveClaimNoop(): Promise<undefined> {
  return Promise.resolve(undefined);
}

/** A resolved member function that counts how many times it was minted. */
function countedClaimMember(onCounted: () => void): () => Promise<undefined> {
  onCounted();
  return resolveClaimNoop;
}

describe("capability decision threading (T13)", () => {
  it("(a) resolveBundle refuses a TransactionBackend at the type level", () => {
    const backend = createTestBackend();
    return backend.transaction((tx: TransactionBackend) => {
      // @ts-expect-error — a transaction port is not where the support
      // question is answered (ruling B1/B-3); this directive is USED, not
      // decorative, because `tx` really is assignable to `TransactionBackend`.
      resolveBundle(tx, CONTRIBUTION_HEALTH);
      return Promise.resolve();
    });
  });

  it("(b) the verdict resolved at entry threads reference-identically into a transaction, and binds off the transaction's own members", async () => {
    const backend = createTestBackend();
    const verdict = claimsVerdict(backend);
    expect(verdict.supported).toBe(true);
    if (!verdict.supported) throw new Error("expected claims to be supported");

    await backend.transaction((tx) => {
      // What a call site that RE-RESOLVED instead of threading would hold
      // here: `resolveBundle` builds a fresh verdict object literal on
      // every call (no memoization — see `resolve.ts`), so re-resolving
      // produces a DISTINCT object even though its fields are structurally
      // identical to `verdict`. This is the failing case T13(b)'s own
      // design note names ("re-resolve inside the transaction body instead
      // of threading -> the reference check fails"), made concrete rather
      // than compared against itself.
      const reResolvedVerdict = claimsVerdict(backend);
      expect(reResolvedVerdict).not.toBe(verdict);

      // The pattern under test: the body threads the SAME verdict object
      // resolved at entry, not the freshly re-resolved one above.
      // (Mutation check: replace the line below with
      // `const threadedVerdict = reResolvedVerdict;` — RED, restored.)
      const threadedVerdict = verdict;
      expect(threadedVerdict).toBe(verdict);
      expect(threadedVerdict).not.toBe(reResolvedVerdict);
      const binding = claimsMembers(tx, threadedVerdict);
      expect(binding.claimEdgeCardinality).toBe(tx.claimEdgeCardinality);
      expect(binding.claimEdgeCardinalityBatch).toBe(
        tx.claimEdgeCardinalityBatch,
      );
      expect(binding.purgeEdgeClaims).toBe(tx.purgeEdgeClaims);
      expect(binding.hardDeleteUniquesByConcreteKind).toBe(
        tx.hardDeleteUniquesByConcreteKind,
      );
      return Promise.resolve();
    });
  });
});

describe("the claims verdict thunk (T13(c), ruling B7 refinement 2)", () => {
  it("interns: the same backend object always gets back the same thunk", () => {
    const backend = createTestBackend();
    expect(createClaimsVerdictThunk(backend)).toBe(
      createClaimsVerdictThunk(backend),
    );
  });

  it("memoizes: the thunk's own resolution is `toBe`-identical across calls", () => {
    const backend = createTestBackend();
    const thunk = createClaimsVerdictThunk(backend);
    expect(thunk()).toBe(thunk());
  });

  it("resolves the bundle AT MOST ONCE, even across a simulated write loop", () => {
    let reads = 0;
    const onCounted = (): void => {
      reads += 1;
    };
    const backend = {
      capabilities: { constraintClaims: true },
      get claimEdgeCardinality() {
        return countedClaimMember(onCounted);
      },
      get claimEdgeCardinalityBatch() {
        return countedClaimMember(onCounted);
      },
      get purgeEdgeClaims() {
        return countedClaimMember(onCounted);
      },
      get hardDeleteUniquesByConcreteKind() {
        return countedClaimMember(onCounted);
      },
    } as unknown as GraphBackend;

    const thunk = createClaimsVerdictThunk(backend);
    thunk();
    const readsAfterFirstCall = reads;
    expect(readsAfterFirstCall).toBeGreaterThan(0);

    thunk();
    // A simulated write loop: several more calls to the SAME thunk, exactly
    // as `ctx.claimsVerdict()` is called once per write-session method.
    for (let index = 0; index < 5; index += 1) thunk();

    expect(reads).toBe(readsAfterFirstCall);
  });

  it("production anchor: the store's thunk is the same object before and inside a transaction performing two claimed edge writes", async () => {
    const Person = defineNode("Person", {
      schema: z.object({ name: z.string() }),
    });
    const hasPassport = defineEdge("anchor13cHasPassport", {
      schema: z.object({}),
    });
    const graph = defineGraph({
      id: "capability-decision-threading-t13c",
      nodes: { Person: { type: Person } },
      edges: {
        hasPassport: {
          type: hasPassport,
          from: [Person],
          to: [Person],
          cardinality: "one",
        },
      },
    });
    const store = createStore(graph, createTestBackend());
    const thunkBeforeTransaction = createClaimsVerdictThunk(
      storeBackend(store),
    );

    await store.transaction(async (tx) => {
      const thunkInsideTransaction = createClaimsVerdictThunk(
        storeBackend(store),
      );
      expect(thunkInsideTransaction).toBe(thunkBeforeTransaction);

      // Two claimed edge writes, on two different `from` nodes so neither
      // claim contends with the other. Through `tx`, not `store`: a
      // top-level store call from inside this callback would deadlock the
      // single SQLite connection the transaction already holds.
      const alice = await tx.nodes.Person.create({ name: "Alice" });
      const bob = await tx.nodes.Person.create({ name: "Bob" });
      const carol = await tx.nodes.Person.create({ name: "Carol" });
      const dave = await tx.nodes.Person.create({ name: "Dave" });
      await tx.edges.hasPassport.create(alice, bob, {});
      await tx.edges.hasPassport.create(carol, dave, {});
    });
  });

  it("one-owner ratchet: the six named verdict accessors are never called, as bare identifiers, beyond the pinned minting sites under src/store/**, src/interchange/** or src/provenance/**", () => {
    const sourceRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../src",
    );
    const callSites = ONE_OWNER_SCANNED_DIRECTORIES.flatMap((directory) =>
      collectTypeScriptFiles(path.join(sourceRoot, directory)).flatMap((file) =>
        scanFileForBannedCalls(
          path.relative(sourceRoot, file).replaceAll(path.sep, "/"),
          fs.readFileSync(file, "utf8"),
        ),
      ),
    );

    expect(offendersBeyondAllowlist(callSites)).toEqual([]);
  });
});
