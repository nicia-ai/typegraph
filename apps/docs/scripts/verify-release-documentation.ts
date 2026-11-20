import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const documentationPackageDirectory = path.dirname(scriptDirectory);
const repositoryDirectory = path.resolve(
  documentationPackageDirectory,
  "../..",
);
const documentationSourceDirectory = path.join(
  documentationPackageDirectory,
  "src/content/docs",
);
const builtDocumentationDirectory = path.join(
  documentationPackageDirectory,
  "dist/client",
);
const typegraphPackageDirectory = path.join(
  repositoryDirectory,
  "packages/typegraph",
);
const MODULE_DIAGNOSTIC_CODES = new Set([1192, 2305, 2307, 2613, 2614, 2724]);

async function collectFiles(
  directory: string,
  predicate: (filename: string) => boolean,
): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, predicate)));
    } else if (predicate(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

async function pathExists(pathToCheck: string): Promise<boolean> {
  try {
    await stat(pathToCheck);
    return true;
  } catch {
    return false;
  }
}

function sourceLine(contents: string, index: number | undefined): number {
  return contents.slice(0, index ?? 0).split("\n").length;
}

const FILE_ROUTE_EXTENSIONS = [".txt", ".xml", ".md"] as const;

function isFileRoute(route: string): boolean {
  return FILE_ROUTE_EXTENSIONS.some((extension) => route.endsWith(extension));
}

function builtTargetForRoute(route: string): string {
  const decodedRoute = decodeURI(route);
  if (isFileRoute(decodedRoute)) {
    return path.join(builtDocumentationDirectory, decodedRoute);
  }
  return path.join(builtDocumentationDirectory, decodedRoute, "index.html");
}

async function verifyInternalLinks(
  markdownFiles: readonly string[],
): Promise<void> {
  const failures: string[] = [];
  let checkedLinks = 0;
  const linkPattern = /\[[^\]]*\]\((\/[^)\s]+)\)/g;

  for (const markdownFile of markdownFiles) {
    const contents = await readFile(markdownFile, "utf8");
    for (const match of contents.matchAll(linkPattern)) {
      const rawTarget = match[1];
      const targetUrl = new URL(rawTarget, "https://typegraph.dev");
      if (targetUrl.pathname === "/") continue;
      const builtTarget = builtTargetForRoute(targetUrl.pathname);
      checkedLinks += 1;

      if (!(await pathExists(builtTarget))) {
        failures.push(
          `${path.relative(repositoryDirectory, markdownFile)}:${sourceLine(contents, match.index)} points to missing route ${targetUrl.pathname}`,
        );
        continue;
      }

      if (targetUrl.hash === "" || isFileRoute(builtTarget)) continue;
      const targetContents = await readFile(builtTarget, "utf8");
      const anchor = decodeURIComponent(targetUrl.hash.slice(1));
      if (!targetContents.includes(`id="${anchor}"`)) {
        failures.push(
          `${path.relative(repositoryDirectory, markdownFile)}:${sourceLine(contents, match.index)} points to missing anchor ${targetUrl.pathname}${targetUrl.hash}`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Broken internal documentation links:\n${failures.join("\n")}`,
    );
  }
  process.stdout.write(
    `Verified ${checkedLinks} internal documentation links.\n`,
  );
}

function typegraphImports(sourceText: string): string {
  const sourceFile = ts.createSourceFile(
    "snippet.ts",
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  return sourceFile.statements
    .filter(
      (statement) =>
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith("@nicia-ai/typegraph"),
    )
    .map((statement) => statement.getFullText(sourceFile))
    .join("\n");
}

async function verifyDocumentedImports(
  markdownFiles: readonly string[],
): Promise<void> {
  const currentMarkdownFiles = markdownFiles.filter(
    (markdownFile) => path.basename(markdownFile) !== "changelog.md",
  );
  const additionalMarkdownFiles = [
    path.join(repositoryDirectory, "README.md"),
    path.join(typegraphPackageDirectory, "README.md"),
    path.join(typegraphPackageDirectory, "examples/README.md"),
  ];
  const virtualSources = new Map<string, string>();
  const completeSnippetCandidates = new Map<string, string>();
  const origins = new Map<string, string>();
  const fencePattern = /```(?:typescript|ts)\s*\n([\s\S]*?)```/g;
  let snippetIndex = 0;

  for (const markdownFile of [
    ...additionalMarkdownFiles,
    ...currentMarkdownFiles,
  ]) {
    const contents = await readFile(markdownFile, "utf8");
    for (const match of contents.matchAll(fencePattern)) {
      const fencedSource = match[1];
      const imports = typegraphImports(fencedSource);
      if (imports.length === 0) continue;
      const virtualFilename = path.join(
        typegraphPackageDirectory,
        `__documented_import_${snippetIndex}.ts`,
      );
      snippetIndex += 1;
      virtualSources.set(virtualFilename, imports);
      completeSnippetCandidates.set(
        virtualFilename.replace(
          "__documented_import_",
          "__documented_snippet_",
        ),
        fencedSource,
      );
      const origin = `${path.relative(repositoryDirectory, markdownFile)}:${sourceLine(contents, match.index) + 1}`;
      origins.set(virtualFilename, origin);
      origins.set(
        virtualFilename.replace(
          "__documented_import_",
          "__documented_snippet_",
        ),
        origin,
      );
    }
  }

  if (virtualSources.size === 0) {
    throw new Error(
      "No TypeGraph imports were found in current documentation.",
    );
  }

  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: false,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    types: [],
  };
  const baseHost = ts.createCompilerHost(compilerOptions);
  const compilerHost: ts.CompilerHost = {
    ...baseHost,
    fileExists: (filename) =>
      virtualSources.has(filename) || baseHost.fileExists(filename),
    getCurrentDirectory: () => repositoryDirectory,
    getSourceFile: (
      filename,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      const virtualSource = virtualSources.get(filename);
      if (virtualSource !== undefined) {
        return ts.createSourceFile(
          filename,
          virtualSource,
          languageVersion,
          true,
        );
      }
      return baseHost.getSourceFile(
        filename,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    readFile: (filename) =>
      virtualSources.get(filename) ?? baseHost.readFile(filename),
  };
  const program = ts.createProgram(
    [...virtualSources.keys()],
    compilerOptions,
    compilerHost,
  );
  const failures: string[] = [];
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const sourceFile = diagnostic.file;
    if (
      sourceFile === undefined ||
      !virtualSources.has(sourceFile.fileName) ||
      !MODULE_DIAGNOSTIC_CODES.has(diagnostic.code)
    ) {
      continue;
    }
    const position = sourceFile.getLineAndCharacterOfPosition(
      diagnostic.start ?? 0,
    );
    failures.push(
      `${origins.get(sourceFile.fileName) ?? sourceFile.fileName} (import line ${position.line + 1}): TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(
      `Invalid TypeGraph imports in current documentation:\n${failures.join("\n")}`,
    );
  }
  process.stdout.write(
    `Verified TypeGraph exports in ${virtualSources.size} documentation snippets.\n`,
  );
  verifyCompleteSnippets(completeSnippetCandidates, origins);
}

/**
 * Diagnostics meaning a snippet continues from context defined elsewhere on
 * its page (a graph, a store, a fixture, a local module). Such a snippet is a
 * fragment: only its imports are checked. Any other diagnostic in a snippet
 * without one of these is a real error in the documented API usage.
 */
const FRAGMENT_DIAGNOSTIC_CODES = new Set([
  2304, // Cannot find name
  2503, // Cannot find namespace
  2552, // Cannot find name; did you mean
  2582, // Cannot find name of a test global (describe/it)
  2593, // Cannot find name of a test global (describe/it)
  2834, // Relative import (a local module of the example)
  2835, // Relative import (a local module of the example)
  18_004, // Shorthand property with no value in scope
]);

/**
 * Type-checks every snippet that imports TypeGraph and is self-contained: it
 * defines everything it uses. Self-contained snippets are compiled in full
 * against the built package, so a documented call that no longer matches the
 * API (a removed option, a wrong argument, a renamed field) fails the build.
 * Fragments are left to the import check above.
 */
function verifyCompleteSnippets(
  candidates: ReadonlyMap<string, string>,
  origins: ReadonlyMap<string, string>,
): void {
  const sources = new Map(
    [...candidates].map(([filename, source]) => [
      filename,
      `${source}\nexport {};\n`,
    ]),
  );
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    skipLibCheck: true,
    strict: true,
    target: ts.ScriptTarget.ES2022,
    // No DOM: a page-context name such as `Document` or `Node` must read as
    // missing context, not resolve to a browser global.
    lib: ["lib.es2023.d.ts"],
    types: ["node"],
  };
  const baseHost = ts.createCompilerHost(compilerOptions);
  const compilerHost: ts.CompilerHost = {
    ...baseHost,
    fileExists: (filename) =>
      sources.has(filename) || baseHost.fileExists(filename),
    getCurrentDirectory: () => repositoryDirectory,
    getSourceFile: (
      filename,
      languageVersion,
      onError,
      shouldCreateNewSourceFile,
    ) => {
      const source = sources.get(filename);
      if (source !== undefined) {
        return ts.createSourceFile(filename, source, languageVersion, true);
      }
      return baseHost.getSourceFile(
        filename,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      );
    },
    readFile: (filename) =>
      sources.get(filename) ?? baseHost.readFile(filename),
  };
  const program = ts.createProgram(
    [...sources.keys()],
    compilerOptions,
    compilerHost,
  );
  const diagnosticsBySnippet = new Map<string, ts.Diagnostic[]>();
  for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
    const fileName = diagnostic.file?.fileName;
    if (fileName === undefined || !sources.has(fileName)) continue;
    const existing = diagnosticsBySnippet.get(fileName) ?? [];
    existing.push(diagnostic);
    diagnosticsBySnippet.set(fileName, existing);
  }

  const failures: string[] = [];
  let fragments = 0;
  for (const [fileName, diagnostics] of diagnosticsBySnippet) {
    if (
      diagnostics.some((diagnostic) =>
        FRAGMENT_DIAGNOSTIC_CODES.has(diagnostic.code),
      )
    ) {
      fragments += 1;
      continue;
    }
    for (const diagnostic of diagnostics) {
      const position = diagnostic.file?.getLineAndCharacterOfPosition(
        diagnostic.start ?? 0,
      );
      failures.push(
        `${origins.get(fileName) ?? fileName} (snippet line ${(position?.line ?? 0) + 1}): TS${diagnostic.code} ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Self-contained documentation snippets that do not type-check:\n${failures.join("\n")}`,
    );
  }
  process.stdout.write(
    `Type-checked ${sources.size - fragments} self-contained documentation snippets (${fragments} page fragments checked for imports only).\n`,
  );
}

async function main(): Promise<void> {
  const markdownFiles = await collectFiles(
    documentationSourceDirectory,
    (filename) => filename.endsWith(".md") || filename.endsWith(".mdx"),
  );
  await verifyInternalLinks(markdownFiles);
  await verifyDocumentedImports(markdownFiles);
}

try {
  await main();
} catch (error: unknown) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
