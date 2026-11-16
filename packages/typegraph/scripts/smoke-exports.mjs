// Release tarball export smoke test.
//
// Runs against the *packed* @nicia-ai/typegraph tarball installed into a
// throwaway sandbox (see .github/workflows/release.yml). For every public
// subpath declared in the package's `exports` map it imports the module
// through both the ESM (`import`) and CJS (`require`) conditions and asserts a
// representative named export resolves. This catches packaging regressions a
// type check cannot — a subpath pointing at a dist file that was never built,
// a missing module-system condition, or a module body that throws on load —
// before the artifact is published.
//
// Runs under plain `node` (no tsx/TypeScript) because the sandbox only has the
// installed tarball plus its peer dependencies.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const PACKAGE_NAME = "@nicia-ai/typegraph";

// One representative export per public subpath. Keep this in lockstep with the
// `exports` map in packages/typegraph/package.json — the manifest cross-check
// below fails the build if a subpath is added to `exports` without a matching
// entry here.
const PUBLIC_SUBPATHS = [
  { subpath: "", expectedExport: "createStore" },
  { subpath: "/backend", expectedExport: "sql" },
  { subpath: "/core", expectedExport: "defineGraph" },
  { subpath: "/interchange", expectedExport: "importGraph" },
  { subpath: "/profiler", expectedExport: "QueryProfiler" },
  { subpath: "/schema", expectedExport: "deserializeSchema" },
  { subpath: "/indexes", expectedExport: "defineNodeIndex" },
  { subpath: "/graph-extension", expectedExport: "defineGraphExtension" },
  { subpath: "/graph-merge", expectedExport: "branch" },
  { subpath: "/provenance", expectedExport: "createRetractionCapability" },
  { subpath: "/store", expectedExport: "StoreView" },
  { subpath: "/query", expectedExport: "QueryBuilder" },
  { subpath: "/errors", expectedExport: "DatabaseOperationError" },
  { subpath: "/identity", expectedExport: "pruneIdentityTransitions" },
  { subpath: "/maintenance", expectedExport: "listGraphIds" },
  { subpath: "/sqlite/local", expectedExport: "createLocalSqliteStore" },
  { subpath: "/postgres/pglite", expectedExport: "createLocalPgliteStore" },
  {
    subpath: "/adapters/drizzle/sqlite",
    expectedExport: "createSqliteBackend",
  },
  {
    subpath: "/adapters/drizzle/sqlite/local",
    expectedExport: "createLocalSqliteBackend",
  },
  {
    subpath: "/adapters/drizzle/sqlite/libsql",
    expectedExport: "createLibsqlBackend",
  },
  {
    subpath: "/adapters/drizzle/postgres",
    expectedExport: "createPostgresBackend",
  },
  {
    subpath: "/adapters/drizzle/postgres/working-copy",
    expectedExport: "createPostgresWorkingCopyManager",
  },
  {
    subpath: "/adapters/drizzle/postgres/pglite",
    expectedExport: "createLocalPgliteBackend",
  },
  {
    subpath: "/adapters/drizzle/indexes",
    expectedExport: "buildSqliteNodeIndexBuilders",
  },
  {
    subpath: "/adapters/drizzle/engine",
    expectedExport: "createSqlBackend",
  },
];

function findPackageManifest(startPath, packageName) {
  let currentDir = dirname(startPath);
  while (currentDir !== dirname(currentDir)) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(currentDir, "package.json"), "utf8"),
      );
      if (manifest.name === packageName) return manifest;
    } catch {
      // No package.json here (or unreadable) — keep walking toward the root.
    }
    currentDir = dirname(currentDir);
  }
  throw new Error(`Could not locate package.json for ${packageName}`);
}

function toSubpath(exportsKey) {
  if (exportsKey === ".") return "";
  return exportsKey.replace(/^\.\//, "/");
}

const failures = [];
// Modules loaded per condition, keyed by subpath, for the cross-module checks
// after the per-subpath loop.
const esmModules = new Map();
const cjsModules = new Map();

// Guard against the export surface growing past this test: every subpath the
// installed package declares must be covered by PUBLIC_SUBPATHS.
const manifest = findPackageManifest(
  require.resolve(PACKAGE_NAME),
  PACKAGE_NAME,
);
const declaredSubpaths = Object.keys(manifest.exports ?? {}).map((key) =>
  toSubpath(key),
);
const coveredSubpaths = new Set(PUBLIC_SUBPATHS.map((entry) => entry.subpath));
const uncovered = declaredSubpaths.filter(
  (subpath) => !coveredSubpaths.has(subpath),
);
if (uncovered.length > 0) {
  failures.push(
    `exports map has subpaths not covered by smoke test: ${uncovered.join(", ")}`,
  );
}

for (const { subpath, expectedExport } of PUBLIC_SUBPATHS) {
  const specifier = `${PACKAGE_NAME}${subpath}`;

  try {
    const esmModule = await import(specifier);
    esmModules.set(subpath, esmModule);
    if (typeof esmModule[expectedExport] === "undefined")
      failures.push(`ESM ${specifier}: missing export "${expectedExport}"`);
  } catch (error) {
    failures.push(`ESM ${specifier}: ${error.message}`);
  }

  try {
    const cjsModule = require(specifier);
    cjsModules.set(subpath, cjsModule);
    if (typeof cjsModule[expectedExport] === "undefined")
      failures.push(`CJS ${specifier}: missing export "${expectedExport}"`);
  } catch (error) {
    failures.push(`CJS ${specifier}: ${error.message}`);
  }
}

// The SQL-fragment vocabulary lives in ./backend.
const esmBackend = esmModules.get("/backend");
const cjsBackend = cjsModules.get("/backend");
if (esmBackend !== undefined && cjsBackend !== undefined) {
  try {
    const cjsFragment = cjsBackend.sql`SELECT ${1}`;
    const cjsPlaceholder = new cjsBackend.Placeholder("value");
    const renderedByEsm = esmBackend.renderPostgres(
      esmBackend.sql`${cjsFragment}, ${cjsPlaceholder}`,
    );
    if (
      renderedByEsm.sql !== "SELECT $1, $2" ||
      renderedByEsm.params[0] !== 1 ||
      renderedByEsm.params[1] !== cjsPlaceholder
    ) {
      failures.push(
        "CJS fragments/placeholders are not interoperable with ESM",
      );
    }

    const esmFragment = esmBackend.sql`SELECT ${2}`;
    const esmPlaceholder = new esmBackend.Placeholder("value");
    const renderedByCjs = cjsBackend.renderPostgres(
      cjsBackend.sql`${esmFragment}, ${esmPlaceholder}`,
    );
    if (
      renderedByCjs.sql !== "SELECT $1, $2" ||
      renderedByCjs.params[0] !== 2 ||
      renderedByCjs.params[1] !== esmPlaceholder
    ) {
      failures.push(
        "ESM fragments/placeholders are not interoperable with CJS",
      );
    }
  } catch (error) {
    failures.push(`ESM/CJS SQL fragment interoperability: ${error.message}`);
  }
}

// One class, one object: a name exported from both the root and a subpath
// must be the same object within a module system, or `instanceof` against the
// subpath's class silently fails for values the root produced. Checked within
// ESM and within CJS separately (the two systems legitimately load separate
// copies of the package).
const SHARED_EXPORTS = [
  { name: "TypeGraphError", subpath: "/errors" },
  { name: "ValidationError", subpath: "/errors" },
  { name: "ConfigurationError", subpath: "/errors" },
  { name: "defineGraph", subpath: "/core" },
];

async function assertErrorIdentity(system, modules, loadZod) {
  const root = modules.get("");
  const errors = modules.get("/errors");
  for (const { name, subpath } of SHARED_EXPORTS) {
    const fromSubpath = modules.get(subpath)?.[name];
    if (root?.[name] === undefined || fromSubpath === undefined) {
      failures.push(`${system} ${name}: missing from the root or ${subpath}`);
    } else if (root[name] !== fromSubpath) {
      failures.push(
        `${system} ${name}: the root and ${subpath} export different objects`,
      );
    }
  }
  if (root === undefined || errors === undefined) return;

  // An error thrown by a store opened from the root is an instance of the
  // ./errors classes.
  try {
    const { z } = await loadZod();
    const { createLocalSqliteBackend } = modules.get(
      "/adapters/drizzle/sqlite/local",
    );
    const Item = root.defineNode("SmokeItem", {
      schema: z.object({ name: z.string() }),
    });
    const graph = root.defineGraph({
      id: "smoke_identity",
      nodes: { SmokeItem: { type: Item } },
      edges: {},
    });
    const { backend } = createLocalSqliteBackend();
    const [store] = await root.createStoreWithSchema(graph, backend);
    let thrown;
    try {
      await store.nodes.SmokeItem.create({ name: 42 });
    } catch (error) {
      thrown = error;
    }
    await backend.close();
    if (
      !(thrown instanceof errors.ValidationError) ||
      !(thrown instanceof errors.TypeGraphError)
    ) {
      failures.push(
        `${system} a ValidationError thrown by a store opened from the root is not an instance of the ./errors classes (${String(thrown)})`,
      );
    }
  } catch (error) {
    failures.push(`${system} store error identity: ${error.message}`);
  }
}

await assertErrorIdentity("ESM", esmModules, () => import("zod"));
await assertErrorIdentity("CJS", cjsModules, () => require("zod"));

if (failures.length > 0) {
  console.error(
    `Tarball export smoke test failed:\n  ${failures.join("\n  ")}`,
  );
  process.exit(1);
}

console.log(
  `Tarball export smoke test passed: ${PUBLIC_SUBPATHS.length} subpaths × {ESM, CJS}.`,
);
