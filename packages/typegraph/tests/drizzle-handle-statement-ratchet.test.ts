/**
 * THE RATCHET for statements a backend composes on its Drizzle handle.
 *
 * A backend's execution adapter admits its statements through the
 * transaction's view (`src/backend/drizzle/execution/transaction-view.ts`),
 * so a backend kept past its transaction's end is refused instead of writing
 * outside it. A member that calls Drizzle on the handle itself
 * (`db.insert(...)`, `db.select(...)`, `db.execute(...)`, `db.run(...)`,
 * `db.transaction(...)`) skips that admission unless it goes through
 * `runHandleStatement` (`src/backend/drizzle/execution/handle-statement.ts`).
 *
 * The invariant: every call in `src/backend` to a method Drizzle declares on
 * a database or transaction class is either inside a callback handed to
 * `runHandleStatement`, or listed in {@link UNADMITTED_HANDLE_CALLS} with why
 * it may bypass the view and how many such calls the site carries (multiset
 * EQUALITY, both directions: a new bare call fails, and a call that was
 * routed or removed must be delisted).
 *
 * The method is resolved with the type checker, so a handle under any name
 * (`db`, `tx`, `session`, `current().db`) is seen, and a method of another
 * object that happens to be called `execute` is not.
 */
import path from "node:path";

import ts from "typescript";
import { beforeAll, describe, expect, it } from "vitest";

import {
  createScanProgram,
  PACKAGE_ROOT,
  type ScanProgram,
} from "./helpers/operation-scope-scan";

const BACKEND_ROOT = path.join(PACKAGE_ROOT, "src", "backend");
const ADMISSION_MODULE = path.join(
  BACKEND_ROOT,
  "drizzle",
  "execution",
  "handle-statement.ts",
);
const ADMISSION_FUNCTION = "runHandleStatement";

/** Why a call on a Drizzle handle may bypass the transaction's view. */
type Bypass =
  /** The execution adapter itself: what admission wraps. */
  | "execution-adapter"
  /** The call opens a transaction (a savepoint on a transaction's handle). */
  | "transaction-opener"
  /** Runs on the transaction a call of the same function opened and awaits. */
  | "frame-statement"
  /** Runs on a caller's own transaction handed to the call, not this backend's handle. */
  | "caller-session"
  /** Reached only on a root backend: the transaction-scoped branch refuses or diverts first. */
  | "root-only";

type Allowance = Readonly<{
  bypass: Bypass;
  reason: string;
  /** Calls under this key; 1 when omitted. */
  sites?: number;
}>;

/**
 * Every call on a Drizzle handle in `src/backend` outside a
 * `runHandleStatement` callback, by `file#function#receiver.method` (the
 * nearest enclosing named function, method, property or variable).
 */
const UNADMITTED_HANDLE_CALLS: Readonly<Record<string, Allowance>> = {
  // --- the execution adapters ---------------------------------------------
  "drizzle/execution/postgres-execution.ts#executeDrizzleQuery#db.execute": {
    bypass: "execution-adapter",
    reason:
      "The PostgreSQL adapter's own statement path: a view or queue wraps the adapter, not this call.",
  },
  "drizzle/execution/postgres-execution.ts#executeInteractiveAtomicBatch#db.transaction":
    {
      bypass: "execution-adapter",
      reason:
        "The pooled adapter's atomic batch, which opens a transaction of its own: never built over a transaction handle (`canOpenInteractiveAtomicBatch` requires a database kind and no transaction client).",
    },
  "drizzle/execution/postgres-transaction-session.ts#enterDriverScope#current().db.transaction":
    {
      bypass: "execution-adapter",
      reason:
        "The pinned session's driver-scope savepoint, entered by the execution layer around work the queue already admitted.",
    },
  "drizzle/execution/sqlite-execution.ts#detectSyncProfile#db.get": {
    bypass: "execution-adapter",
    reason:
      "The construction-time sync probe: runs once while the adapter is built, before any transaction binds it.",
  },
  "drizzle/execution/sqlite-execution.ts#executeDrizzleQuery#db.all": {
    bypass: "execution-adapter",
    reason:
      "The SQLite adapter's own row path: the transaction view wraps the adapter, not this call.",
  },
  "drizzle/execution/sqlite-execution.ts#executeRun#db.run": {
    bypass: "execution-adapter",
    reason:
      "The SQLite adapter's own row-less path: the transaction view wraps the adapter, not this call.",
  },
  // --- transaction openers ------------------------------------------------
  "drizzle/postgres.ts#runDdlStatement#db.transaction": {
    bypass: "root-only",
    reason:
      "The allocation search-path pin's transaction: the transaction-handle branch returns before it.",
  },
  "drizzle/postgres.ts#openCommittingTransaction#db.transaction": {
    bypass: "transaction-opener",
    reason:
      "Opens the transaction `transaction()` and schema writes run in. On a transaction's handle it is a savepoint whose body admits through the shared statement queue, so admitting the opener would hold the queue slot its body waits for; an empty admission settled before it refuses the opener once the enclosing transaction ended. A savepoint that outlives its enclosing transaction is a pinned known limit (tests/backends/integration/transaction-view-consumers.ts).",
    sites: 2,
  },
  "drizzle/postgres.ts#runVectorSearch#db.transaction": {
    bypass: "root-only",
    reason:
      "The root search's GUC transaction: a transaction-scoped backend runs the GUC group through `runExclusive` instead.",
  },
  "drizzle/sqlite.ts#openTransaction#db.transaction": {
    bypass: "transaction-opener",
    reason:
      "Opens the transaction `transaction()` runs in through Drizzle; its body admits through the view the opened transaction's owner closes. On a transaction's handle (a libSQL transaction under Drizzle's transaction mode) it is a savepoint, refused at entry once the enclosing transaction ended by an empty admission through the handle's view; under the SQL mode the nested `BEGIN IMMEDIATE` fails.",
  },
  "drizzle/sqlite.ts#runSchemaWriteTransaction#db.transaction": {
    bypass: "transaction-opener",
    reason:
      "Opens a schema write's transaction through Drizzle; its body admits through the view the opened transaction's owner closes. As `openTransaction` on a libSQL transaction's handle.",
  },
  // --- statements on a transaction the same call opened -------------------
  "drizzle/postgres.ts#runDdlStatement#transaction.execute": {
    bypass: "frame-statement",
    reason:
      "Inside the root-only allocation pin transaction above, awaited before it ends.",
    sites: 2,
  },
  "drizzle/postgres.ts#bindSchemaWriteSessionToAllocation#tx.execute": {
    bypass: "frame-statement",
    reason:
      "Pins the search path of the schema write's own transaction; a transaction-handle backend checks instead and returns first.",
  },
  "drizzle/postgres.ts#acquireSchemaWriteFence#tx.execute": {
    bypass: "frame-statement",
    reason:
      "The schema-commit fence taken on the schema write's own transaction, awaited before its body runs.",
    sites: 3,
  },
  "drizzle/sqlite.ts#runFrameStatement#db.run": {
    bypass: "frame-statement",
    reason:
      "BEGIN / COMMIT / ROLLBACK of the transaction the runner opens: the frame the view's owner closes around, never a statement of a bind.",
  },
  // --- a caller's own transaction ----------------------------------------
  "drizzle/postgres.ts#readBaseSchemaVersion#callerSession.select": {
    bypass: "caller-session",
    reason:
      "Schema-write adoption reads the base-schema marker on the caller's transaction it was handed.",
  },
  "drizzle/postgres.ts#executeControl#externalTx.execute": {
    bypass: "caller-session",
    reason:
      "Schema-write adoption's probe savepoint on the caller's transaction it was handed.",
  },
  "drizzle/postgres.ts#restoreCallerLockTimeout#externalTx.execute": {
    bypass: "caller-session",
    reason:
      "Restores the caller's own `lock_timeout` on the caller's transaction it was handed.",
  },
  "drizzle/postgres.ts#adoptSchemaWriteTransaction#externalTx.execute": {
    bypass: "caller-session",
    reason:
      "Sets the fence wait's `lock_timeout` on the caller's transaction it was handed.",
  },
  "drizzle/sqlite.ts#readBaseSchemaVersion#callerSession.select": {
    bypass: "caller-session",
    reason:
      "Schema-write adoption reads the base-schema marker on the caller's transaction it was handed.",
  },
  "drizzle/sqlite.ts#adoptSchemaWriteTransaction#externalTx.all": {
    bypass: "caller-session",
    reason:
      "Schema-write adoption's checks on the caller's transaction it was handed.",
  },
  "drizzle/sqlite.ts#adoptSchemaWriteTransaction#externalTx.run": {
    bypass: "caller-session",
    reason:
      "Schema-write adoption's writes on the caller's transaction it was handed.",
    sites: 2,
  },
  // --- root-only ----------------------------------------------------------
  "drizzle/postgres.ts#executeRawDdl#db.execute": {
    bypass: "root-only",
    reason:
      "Reached without an adapter only from `catalog.dropInvalidIndex`, which a transaction-scoped catalog refuses first.",
  },
};

type HandleCall = Readonly<{
  key: string;
  admitted: boolean;
  line: number;
}>;

/** Whether `node` is a function expression, named or arrow. */
function isFunctionValue(node: ts.Node | undefined): boolean {
  return (
    node !== undefined &&
    (ts.isArrowFunction(node) || ts.isFunctionExpression(node))
  );
}

/**
 * The nearest enclosing named function: a declaration, a method, a named
 * function expression, or a property or variable a function is assigned to.
 */
function enclosingName(node: ts.Node): string {
  for (let current = node.parent; ; current = current.parent) {
    if (ts.isSourceFile(current)) return "<module>";
    const name = (current as Readonly<{ name?: ts.Node }>).name;
    const named =
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isFunctionExpression(current) ||
      ((ts.isPropertyAssignment(current) ||
        ts.isVariableDeclaration(current)) &&
        isFunctionValue(current.initializer));
    if (named && name !== undefined && ts.isIdentifier(name)) return name.text;
  }
}

/** The declaration a callee resolves to, through import aliases. */
function resolvedDeclaration(
  checker: ts.TypeChecker,
  callee: ts.Expression,
): ts.Declaration | undefined {
  const symbol = checker.getSymbolAtLocation(callee);
  if (symbol === undefined) return undefined;
  const target =
    (symbol.flags & ts.SymbolFlags.Alias) === 0 ?
      symbol
    : checker.getAliasedSymbol(symbol);
  return target.declarations?.[0];
}

/** Whether `node` runs inside a callback handed to `runHandleStatement`. */
function isAdmitted(checker: ts.TypeChecker, node: ts.Node): boolean {
  for (let current = node.parent; !ts.isSourceFile(current);) {
    const parent = current.parent;
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isCallExpression(parent) &&
      parent.arguments[1] === current
    ) {
      const declaration = resolvedDeclaration(checker, parent.expression);
      if (
        declaration !== undefined &&
        ts.isFunctionDeclaration(declaration) &&
        declaration.name?.text === ADMISSION_FUNCTION &&
        path.resolve(declaration.getSourceFile().fileName) === ADMISSION_MODULE
      ) {
        return true;
      }
    }
    current = parent;
  }
  return false;
}

/** Whether `name` names a method Drizzle declares on a database or transaction class. */
function isDrizzleHandleMethod(
  checker: ts.TypeChecker,
  name: ts.MemberName,
): boolean {
  const declaration = checker.getSymbolAtLocation(name)?.declarations?.[0];
  if (declaration === undefined) return false;
  if (!declaration.getSourceFile().fileName.includes("/drizzle-orm/")) {
    return false;
  }
  const owner = declaration.parent;
  return (
    ts.isClassDeclaration(owner) &&
    owner.name !== undefined &&
    /(?:Database|Transaction)$/.test(owner.name.text)
  );
}

/** Every Drizzle-handle call in `files` (absolute paths). */
function scanHandleCalls(
  scan: ScanProgram,
  files: readonly string[],
): readonly HandleCall[] {
  const calls: HandleCall[] = [];
  for (const file of files) {
    const source = scan.program.getSourceFile(file);
    if (source === undefined) throw new Error(`${file} is not in program`);
    const relative = path
      .relative(BACKEND_ROOT, file)
      .split(path.sep)
      .join("/");
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        isDrizzleHandleMethod(scan.checker, node.expression.name)
      ) {
        calls.push({
          key: `${relative}#${enclosingName(node)}#${node.expression.expression.getText(source)}.${node.expression.name.text}`,
          admitted: isAdmitted(scan.checker, node),
          line:
            source.getLineAndCharacterOfPosition(node.getStart(source)).line +
            1,
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return calls;
}

/** Unadmitted calls per key. */
function countUnadmitted(
  calls: readonly HandleCall[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const call of calls) {
    if (!call.admitted) counts[call.key] = (counts[call.key] ?? 0) + 1;
  }
  return counts;
}

const FIXTURE = "src/backend/drizzle/handle-statement-ratchet-fixture.ts";

/**
 * One bare call, one admitted call, one admitted transaction whose body's
 * statement is admitted with it, and a non-Drizzle `execute`.
 */
const FIXTURE_SOURCE = `
import { sql } from "drizzle-orm";
import { runHandleStatement as admit } from "./execution/handle-statement";
import type { AnyPgDatabase } from "./execution/postgres-execution";
import type { SqlExecutionAdapter } from "./execution/types";

export async function bareWrite(handle: AnyPgDatabase): Promise<void> {
  await handle.execute(sql\`SELECT 1\`);
}

export async function admittedWrite(
  adapter: SqlExecutionAdapter,
  handle: AnyPgDatabase,
): Promise<void> {
  await admit(adapter, () => handle.execute(sql\`SELECT 1\`));
  await admit(adapter, () =>
    handle.transaction(async (tx) => {
      await tx.execute(sql\`SELECT 1\`);
    }),
  );
}

export async function notDrizzle(
  other: Readonly<{ execute: (text: string) => Promise<void> }>,
): Promise<void> {
  await other.execute("SELECT 1");
}
`;

/** Headroom for building the checker program over every `src` module. */
const SCAN_TIMEOUT_MS = 120_000;

describe("statements composed on a backend's Drizzle handle", () => {
  let scan: ScanProgram;

  beforeAll(() => {
    scan = createScanProgram({ [FIXTURE]: FIXTURE_SOURCE });
  }, SCAN_TIMEOUT_MS);

  it("sees a bare call, an admitted one under an aliased import, the statement of an admitted transaction, and not a non-Drizzle method", () => {
    const calls = scanHandleCalls(scan, [path.join(PACKAGE_ROOT, FIXTURE)]);
    expect(calls.map(({ key, admitted }) => ({ key, admitted }))).toEqual([
      {
        key: "drizzle/handle-statement-ratchet-fixture.ts#bareWrite#handle.execute",
        admitted: false,
      },
      {
        key: "drizzle/handle-statement-ratchet-fixture.ts#admittedWrite#handle.execute",
        admitted: true,
      },
      {
        key: "drizzle/handle-statement-ratchet-fixture.ts#admittedWrite#handle.transaction",
        admitted: true,
      },
      {
        key: "drizzle/handle-statement-ratchet-fixture.ts#admittedWrite#tx.execute",
        admitted: true,
      },
    ]);
  });

  it("admits every call on a Drizzle handle in src/backend through runHandleStatement, or lists it with its reason", () => {
    const files = scan.sourceFiles.filter((file) =>
      file.startsWith(BACKEND_ROOT + path.sep),
    );
    const calls = scanHandleCalls(scan, files);
    const listed = Object.fromEntries(
      Object.entries(UNADMITTED_HANDLE_CALLS).map(([key, allowance]) => [
        key,
        allowance.sites ?? 1,
      ]),
    );
    const unlisted = calls
      .filter((call) => !call.admitted && listed[call.key] === undefined)
      .map((call) => `${call.key} (line ${call.line})`);
    expect({ unlisted, counts: countUnadmitted(calls) }).toEqual({
      unlisted: [],
      counts: listed,
    });
    // The routed population this ratchet exists for stays routed.
    expect(calls.filter((call) => call.admitted).length).toBeGreaterThan(0);
  });
});
