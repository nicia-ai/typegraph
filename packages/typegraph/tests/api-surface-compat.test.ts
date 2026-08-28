import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The real package directory (has node_modules, so `--import tsx` resolves);
// fixtures are separate throwaway git repos the checker is pointed at via
// `--package-dir`.
const REAL_PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const REPORT_FILE_NAME = "typegraph-fixture.api.md";

const BASE_BODY = `
// @public
export function createFixtureBackend(capabilities: FixtureCapabilities): FixtureResult;

// @public
export type FixtureCapabilities = Readonly<{
    execution: Readonly<{
        interactiveTransactions: boolean;
        atomicBatch: "none" | "root";
    }>;
    internal?: FixtureInternalOptions;
    mandatory: FixtureMandatoryOptions;
}>;

// @public (undocumented)
type FixtureInternalOptions = Readonly<{
    retries: number;
}>;

// @public (undocumented)
type FixtureMandatoryOptions = Readonly<{
    retries: number;
}>;

// @public
export type FixtureResult = Readonly<{
    ok: boolean;
    detail?: string;
}>;

// @public
export function createFixtureStore(name: string, options: Readonly<{
    timeout: number;
}>): FixtureResult;

// @public
export interface FixtureQueryBuilder {
    from(kind: string, options: Readonly<{
        timeout: number;
    }>): FixtureQueryBuilder;
}
`;

const HEAD_REQUIRED_MEMBER_ADDED = BASE_BODY.replace(
  "    mandatory: FixtureMandatoryOptions;\n}>;",
  "    mandatory: FixtureMandatoryOptions;\n    recursiveTraversal: boolean;\n}>;",
);

const HEAD_OPTIONAL_MEMBER_WITH_REQUIRED_CHILD = BASE_BODY.replace(
  "    mandatory: FixtureMandatoryOptions;\n}>;",
  "    mandatory: FixtureMandatoryOptions;\n    recursiveTraversal?: Readonly<{\n        mode: string;\n    }>;\n}>;",
);

// The scenario the checker was actually shipped to close (§5.4): a brand-new
// NAMED (not inline) type, reached only through an optional field on an
// EXISTING contravariant declaration. Neither the field (`advanced`) nor the
// referenced type (`FixtureAdvancedCapability`) exists at the base ref, and
// `mode` is required on that new type — this must still pass, because no
// existing external caller of `createFixtureBackend` is forced to supply
// `advanced` at all.
const HEAD_OPTIONAL_NAMED_TYPE_WITH_REQUIRED_CHILD = BASE_BODY.replace(
  "    mandatory: FixtureMandatoryOptions;\n}>;",
  "    mandatory: FixtureMandatoryOptions;\n    advanced?: FixtureAdvancedCapability;\n}>;",
).replace(
  "type FixtureMandatoryOptions = Readonly<{\n    retries: number;\n}>;",
  "type FixtureMandatoryOptions = Readonly<{\n    retries: number;\n}>;\n\n// @public (undocumented)\ntype FixtureAdvancedCapability = Readonly<{\n    mode: string;\n}>;",
);

// The regression guard for the fix above: swapping an EXISTING mandatory
// field's value type for a brand-new, differently-shaped type must still
// fail — `mandatory` was already required on `FixtureCapabilities` at the
// base ref, and `createFixtureBackend` (the function that makes
// `FixtureCapabilities` contravariant at all) already existed there too, so
// this is not the "nothing forces an existing caller" case above.
const HEAD_MANDATORY_FIELD_RETYPED_TO_NEW_REQUIRED_SHAPE = BASE_BODY.replace(
  "    mandatory: FixtureMandatoryOptions;\n}>;",
  "    mandatory: FixtureMandatoryOptionsV2;\n}>;",
).replace(
  "type FixtureMandatoryOptions = Readonly<{\n    retries: number;\n}>;",
  "type FixtureMandatoryOptions = Readonly<{\n    retries: number;\n}>;\n\n// @public (undocumented)\ntype FixtureMandatoryOptionsV2 = Readonly<{\n    retries: number;\n    forceSync: boolean;\n}>;",
);

// The other half of the base-ref scenario §5.4 was written for: a brand-new
// exported FUNCTION whose mandatory parameter references a brand-new named
// type. No existing caller invokes a function that did not exist at the
// base ref, so this must pass too, even though the parameter itself is
// required.
const HEAD_NEW_FUNCTION_WITH_NEW_MANDATORY_PARAMETER_TYPE =
  BASE_BODY +
  `
// @public
export function assumeFixtureAdvancedSupported(verdict: FixtureAdvancedVerdict): void;

// @public (undocumented)
type FixtureAdvancedVerdict = Readonly<{
    supported: boolean;
}>;
`;

// NEW finding: `collectInlineLiteralEntries` hard-failed on EVERY inline
// parameter literal unconditionally, never gating on whether the owning
// function itself was brand new. A brand-new top-level function's inline
// options literal must pass — no existing caller can invoke a function that
// did not exist at the base ref, mirroring (b4)'s named-type case.
const HEAD_NEW_FUNCTION_WITH_NEW_INLINE_LITERAL_PARAMETER =
  BASE_BODY +
  `
// @public
export function createFixtureAdapter(options: Readonly<{
    supported: boolean;
}>): FixtureResult;
`;

// The other reproduction the same finding names: a brand-new INTERFACE with
// a brand-new method taking an inline parameter literal. Neither the
// interface, the method, nor the parameter existed at the base ref, so no
// existing implementer of the interface (there is none — the interface
// itself is new) or caller of the method is broken.
const HEAD_NEW_INTERFACE_WITH_INLINE_LITERAL_PARAMETER =
  BASE_BODY +
  `
// @public
export interface FixtureIndexBuilder {
    withOptions(options: Readonly<{
        parallelism: number;
    }>): FixtureIndexBuilder;
}
`;

// The finding's third axis: an EXISTING function gaining a brand-new
// OPTIONAL inline-literal parameter. `createFixtureStore` already existed at
// base, but no existing caller supplied `extra` (it didn't exist), and no
// existing caller is forced to supply it now either (it's optional) — so a
// required field inside it must still not hard-fail.
const HEAD_EXISTING_FUNCTION_NEW_OPTIONAL_INLINE_PARAMETER = BASE_BODY.replace(
  "export function createFixtureStore(name: string, options: Readonly<{\n    timeout: number;\n}>): FixtureResult;",
  "export function createFixtureStore(name: string, options: Readonly<{\n    timeout: number;\n}>, extra?: Readonly<{\n    parallelism: number;\n}>): FixtureResult;",
);

// Discovered while fixing the above: `computeContravariantNames`' interface
// method walk never gated on callable newness at all (only the top-level
// function walk did) — so this identical false positive existed for NAMED
// (not just inline-literal) parameters reached through a brand-new
// interface method. Same fix (the shared `existingCallableKeys`), same
// class of bug, now covered on the named-type side too.
const HEAD_NEW_INTERFACE_WITH_NAMED_TYPE_PARAMETER =
  BASE_BODY +
  `
// @public
export interface FixtureRangeBuilder {
    between(bounds: FixtureRangeBounds): FixtureRangeBuilder;
}

// @public (undocumented)
type FixtureRangeBounds = Readonly<{
    upper: number;
}>;
`;

const HEAD_RETURN_ONLY_REQUIRED_MEMBER = BASE_BODY.replace(
  "    ok: boolean;\n    detail?: string;\n}>;",
  "    ok: boolean;\n    detail?: string;\n    extra: boolean;\n}>;",
);

const HEAD_INLINE_PARAMETER_REQUIRED_MEMBER = BASE_BODY.replace(
  "export function createFixtureStore(name: string, options: Readonly<{\n    timeout: number;\n}>): FixtureResult;",
  "export function createFixtureStore(name: string, options: Readonly<{\n    timeout: number;\n    retryLimit: number;\n}>): FixtureResult;",
);

// Finding 1/2's gap: an inline parameter object literal on an INTERFACE
// method, not a top-level function. Before the fix, nothing ever inventoried
// `FixtureQueryBuilder.from`'s `options` parameter, so this passed vacuously
// regardless of what changed inside it.
const HEAD_INTERFACE_METHOD_INLINE_PARAMETER_REQUIRED_MEMBER =
  BASE_BODY.replace(
    "    from(kind: string, options: Readonly<{\n        timeout: number;\n    }>): FixtureQueryBuilder;",
    "    from(kind: string, options: Readonly<{\n        timeout: number;\n        includeSubClasses: boolean;\n    }>): FixtureQueryBuilder;",
  );

// Regression guard for the interface/class-method gating added alongside
// the fix above: unlike (b3) (which guards the top-level-function-rooted
// case), this base ALREADY has an interface method taking a named-type
// parameter, so retyping that parameter to a new, differently-shaped
// required type must still fail — the method is not new here.
const BASE_WITH_RANGE_BUILDER =
  BASE_BODY +
  `
// @public
export interface FixtureRangeBuilder {
    between(bounds: FixtureRangeBounds): FixtureRangeBuilder;
}

// @public (undocumented)
type FixtureRangeBounds = Readonly<{
    upper: number;
}>;
`;

const HEAD_RANGE_BUILDER_RETYPED = BASE_WITH_RANGE_BUILDER.replace(
  "    between(bounds: FixtureRangeBounds): FixtureRangeBuilder;",
  "    between(bounds: FixtureRangeBoundsV2): FixtureRangeBuilder;",
).replace(
  "type FixtureRangeBounds = Readonly<{\n    upper: number;\n}>;",
  "type FixtureRangeBounds = Readonly<{\n    upper: number;\n}>;\n\n// @public (undocumented)\ntype FixtureRangeBoundsV2 = Readonly<{\n    upper: number;\n    lower: number;\n}>;",
);

// Finding 9's gap: `computeContravariantNames`' `walkClassMembers` skipped
// every class constructor outright (`if (ts.isConstructorDeclaration(member))
// continue;`), so a NAMED-type parameter reachable only through a
// constructor was never walked at all — not gated, not hard-contravariant,
// regardless of newness or optionality. Mirrors (d6)'s brand-new-callable
// case, on the class-constructor path instead of the interface-method path.
const HEAD_NEW_CLASS_WITH_CONSTRUCTOR_NAMED_TYPE_PARAMETER =
  BASE_BODY +
  `
// @public
export class FixtureRecordWriter {
    constructor(config: FixtureWriterConfig);
}

// @public (undocumented)
type FixtureWriterConfig = Readonly<{
    batchSize: number;
}>;
`;

// Regression guard for the fix above: unlike the brand-new case, this base
// ALREADY has a class with a constructor taking a named-type parameter, so
// retyping that parameter to a new, differently-shaped required type must
// still fail — the constructor is not new here.
const BASE_WITH_RECORD_WRITER =
  BASE_BODY +
  `
// @public
export class FixtureRecordWriter {
    constructor(config: FixtureWriterConfig);
}

// @public (undocumented)
type FixtureWriterConfig = Readonly<{
    batchSize: number;
}>;
`;

const HEAD_RECORD_WRITER_CONFIG_RETYPED = BASE_WITH_RECORD_WRITER.replace(
  "    constructor(config: FixtureWriterConfig);",
  "    constructor(config: FixtureWriterConfigV2);",
).replace(
  "type FixtureWriterConfig = Readonly<{\n    batchSize: number;\n}>;",
  "type FixtureWriterConfig = Readonly<{\n    batchSize: number;\n}>;\n\n// @public (undocumented)\ntype FixtureWriterConfigV2 = Readonly<{\n    batchSize: number;\n    flushIntervalMs: number;\n}>;",
);

// Finding 8's coverage gap: T18 had no `export class` fixture at all, so the
// class-METHOD half of `walkClassMembers`'s `calleeExisted` gating (as
// opposed to the interface-method half already covered by d6/d7) was
// exercised only by hand, never by a named test. Mirrors (d6)/(d7) exactly,
// with a class method in place of an interface method.
const HEAD_NEW_CLASS_WITH_METHOD_NAMED_TYPE_PARAMETER =
  BASE_BODY +
  `
// @public
export class FixtureRecordLocator {
    locate(query: FixtureLocateQuery): FixtureRecordLocator;
}

// @public (undocumented)
type FixtureLocateQuery = Readonly<{
    key: string;
}>;
`;

const BASE_WITH_RECORD_LOCATOR =
  BASE_BODY +
  `
// @public
export class FixtureRecordLocator {
    locate(query: FixtureLocateQuery): FixtureRecordLocator;
}

// @public (undocumented)
type FixtureLocateQuery = Readonly<{
    key: string;
}>;
`;

const HEAD_RECORD_LOCATOR_QUERY_RETYPED = BASE_WITH_RECORD_LOCATOR.replace(
  "    locate(query: FixtureLocateQuery): FixtureRecordLocator;",
  "    locate(query: FixtureLocateQueryV2): FixtureRecordLocator;",
).replace(
  "type FixtureLocateQuery = Readonly<{\n    key: string;\n}>;",
  "type FixtureLocateQuery = Readonly<{\n    key: string;\n}>;\n\n// @public (undocumented)\ntype FixtureLocateQueryV2 = Readonly<{\n    key: string;\n    namespace: string;\n}>;",
);

const HEAD_UNEXPORTED_REQUIRED_MEMBER = BASE_BODY.replace(
  "type FixtureMandatoryOptions = Readonly<{\n    retries: number;\n}>;",
  "type FixtureMandatoryOptions = Readonly<{\n    retries: number;\n    forceSync: boolean;\n}>;",
);

const HEAD_MEMBER_REMOVED = BASE_BODY.replace(
  "    ok: boolean;\n    detail?: string;\n}>;",
  "    ok: boolean;\n}>;",
);

const HEAD_OPTIONALITY_TIGHTENED = BASE_BODY.replace(
  "    internal?: FixtureInternalOptions;",
  "    internal: FixtureInternalOptions;",
);

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initGitRepo(fixtureDirectory: string): void {
  runGit(fixtureDirectory, ["init"]);
  runGit(fixtureDirectory, ["config", "user.name", "API Surface Fixture"]);
  runGit(fixtureDirectory, [
    "config",
    "user.email",
    "api-surface-fixture@example.com",
  ]);
}

function writeFixtureFile(
  fixtureDirectory: string,
  relativePath: string,
  content: string,
): void {
  const absolutePath = path.join(fixtureDirectory, relativePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function wrapApiReportBody(tsBody: string): string {
  return [
    '## API Report File for "@nicia-ai/typegraph-fixture"',
    "",
    "> Do not edit this file. It is a report generated by [API Extractor](https://api-extractor.com/).",
    "",
    "```ts",
    tsBody,
    "// (No @packageDocumentation comment for this package)",
    "",
    "```",
    "",
  ].join("\n");
}

function writeFixtureReport(fixtureDirectory: string, tsBody: string): void {
  writeFixtureFile(
    fixtureDirectory,
    `packages/typegraph/etc/${REPORT_FILE_NAME}`,
    wrapApiReportBody(tsBody),
  );
}

function writeLedger(fixtureDirectory: string, content: string): void {
  writeFixtureFile(
    fixtureDirectory,
    "packages/typegraph/etc/api-surface-exceptions.json",
    content,
  );
}

function commitFixture(fixtureDirectory: string, message: string): string {
  runGit(fixtureDirectory, ["add", "."]);
  runGit(fixtureDirectory, ["commit", "-m", message]);
  return runGit(fixtureDirectory, ["rev-parse", "HEAD"]);
}

function tagFixture(fixtureDirectory: string, tagName: string): void {
  runGit(fixtureDirectory, ["tag", tagName, "HEAD"]);
}

/** The common two-state setup: a tagged base commit, ready for the caller to overwrite the working tree with a head variant. */
function setupTaggedBaseFixture(fixtureDirectory: string): void {
  initGitRepo(fixtureDirectory);
  writeFixtureReport(fixtureDirectory, BASE_BODY);
  writeLedger(fixtureDirectory, "[]\n");
  commitFixture(fixtureDirectory, "base fixture");
  tagFixture(fixtureDirectory, "@nicia-ai/typegraph@0.10.0");
}

type RunResult = Readonly<{
  status: number | null;
  stdout: string;
  stderr: string;
}>;

function runChecker(
  fixturePackageDir: string,
  envOverrides: Readonly<Record<string, string>> = {},
): RunResult {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/api-surface-compat.ts",
      "--package-dir",
      fixturePackageDir,
    ],
    {
      cwd: REAL_PACKAGE_DIR,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        // Neutralize any ambient CI pull-request context so the
        // merge-base leg only activates when a test opts in.
        GITHUB_EVENT_NAME: "",
        GITHUB_BASE_REF: "",
        ...envOverrides,
      },
    },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe("api-surface-compat", () => {
  let fixtureDirectory: string;
  let fixturePackageDir: string;

  beforeEach(() => {
    fixtureDirectory = mkdtempSync(
      path.join(tmpdir(), "typegraph-api-surface-"),
    );
    fixturePackageDir = path.join(fixtureDirectory, "packages/typegraph");
  });

  afterEach(() => {
    rmSync(fixtureDirectory, { force: true, recursive: true });
  });

  it("(a) fails on a required member added to a contravariantly reachable type", () => {
    // An earlier, lexically-larger tag (0.9.0) already contains the head
    // member — a lexical sort would pick it and pass vacuously. The
    // correctly-ordered base (0.10.0) does not, so the real check must fail.
    initGitRepo(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, HEAD_REQUIRED_MEMBER_ADDED);
    writeLedger(fixtureDirectory, "[]\n");
    commitFixture(fixtureDirectory, "stale future snapshot");
    tagFixture(fixtureDirectory, "@nicia-ai/typegraph@0.9.0");

    writeFixtureReport(fixtureDirectory, BASE_BODY);
    commitFixture(fixtureDirectory, "true base");
    tagFixture(fixtureDirectory, "@nicia-ai/typegraph@0.10.0");

    writeFixtureReport(fixtureDirectory, HEAD_REQUIRED_MEMBER_ADDED);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "FixtureCapabilities gained REQUIRED member `recursiveTraversal`",
    );
  }, 30_000);

  it("(b) passes when the added member is optional, including required children of an optional parent", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_OPTIONAL_MEMBER_WITH_REQUIRED_CHILD,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).not.toContain("gained REQUIRED");
  }, 30_000);

  it("(b2) passes when a required child belongs to a brand-new, separately-declared type reached only through an optional field (not just an inline literal)", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_OPTIONAL_NAMED_TYPE_WITH_REQUIRED_CHILD,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).toContain(
      "FixtureAdvancedCapability gained REQUIRED member `mode` in a return-only position",
    );
  }, 30_000);

  it("(b3) still fails when an EXISTING mandatory field's value type is swapped for a brand-new, differently-shaped type (regression guard for b2)", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_MANDATORY_FIELD_RETYPED_TO_NEW_REQUIRED_SHAPE,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "FixtureMandatoryOptionsV2 gained REQUIRED member `forceSync`",
    );
  }, 30_000);

  it("(b4) passes when a brand-new function's mandatory parameter references a brand-new named type with a required member", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_NEW_FUNCTION_WITH_NEW_MANDATORY_PARAMETER_TYPE,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).toContain(
      "FixtureAdvancedVerdict gained REQUIRED member `supported` in a return-only position",
    );
  }, 30_000);

  it("(c) reports rather than fails a required member on a return-only type", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, HEAD_RETURN_ONLY_REQUIRED_MEMBER);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("report:");
    expect(result.stdout).toContain("return-only position");
  }, 30_000);

  it("(d) fails on a required member added inside an inline parameter object literal", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, HEAD_INLINE_PARAMETER_REQUIRED_MEMBER);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("createFixtureStore(options)");
  }, 30_000);

  it("(d2) fails on a required member added inside an INTERFACE METHOD's inline parameter object literal (finding: methods were never inventoried)", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_INTERFACE_METHOD_INLINE_PARAMETER_REQUIRED_MEMBER,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FixtureQueryBuilder.from(options)");
    expect(result.stderr).toContain("includeSubClasses");
  }, 30_000);

  it("(d3) passes (reports) when a brand-new top-level function's inline parameter literal carries a required member (finding: collectInlineLiteralEntries hard-failed unconditionally)", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_NEW_FUNCTION_WITH_NEW_INLINE_LITERAL_PARAMETER,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).toContain(
      "createFixtureAdapter(options) gained REQUIRED member `supported` in a return-only position",
    );
  }, 30_000);

  it("(d4) passes (reports) when a brand-new interface's brand-new method carries an inline parameter literal with a required member", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_NEW_INTERFACE_WITH_INLINE_LITERAL_PARAMETER,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).toContain(
      "FixtureIndexBuilder.withOptions(options) gained REQUIRED member `parallelism` in a return-only position",
    );
  }, 30_000);

  it("(d5) passes (reports) when an EXISTING function gains a brand-new OPTIONAL inline parameter literal with a required member", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_EXISTING_FUNCTION_NEW_OPTIONAL_INLINE_PARAMETER,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).toContain(
      "createFixtureStore(extra) gained REQUIRED member `parallelism` in a return-only position",
    );
  }, 30_000);

  it("(d6) passes (reports) when a brand-new interface's brand-new method carries a NAMED-type parameter with a required member (same class of bug as d3/d4, on the named-type path)", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_NEW_INTERFACE_WITH_NAMED_TYPE_PARAMETER,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).toContain(
      "FixtureRangeBounds gained REQUIRED member `upper` in a return-only position",
    );
  }, 30_000);

  it("(d7) still fails when an EXISTING interface method's EXISTING mandatory named-type parameter is retyped to a new, differently-shaped required type (regression guard for d6)", () => {
    initGitRepo(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, BASE_WITH_RANGE_BUILDER);
    writeLedger(fixtureDirectory, "[]\n");
    commitFixture(fixtureDirectory, "base with range builder");
    tagFixture(fixtureDirectory, "@nicia-ai/typegraph@0.10.0");

    writeFixtureReport(fixtureDirectory, HEAD_RANGE_BUILDER_RETYPED);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "FixtureRangeBoundsV2 gained REQUIRED member `lower`",
    );
  }, 30_000);

  it("(d8) passes (reports) when a brand-new class's brand-new constructor carries a NAMED-type parameter with a required member (finding 9: walkClassMembers skipped every constructor outright)", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_NEW_CLASS_WITH_CONSTRUCTOR_NAMED_TYPE_PARAMETER,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).toContain(
      "FixtureWriterConfig gained REQUIRED member `batchSize` in a return-only position",
    );
  }, 30_000);

  it("(d9) still fails when an EXISTING class's EXISTING mandatory constructor named-type parameter is retyped to a new, differently-shaped required type (regression guard for d8)", () => {
    initGitRepo(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, BASE_WITH_RECORD_WRITER);
    writeLedger(fixtureDirectory, "[]\n");
    commitFixture(fixtureDirectory, "base with record writer");
    tagFixture(fixtureDirectory, "@nicia-ai/typegraph@0.10.0");

    writeFixtureReport(fixtureDirectory, HEAD_RECORD_WRITER_CONFIG_RETYPED);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "FixtureWriterConfigV2 gained REQUIRED member `flushIntervalMs`",
    );
  }, 30_000);

  it("(d10) passes (reports) when a brand-new class's brand-new method carries a NAMED-type parameter with a required member (finding 8: T18 had no class-method coverage at all)", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(
      fixtureDirectory,
      HEAD_NEW_CLASS_WITH_METHOD_NAMED_TYPE_PARAMETER,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("gained REQUIRED");
    expect(result.stdout).toContain(
      "FixtureLocateQuery gained REQUIRED member `key` in a return-only position",
    );
  }, 30_000);

  it("(d11) still fails when an EXISTING class's EXISTING mandatory method named-type parameter is retyped to a new, differently-shaped required type (regression guard for d10)", () => {
    initGitRepo(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, BASE_WITH_RECORD_LOCATOR);
    writeLedger(fixtureDirectory, "[]\n");
    commitFixture(fixtureDirectory, "base with record locator");
    tagFixture(fixtureDirectory, "@nicia-ai/typegraph@0.10.0");

    writeFixtureReport(fixtureDirectory, HEAD_RECORD_LOCATOR_QUERY_RETYPED);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "FixtureLocateQueryV2 gained REQUIRED member `namespace`",
    );
  }, 30_000);

  it("(e) fails on a required member added to an unexported but rendered declaration reached through a mandatory field", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, HEAD_UNEXPORTED_REQUIRED_MEMBER);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FixtureMandatoryOptions");
  }, 30_000);

  it("(f) fails when a member is removed from a return-only type", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, HEAD_MEMBER_REMOVED);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("lost member");
  }, 30_000);

  it("(g) fails when an optional member is made required", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, HEAD_OPTIONALITY_TIGHTENED);

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("tightened member");
    expect(result.stderr).toContain("from optional to REQUIRED");
  }, 30_000);

  it("(h) refuses with a fetch remediation when no tag resolves", () => {
    initGitRepo(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, BASE_BODY);
    writeLedger(fixtureDirectory, "[]\n");
    commitFixture(fixtureDirectory, "no tags at all");

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("no tag matches");
    expect(result.stderr).toContain("git fetch --no-tags --depth=1 origin");
  }, 30_000);

  it("(i) downgrades a failure covered by a ledger entry", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, HEAD_REQUIRED_MEMBER_ADDED);
    writeLedger(
      fixtureDirectory,
      `${JSON.stringify(
        [
          {
            entrypoint: REPORT_FILE_NAME,
            declaration: "FixtureCapabilities",
            member: "recursiveTraversal",
            kind: "required-member-added",
            reason: "shimmed optional-at-the-boundary during the pilot rollout",
            issue: "#1234",
            refusal: "RECURSIVE_TRAVERSAL_UNRESOLVED",
          },
        ],
        undefined,
        2,
      )}\n`,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("exempted:");
  }, 30_000);

  it("(i2) refuses a stale ledger entry after the base catches up", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    writeLedger(
      fixtureDirectory,
      `${JSON.stringify([
        {
          entrypoint: REPORT_FILE_NAME,
          declaration: "FixtureCapabilities",
          member: "transactions",
          kind: "required-member-added",
          reason: "historical rollout exception",
          issue: "#1234",
        },
      ])}\n`,
    );

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "No matching breaking base-to-head API-surface finding exists",
    );
  }, 30_000);

  it("(i3) refuses removal of a published entrypoint report", () => {
    setupTaggedBaseFixture(fixtureDirectory);
    rmSync(path.join(fixturePackageDir, "etc", REPORT_FILE_NAME));

    const result = runChecker(fixturePackageDir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Head is missing API report snapshot");
    expect(result.stderr).toContain(REPORT_FILE_NAME);
  }, 30_000);

  it("(j) reports the merge-base diff on the pull-request leg without failing", () => {
    initGitRepo(fixtureDirectory);
    writeFixtureReport(fixtureDirectory, BASE_BODY);
    writeLedger(fixtureDirectory, "[]\n");
    const earlierSha = commitFixture(fixtureDirectory, "origin/main baseline");
    runGit(fixtureDirectory, [
      "update-ref",
      "refs/remotes/origin/main",
      earlierSha,
    ]);

    // The published tag (and the head working tree) already contain the
    // member, so the primary tag-based comparison is clean; only the
    // merge-base leg (against the older origin/main ref) sees the change.
    writeFixtureReport(fixtureDirectory, HEAD_REQUIRED_MEMBER_ADDED);
    commitFixture(fixtureDirectory, "publish with recursiveTraversal");
    tagFixture(fixtureDirectory, "@nicia-ai/typegraph@0.10.0");

    const result = runChecker(fixturePackageDir, {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_BASE_REF: "main",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("merge-base report:");
  }, 30_000);
});
