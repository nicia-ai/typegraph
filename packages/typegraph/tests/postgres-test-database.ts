/**
 * Per-suite PostgreSQL database provisioning.
 *
 * Every server-Postgres suite in this package assumes it owns the graph
 * tables it operates on: `beforeEach` hooks `TRUNCATE` them, `beforeAll`
 * hooks re-run the migration SQL, and a few suites `DROP` them outright.
 * Those assumptions hold in CI, where each job gets a private database, but
 * they do not hold when several suites share one database — the second suite's
 * `TRUNCATE`/`DROP` lands in the middle of the first suite's test. That is a
 * harness defect rather than a product defect, and the fix is to make
 * exclusive ownership true by construction: each test *file* gets its own
 * database, derived from its filename and created fresh on demand.
 *
 * Isolation is per database rather than per schema because ~30 assertions in
 * these suites read catalog views filtered on `schemaname = 'public'`, and
 * because `search_path` fall-through to a populated `public` schema silently
 * defeats the lazy DDL bootstrap (see `createServerPostgresMergeBackend`).
 * A separate database keeps `public` meaningful and needs no changes to the
 * suites' SQL.
 *
 * Usage — replace the ad-hoc URL constant at the top of a suite:
 *
 * ```ts
 * const TEST_DATABASE_URL = await provisionPostgresTestDatabase(import.meta.url);
 * ```
 *
 * When `POSTGRES_URL` is unset (the SQLite lane) nothing connects and the
 * documented default URL is returned unchanged, so the `describe.runIf`
 * gates behave exactly as before.
 *
 * Operational notes:
 *
 * - The database is dropped and recreated, so a suite never inherits residue
 *   from an earlier run. It is deliberately *not* dropped afterwards: the
 *   Docker lane is ephemeral anyway, and keeping it around makes a failure
 *   inspectable.
 * - One vitest invocation at a time per `POSTGRES_URL`. Concurrent lanes must
 *   use separate base databases — two invocations of the same suite resolve to
 *   the same isolated database name and the loser gets its connections
 *   terminated by `DROP DATABASE ... WITH (FORCE)`.
 * - The role behind `POSTGRES_URL` needs `CREATEDB`. Set
 *   `TYPEGRAPH_TEST_SHARED_DATABASE=1` to opt out and run every suite against
 *   the base database (the pre-isolation behaviour, hazards included).
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Pool } from "pg";

/**
 * Connection URL used when `POSTGRES_URL` is unset. Nothing connects to it —
 * the suites are gated on `POSTGRES_URL` — but it documents what
 * `docker-compose.yml` publishes. 127.0.0.1 rather than localhost avoids IPv6
 * resolution issues.
 */
const DEFAULT_POSTGRES_TEST_URL =
  "postgresql://typegraph:typegraph@127.0.0.1:5432/typegraph_test";

/** Escape hatch for roles without `CREATEDB`; see the module comment. */
const SHARED_DATABASE_ENV = "TYPEGRAPH_TEST_SHARED_DATABASE";

/** `NAMEDATALEN - 1`: PostgreSQL truncates identifiers beyond this. */
const MAX_IDENTIFIER_LENGTH = 63;

const HASH_SUFFIX_LENGTH = 8;

const ADMIN_CONNECT_TIMEOUT_MS = 5000;

/** PostgreSQL `insufficient_privilege`. */
const INSUFFICIENT_PRIVILEGE = "42501";

/**
 * `pg_database` columns that decide how text sorts and compares. The isolated
 * database must agree with the base database on every one of them, or a
 * suite's `ORDER BY` assertions would be testing a different collation than
 * the operator configured. Names vary across major versions (`daticulocale`
 * became `datlocale` in 18), so the comparison uses whichever of these keys
 * the server actually reports.
 */
const LOCALE_KEYS = [
  "encoding",
  "datcollate",
  "datctype",
  "datlocprovider",
  "datlocale",
  "daticulocale",
  "daticurules",
] as const;

type DatabaseRow = Readonly<Record<string, unknown>>;

/**
 * Creates (or recreates) a database dedicated to one test file and returns its
 * connection URL.
 *
 * @param testFileUrl - The caller's `import.meta.url`; names the database.
 */
export async function provisionPostgresTestDatabase(
  testFileUrl: string,
): Promise<string> {
  const configuredUrl = process.env["POSTGRES_URL"];
  if (configuredUrl === undefined || configuredUrl === "")
    return DEFAULT_POSTGRES_TEST_URL;
  if (process.env[SHARED_DATABASE_ENV] === "1") return configuredUrl;

  const baseDatabase = databaseNameFromUrl(configuredUrl);
  const isolatedDatabase = isolatedDatabaseName(
    baseDatabase,
    suiteSlug(testFileUrl),
  );
  await recreateDatabase(configuredUrl, baseDatabase, isolatedDatabase);

  const isolatedUrl = new URL(configuredUrl);
  isolatedUrl.pathname = `/${encodeURIComponent(isolatedDatabase)}`;
  return isolatedUrl.toString();
}

function databaseNameFromUrl(connectionUrl: string): string {
  const { pathname } = new URL(connectionUrl);
  const name = decodeURIComponent(pathname.replace(/^\//, ""));
  if (name === "")
    throw new Error(
      `POSTGRES_URL must name a database (got "${connectionUrl}")`,
    );
  return name;
}

/** `identity-enablement-lock.test.ts` -> `identity_enablement_lock`. */
function suiteSlug(testFileUrl: string): string {
  const fileName = path
    .basename(fileURLToPath(testFileUrl))
    .replace(/\.(test\.)?ts$/, "");
  return fileName.replaceAll(/[^a-z0-9]+/gi, "_").toLowerCase();
}

function isolatedDatabaseName(baseDatabase: string, slug: string): string {
  const preferred = `${baseDatabase}__${slug}`;
  if (preferred.length <= MAX_IDENTIFIER_LENGTH) return preferred;
  // Truncation alone could collide two long suite names into one database.
  const digest = createHash("sha256")
    .update(preferred)
    .digest("hex")
    .slice(0, HASH_SUFFIX_LENGTH);
  const head = preferred.slice(0, MAX_IDENTIFIER_LENGTH - digest.length - 1);
  return `${head}_${digest}`;
}

/**
 * Drops and recreates `isolatedDatabase` through a single-connection admin
 * pool on the base database, copying the base database's encoding and
 * collation so the two sort text identically.
 */
async function recreateDatabase(
  adminUrl: string,
  baseDatabase: string,
  isolatedDatabase: string,
): Promise<void> {
  const admin = new Pool({
    connectionString: adminUrl,
    max: 1,
    connectionTimeoutMillis: ADMIN_CONNECT_TIMEOUT_MS,
  });
  try {
    const base = await readDatabaseLocale(admin, baseDatabase);
    const quoted = quoteIdentifier(isolatedDatabase);
    await admin.query(`DROP DATABASE IF EXISTS ${quoted} WITH (FORCE)`);
    await admin.query(
      `CREATE DATABASE ${quoted} TEMPLATE template0` +
        ` ENCODING ${quoteLiteral(base.encoding)}` +
        ` LC_COLLATE ${quoteLiteral(base.datcollate)}` +
        ` LC_CTYPE ${quoteLiteral(base.datctype)}`,
    );
    await assertLocaleMatches(admin, baseDatabase, isolatedDatabase);
  } catch (error) {
    throw provisioningError(error, isolatedDatabase, baseDatabase);
  } finally {
    await admin.end();
  }
}

function provisioningError(
  cause: unknown,
  isolatedDatabase: string,
  baseDatabase: string,
): Error {
  const detail =
    hasSqlState(cause) && cause.code === INSUFFICIENT_PRIVILEGE ?
      `. The POSTGRES_URL role needs CREATEDB; grant it, or set ` +
      `${SHARED_DATABASE_ENV}=1 to share "${baseDatabase}" across suites ` +
      `(no isolation).`
    : "";
  return new Error(
    `Failed to provision the isolated test database "${isolatedDatabase}"${detail}`,
    { cause },
  );
}

function hasSqlState(error: unknown): error is { readonly code: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  );
}

type DatabaseLocale = Readonly<{
  encoding: string;
  datcollate: string;
  datctype: string;
}>;

/** Reads the `CREATE DATABASE` locale arguments of an existing database. */
async function readDatabaseLocale(
  admin: Pool,
  databaseName: string,
): Promise<DatabaseLocale> {
  const result = await admin.query<DatabaseLocale>(
    `SELECT pg_encoding_to_char(encoding) AS encoding, datcollate, datctype
       FROM pg_database
      WHERE datname = $1`,
    [databaseName],
  );
  const locale = result.rows[0];
  if (locale === undefined)
    throw new Error(`Database "${databaseName}" not found in pg_database`);
  return locale;
}

async function readDatabaseRow(
  admin: Pool,
  databaseName: string,
): Promise<DatabaseRow> {
  const result = await admin.query<{ database: DatabaseRow }>(
    `SELECT row_to_json(entry) AS database
       FROM pg_database AS entry
      WHERE datname = $1`,
    [databaseName],
  );
  const row = result.rows[0]?.database;
  if (row === undefined)
    throw new Error(`Database "${databaseName}" not found in pg_database`);
  return row;
}

async function assertLocaleMatches(
  admin: Pool,
  baseDatabase: string,
  isolatedDatabase: string,
): Promise<void> {
  const baseRow = await readDatabaseRow(admin, baseDatabase);
  const isolatedRow = await readDatabaseRow(admin, isolatedDatabase);
  const divergent = LOCALE_KEYS.filter(
    (key) =>
      key in baseRow &&
      key in isolatedRow &&
      JSON.stringify(baseRow[key]) !== JSON.stringify(isolatedRow[key]),
  );
  if (divergent.length === 0) return;

  const describeKey = (key: string): string =>
    `${key}: ${JSON.stringify(baseRow[key])} vs ${JSON.stringify(isolatedRow[key])}`;
  throw new Error(
    `Isolated database "${isolatedDatabase}" does not match the collation of ` +
      `"${baseDatabase}" (${divergent.map((key) => describeKey(key)).join(", ")}). ` +
      `Text ordering would differ from the configured database. Recreate ` +
      `"${baseDatabase}" with the cluster default locale, or set ` +
      `${SHARED_DATABASE_ENV}=1 to share it across suites (no isolation).`,
  );
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function quoteLiteral(literal: string): string {
  return `'${literal.replaceAll("'", "''")}'`;
}
