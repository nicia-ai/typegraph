/**
 * Imperative throwaway PostgreSQL container: `docker run` + harness-allocated
 * free port, torn down on `close()`. Used for the TypeGraph/PostgreSQL engine
 * so its server pairing with Neo4j launches the same way — neither depends
 * on an ambient daemon or compose file (docs/design/benchmark-program-plan.md).
 *
 * PGDATA lives on the container's own writable layer (disk-backed), not a
 * tmpfs. A tmpfs is RAM-backed by the Docker VM, and real LDBC SF1 data plus
 * indexes (multiple GB) overflows a laptop-sized Docker VM (observed: "no
 * space left on device" mid-load against a 4g tmpfs on an 8GB VM) — the same
 * lesson the sibling braiddb project's own SNB benchmark driver documents
 * (`storage = dataDir ? PGDATA-on-disk : tmpfs`). `fsync=off` still labels
 * this as a fast, non-durable mode; only the RAM-vs-disk backing changed.
 */
import { freePort, spawnCapture } from "./process";
import { POSTGRES_IMAGE } from "./doctor";

export type PostgresContainer = Readonly<{
  connectionString: string;
  /** e.g. "disk, fsync=off" — for the results doc's durability labels. */
  durabilityLabel: string;
  close(): Promise<void>;
}>;

const POSTGRES_USER = "typegraph";
const POSTGRES_PASSWORD = "typegraph";
const POSTGRES_DB = "typegraph_bench";

export async function startPostgresContainer(): Promise<PostgresContainer> {
  const port = await freePort();
  const container = `typegraph-bench-snb-pg-${process.pid}-${Date.now()}`;

  await spawnCapture("docker", [
    "run",
    "-d",
    "--name",
    container,
    "-p",
    `127.0.0.1:${port}:5432`,
    "-e",
    `POSTGRES_USER=${POSTGRES_USER}`,
    "-e",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "-e",
    `POSTGRES_DB=${POSTGRES_DB}`,
    POSTGRES_IMAGE,
    "-c",
    "fsync=off",
  ]);

  const connectionString = `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${port}/${POSTGRES_DB}`;

  const close = async (): Promise<void> => {
    await spawnCapture("docker", ["rm", "-f", container]).catch(
      () => undefined,
    );
  };

  try {
    await waitForPostgresReady(connectionString);
  } catch (error) {
    await close();
    throw error;
  }

  return {
    connectionString,
    durabilityLabel:
      "disk (container writable layer), fsync=off (fast mode — not a durability guarantee)",
    close,
  };
}

async function waitForPostgresReady(connectionString: string): Promise<void> {
  const { Client } = await import("pg");
  const deadline = Date.now() + 60_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const client = new Client({
      connectionString,
      connectionTimeoutMillis: 2_000,
    });
    try {
      await client.connect();
      await client.query("select 1");
      await client.end();
      return;
    } catch (error) {
      lastError = error;
      await client.end().catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(
    `PostgreSQL container did not become ready within 60s: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
