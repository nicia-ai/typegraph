/**
 * The declaration-emit fixture checks (`scripts/declaration-emit-fixtures.ts`)
 * read every module a fixture brings into its program with the TypeScript
 * parser, so no import form can add a second entrypoint to a
 * single-entrypoint fixture unseen.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  accountableDiagnostics,
  moduleDependenciesOf,
  nonPublicDeclarationSpecifiers,
  validateDeclarationEmitFixtures,
} from "../scripts/declaration-emit-fixtures";

const FIXTURE_DIR = path.resolve(
  import.meta.dirname,
  "../type-smoke/declaration-emit",
);

function realFixtures(): readonly Readonly<{ file: string; source: string }>[] {
  return readdirSync(FIXTURE_DIR)
    .filter((file) => file.endsWith(".ts"))
    .map((file) => ({
      file,
      source: readFileSync(path.join(FIXTURE_DIR, file), "utf8"),
    }));
}

describe("declaration-emit fixture dependencies", () => {
  it("finds every form that brings a module into the program", () => {
    const source = [
      `/// <reference types="node" />`,
      `/// <reference path="./other.d.ts" />`,
      `import "side-effect";`,
      `import type { A } from "type-only";`,
      `import { type B } from "inline-type";`,
      `import * as namespace from "namespace";`,
      `export { C } from "re-export";`,
      `export type * from "type-re-export";`,
      `import legacy = require("import-equals");`,
      `type D = import("import-type").D;`,
      `const lazy = () => import("dynamic-import");`,
      `const required = require("require-call");`,
      `declare module "augmented" {}`,
    ].join("\n");
    expect(moduleDependenciesOf("fixture.ts", source)).toEqual({
      specifiers: [
        "augmented",
        "dynamic-import",
        "import-equals",
        "import-type",
        "inline-type",
        "namespace",
        "node",
        "re-export",
        "require-call",
        "side-effect",
        "type-only",
        "type-re-export",
      ],
      referencedFiles: ["./other.d.ts"],
    });
  });

  it("accepts the checked-in fixtures", () => {
    expect(validateDeclarationEmitFixtures(realFixtures()).problems).toEqual(
      [],
    );
  });

  it.each([
    [`import "@nicia-ai/typegraph/indexes";`],
    [`import type { IndexDeclaration } from "@nicia-ai/typegraph/indexes";`],
    [`type Loaded = import("@nicia-ai/typegraph/indexes").IndexDeclaration;`],
    [`export type { IndexDeclaration } from "@nicia-ai/typegraph/indexes";`],
  ])(
    "refuses a single-entrypoint fixture that also loads another entrypoint: %s",
    (extra) => {
      const fixtures = realFixtures().map((fixture) =>
        fixture.file === "typegraph-core.ts" ?
          { ...fixture, source: `${extra}\n${fixture.source}` }
        : fixture,
      );
      expect(validateDeclarationEmitFixtures(fixtures).problems).toEqual([
        "typegraph-core.ts must import @nicia-ai/typegraph/core and no other entrypoint; it imports @nicia-ai/typegraph/core, @nicia-ai/typegraph/indexes",
      ]);
    },
  );

  it("refuses a fixture that pulls a file in by path", () => {
    const fixtures = realFixtures().map((fixture) =>
      fixture.file === "typegraph.ts" ?
        {
          ...fixture,
          source: `/// <reference path="../node_modules/@nicia-ai/typegraph/dist/indexes/index.d.ts" />\n${fixture.source}`,
        }
      : fixture,
    );
    expect(validateDeclarationEmitFixtures(fixtures).problems).toEqual([
      "typegraph.ts references ../node_modules/@nicia-ai/typegraph/dist/indexes/index.d.ts by path; a fixture's program holds only what it imports",
    ]);
  });
});

describe("emitted declaration specifiers", () => {
  it("allows public entrypoints and the consumer's own dependencies only", () => {
    const publicSpecifiers = new Set([
      "@nicia-ai/typegraph",
      "@nicia-ai/typegraph/query",
    ]);
    const declaration = [
      `import { z } from "zod";`,
      `import type { PGlite } from "@electric-sql/pglite";`,
      `import "./node_modules/@nicia-ai/typegraph/dist/store-entry.d-abc.js";`,
      `export declare const a: import("@nicia-ai/typegraph/query").Query;`,
      `export declare const b: import("../dist/store-entry.d-123").Store;`,
      `export declare const c: import("drizzle-orm/sqlite-core").Table;`,
    ].join("\n");
    expect(
      nonPublicDeclarationSpecifiers("out.d.ts", declaration, publicSpecifiers),
    ).toEqual([
      "../dist/store-entry.d-123",
      "./node_modules/@nicia-ai/typegraph/dist/store-entry.d-abc.js",
    ]);
  });
});

describe("accountable diagnostics", () => {
  it("keeps every diagnostic but those located in a third-party package's declarations", () => {
    const output = [
      "node_modules/.pnpm/zod@4.6.7/node_modules/zod/v4/core/schemas.d.cts(194,117): error TS2304: Cannot find name 'URL'.",
      "node_modules/.pnpm/drizzle-orm@0.45.4/node_modules/drizzle-orm/pg-core/policies.d.ts(13,22): error TS2420: Class 'PgPolicy' incorrectly implements interface 'PgPolicyConfig'.",
      "  Types of property 'as' are incompatible.",
      "node_modules/.pnpm/@nicia-ai+typegraph@file+typegraph.tgz/node_modules/@nicia-ai/typegraph/dist/interchange/index.d.ts(640,39): error TS2304: Cannot find name 'AbortSignal'.",
      "declaration-out/node16/pglite/pglite.d.ts(3,13): error TS2304: Cannot find name 'PGlite'.",
      "error TS2318: Cannot find global type 'Array'.",
      "",
    ].join("\n");
    const { accountable, thirdParty } = accountableDiagnostics(output);
    expect(thirdParty).toHaveLength(2);
    expect(thirdParty[1]).toContain("Types of property 'as' are incompatible.");
    expect(accountable).toEqual([
      "node_modules/.pnpm/@nicia-ai+typegraph@file+typegraph.tgz/node_modules/@nicia-ai/typegraph/dist/interchange/index.d.ts(640,39): error TS2304: Cannot find name 'AbortSignal'.",
      "declaration-out/node16/pglite/pglite.d.ts(3,13): error TS2304: Cannot find name 'PGlite'.",
      "error TS2318: Cannot find global type 'Array'.",
    ]);
  });
});
