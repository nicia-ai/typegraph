/**
 * THE RATCHET for the uniqueness key owner.
 *
 * Every key the library derives goes through `uniqueFieldsKey` /
 * `uniqueConstraintKey` in `src/constraints/index.ts`, which put each value
 * in its canonical claim-key rendering before keying it. The raw renderer
 * (`computeUniqueKey`) and the walk (`claimKeyValue`) stay exported so tests
 * can name the key a raw value renders to, which also lets library code reach
 * them: a second caller would key a value in a rendering of its own choosing,
 * the drift the single owner removes. This scan refuses any library call of
 * either outside the owner's module.
 *
 * Parsed with the TypeScript AST, not matched as text, so a mention in a doc
 * comment is not a call and a line-wrapped call is still one.
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
const OWNER_MODULE = "constraints/index.ts";
const RESTRICTED_CALLEES: ReadonlySet<string> = new Set([
  "computeUniqueKey",
  "claimKeyValue",
]);

function sourceFiles(directory: string): readonly string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(entryPath);
    return entry.name.endsWith(".ts") ? [entryPath] : [];
  });
}

function restrictedCalls(file: string): readonly string[] {
  const source = ts.createSourceFile(
    file,
    fs.readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const calls: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name =
        ts.isIdentifier(callee) ? callee.text
        : ts.isPropertyAccessExpression(callee) ? callee.name.text
        : undefined;
      if (name !== undefined && RESTRICTED_CALLEES.has(name)) {
        calls.push(name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return calls;
}

describe("the uniqueness key owner", () => {
  it("is the only library module that renders a key or walks a value for one", () => {
    const callers = sourceFiles(SOURCE_ROOT)
      .map((file) => ({
        file: path.relative(SOURCE_ROOT, file).split(path.sep).join("/"),
        calls: restrictedCalls(file),
      }))
      .filter((entry) => entry.calls.length > 0)
      .map((entry) => entry.file);
    expect(callers).toEqual([OWNER_MODULE]);
  });
});
