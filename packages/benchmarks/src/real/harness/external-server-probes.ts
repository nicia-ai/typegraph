/**
 * Doctor probes for the servers named by the `*_URL` variables
 * (`./external-servers.ts`). Each probe connects once, reads the facts the
 * engine will depend on, and reports a verdict, so a run that cannot work on
 * the given server is refused by the doctor instead of failing after a long
 * load. Nothing is written: the per-run database and the emptiness check
 * happen in the engine itself.
 */
import type { Client } from "pg";

import {
  EXTERNAL_NEO4J_URL_ENV,
  EXTERNAL_PGGRAPH_URL_ENV,
  EXTERNAL_POSTGRES_URL_ENV,
  parseNeo4jServerAddress,
  redactUrl,
} from "./external-servers";
import { stringifyError } from "./process";

const PROBE_TIMEOUT_MS = 5_000;

export type ProbeVerdict = Readonly<{ ok: boolean; detail: string }>;

/** The TypeGraph/PostgreSQL engine creates a per-run database: it needs CREATEDB. */
export function postgresServerVerdict(
  facts: Readonly<{ serverVersion: string; canCreateDatabase: boolean }>,
): ProbeVerdict {
  return facts.canCreateDatabase ?
      {
        ok: true,
        detail: `PostgreSQL ${facts.serverVersion}; role can create the per-run database.`,
      }
    : {
        ok: false,
        detail: `PostgreSQL ${facts.serverVersion}; the role lacks CREATEDB, so the per-run database cannot be created.`,
      };
}

/**
 * pgGraph needs the `graph` extension available to `CREATE EXTENSION` in the
 * per-run database, and a superuser role (the extension is untrusted and the
 * load sets the superuser-only `graph.sync_mode`).
 */
export function pgGraphServerVerdict(
  facts: Readonly<{
    serverVersion: string;
    graphExtensionVersion: string | undefined;
    superuser: boolean;
  }>,
): ProbeVerdict {
  if (facts.graphExtensionVersion === undefined) {
    return {
      ok: false,
      detail: `PostgreSQL ${facts.serverVersion}; the pgGraph extension (graph) is not installed on this server.`,
    };
  }
  if (!facts.superuser) {
    return {
      ok: false,
      detail: `PostgreSQL ${facts.serverVersion}, pgGraph ${facts.graphExtensionVersion} available; the role is not a superuser, which CREATE EXTENSION graph and graph.sync_mode require.`,
    };
  }
  return {
    ok: true,
    detail: `PostgreSQL ${facts.serverVersion}, pgGraph ${facts.graphExtensionVersion} available; superuser role.`,
  };
}

/** The GA queries run through Graph Data Science, so the server must have it. */
export function neo4jServerVerdict(
  facts: Readonly<{
    version: string;
    edition: string;
    gdsVersion: string | undefined;
  }>,
): ProbeVerdict {
  return facts.gdsVersion === undefined ?
      {
        ok: false,
        detail: `Neo4j ${facts.version} (${facts.edition}); Graph Data Science is not installed, and the GA queries need it.`,
      }
    : {
        ok: true,
        detail: `Neo4j ${facts.version} (${facts.edition}), Graph Data Science ${facts.gdsVersion}.`,
      };
}

async function withPgClient<T>(
  url: string,
  action: (client: Client) => Promise<T>,
): Promise<T> {
  // Imported lazily, like every driver the doctor checks: a missing package
  // is reported as a failed check, not a crash at module load.
  const { Client: PgClient } = await import("pg");
  const client = new PgClient({
    connectionString: url,
    connectionTimeoutMillis: PROBE_TIMEOUT_MS,
  });
  await client.connect();
  try {
    return await action(client);
  } finally {
    await client.end().catch(() => undefined);
  }
}

function unreachable(name: string, url: string, error: unknown): ProbeVerdict {
  return {
    ok: false,
    detail: `${name} ${redactUrl(url)} is unreachable: ${stringifyError(error)}`,
  };
}

export async function probePostgresServer(url: string): Promise<ProbeVerdict> {
  try {
    return await withPgClient(url, async (client) => {
      const result = await client.query<{
        server_version: string;
        can_create: boolean;
      }>(
        `SELECT current_setting('server_version') AS server_version,
                (rolcreatedb OR rolsuper) AS can_create
           FROM pg_roles WHERE rolname = current_user`,
      );
      const row = result.rows[0];
      return postgresServerVerdict({
        serverVersion: row?.server_version ?? "unknown",
        canCreateDatabase: row?.can_create === true,
      });
    });
  } catch (error) {
    return unreachable(EXTERNAL_POSTGRES_URL_ENV, url, error);
  }
}

export async function probePgGraphServer(url: string): Promise<ProbeVerdict> {
  try {
    return await withPgClient(url, async (client) => {
      const server = await client.query<{
        server_version: string;
        superuser: boolean;
      }>(
        `SELECT current_setting('server_version') AS server_version, rolsuper AS superuser
           FROM pg_roles WHERE rolname = current_user`,
      );
      const extension = await client.query<{ default_version: string }>(
        "SELECT default_version FROM pg_available_extensions WHERE name = 'graph'",
      );
      return pgGraphServerVerdict({
        serverVersion: server.rows[0]?.server_version ?? "unknown",
        graphExtensionVersion: extension.rows[0]?.default_version,
        superuser: server.rows[0]?.superuser === true,
      });
    });
  } catch (error) {
    return unreachable(EXTERNAL_PGGRAPH_URL_ENV, url, error);
  }
}

export async function probeNeo4jServer(
  rawUrl: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ProbeVerdict> {
  let address: ReturnType<typeof parseNeo4jServerAddress>;
  try {
    address = parseNeo4jServerAddress(rawUrl, env);
  } catch (error) {
    return { ok: false, detail: stringifyError(error) };
  }
  const { default: neo4j } = await import("neo4j-driver");
  const config = { connectionTimeout: PROBE_TIMEOUT_MS };
  const driver =
    address.credentials === undefined ?
      neo4j.driver(address.url, undefined, config)
    : neo4j.driver(
        address.url,
        neo4j.auth.basic(
          address.credentials.username,
          address.credentials.password,
        ),
        config,
      );
  const session = driver.session({ database: address.database });
  try {
    const components = await session.run(
      "CALL dbms.components() YIELD name, versions, edition RETURN name, versions[0] AS version, edition",
    );
    const kernel = components.records
      .map((record) => record.toObject() as Record<string, string>)
      .find((row) => row["name"] === "Neo4j Kernel");
    const gdsVersion = await session
      .run("RETURN gds.version() AS version")
      .then((result) => String(result.records[0]?.get("version")))
      .catch(() => undefined);
    return neo4jServerVerdict({
      version: kernel?.["version"] ?? "unknown",
      edition: kernel?.["edition"] ?? "unknown",
      gdsVersion,
    });
  } catch (error) {
    return unreachable(EXTERNAL_NEO4J_URL_ENV, address.url, error);
  } finally {
    await session.close().catch(() => undefined);
    await driver.close().catch(() => undefined);
  }
}
