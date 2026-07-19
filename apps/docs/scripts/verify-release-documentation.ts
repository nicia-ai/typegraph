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

function builtTargetForRoute(route: string): string {
  const decodedRoute = decodeURI(route);
  if (decodedRoute.endsWith(".txt") || decodedRoute.endsWith(".xml")) {
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

      if (targetUrl.hash === "" || builtTarget.endsWith(".txt")) continue;
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
      origins.set(
        virtualFilename,
        `${path.relative(repositoryDirectory, markdownFile)}:${sourceLine(contents, match.index) + 1}`,
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
