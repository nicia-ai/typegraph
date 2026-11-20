/**
 * PostgreSQL target for the TypeGraph/PostgreSQL SNB engine.
 *
 * By default the engine launches its own throwaway container
 * (`./postgres-container.ts`). Setting `TYPEGRAPH_BENCH_POSTGRES_URL` points
 * it at an existing server instead, for hosts that cannot start containers
 * but are given a dedicated PostgreSQL server. The engine never writes to the
 * database named in that URL: it creates a fresh per-run database on the same
 * server and drops it on `close()`, so every run still starts from an empty
 * database exactly as the container path does. The role in the URL therefore
 * needs `CREATEDB`.
 */
import {
  EXTERNAL_POSTGRES_URL_ENV,
  readExternalUrl,
  redactUrl,
} from "./external-servers";
import {
  type PostgresContainer,
  startPostgresContainer,
} from "./postgres-container";

export { EXTERNAL_POSTGRES_URL_ENV } from "./external-servers";

/** Returns the external server URL, or `undefined` when the container path applies. */
export function readExternalPostgresUrl(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return readExternalUrl(env, EXTERNAL_POSTGRES_URL_ENV);
}

/**
 * A per-run database name that is a plain lowercase identifier. `engine`
 * distinguishes engines sharing one server (`pggraph` gets its own prefix so
 * a leftover database says which engine left it).
 */
export function benchDatabaseName(
  processId: number,
  nowMs: number,
  engine?: "pggraph",
): string {
  const prefix =
    engine === undefined ?
      "typegraph_bench_snb"
    : `typegraph_bench_snb_${engine}`;
  return `${prefix}_${processId}_${nowMs}`;
}

/** The same server URL (credentials, host, port, query) with its database replaced. */
export function withDatabase(serverUrl: string, database: string): string {
  const url = new URL(serverUrl);
  url.pathname = `/${database}`;
  return url.toString();
}

/** Starts the configured PostgreSQL target: an external server if set, else a container. */
export async function startPostgresTarget(): Promise<PostgresContainer> {
  const externalUrl = readExternalPostgresUrl(process.env);
  if (externalUrl === undefined) return startPostgresContainer();
  return startExternalPostgresDatabase(externalUrl);
}

async function startExternalPostgresDatabase(
  serverUrl: string,
): Promise<PostgresContainer> {
  const { Client } = await import("pg");
  const database = benchDatabaseName(process.pid, Date.now());

  async function withAdminClient<T>(
    action: (client: InstanceType<typeof Client>) => Promise<T>,
  ): Promise<T> {
    const client = new Client({ connectionString: serverUrl });
    await client.connect();
    try {
      return await action(client);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  const fsync = await withAdminClient(async (client) => {
    await client.query(`CREATE DATABASE "${database}"`);
    const result = await client.query<{ fsync: string }>("SHOW fsync");
    return result.rows[0]?.fsync ?? "unknown";
  });

  return {
    connectionString: withDatabase(serverUrl, database),
    durabilityLabel: `external server (${EXTERNAL_POSTGRES_URL_ENV}), per-run database, fsync=${fsync}`,
    target: `existing server ${redactUrl(serverUrl)}, per-run database ${database}`,
    async close() {
      await withAdminClient(async (client) => {
        await client.query(
          `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`,
        );
      }).catch(() => undefined);
    },
  };
}
