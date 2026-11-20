/**
 * Environment variables that point an SNB server engine at a server the
 * harness did not start, and the URL handling every such engine shares.
 *
 * Each variable switches exactly one engine from its default (a throwaway
 * container the harness launches and removes) to an existing server. Unset or
 * blank keeps the container path. An engine on an existing server isolates its
 * run the way its container path would (a fresh per-run database, or an
 * emptiness check where the server cannot create one) and its cleanup removes
 * only what the run created.
 */

export const EXTERNAL_POSTGRES_URL_ENV = "TYPEGRAPH_BENCH_POSTGRES_URL";
export const EXTERNAL_PGGRAPH_URL_ENV = "TYPEGRAPH_BENCH_PGGRAPH_URL";
export const EXTERNAL_NEO4J_URL_ENV = "TYPEGRAPH_BENCH_NEO4J_URL";
export const EXTERNAL_NEO4J_DATABASE_ENV = "TYPEGRAPH_BENCH_NEO4J_DATABASE";

type Env = Readonly<Record<string, string | undefined>>;

/** The trimmed value of `name`, or `undefined` when it is unset or blank. */
export function readExternalUrl(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * The URL with its password replaced, for logs, reports and the run header.
 * A value that does not parse as a URL with a host is withheld entirely
 * rather than echoed: `user:secret@host` parses as an opaque `user:` URL
 * whose "path" still carries the credential.
 */
export function redactUrl(value: string): string {
  const withheld = "<unparseable URL withheld>";
  try {
    const url = new URL(value);
    if (url.host === "") return withheld;
    if (url.password !== "") url.password = "***";
    return url.toString();
  } catch {
    return withheld;
  }
}

const NEO4J_URL_SCHEMES = new Set([
  "bolt:",
  "bolt+s:",
  "bolt+ssc:",
  "neo4j:",
  "neo4j+s:",
  "neo4j+ssc:",
]);

export type Neo4jServerAddress = Readonly<{
  /** The URL the driver connects to, with any credentials removed. */
  url: string;
  /** Basic-auth credentials taken from the URL's userinfo, if present. */
  credentials: Readonly<{ username: string; password: string }> | undefined;
  database: string;
}>;

/** The Neo4j database a run uses when none is named. */
export const DEFAULT_NEO4J_DATABASE = "neo4j";

/**
 * Splits `bolt://user:password@host:7687` into the credential-free URL the
 * driver connects to and the basic-auth token, since the driver takes
 * credentials separately. Percent-encoded userinfo is decoded. The database
 * comes from `TYPEGRAPH_BENCH_NEO4J_DATABASE` (default `neo4j`), because a
 * bolt URL has no database component.
 */
export function parseNeo4jServerAddress(
  rawUrl: string,
  env: Env,
): Neo4jServerAddress {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(
      `${EXTERNAL_NEO4J_URL_ENV} is not a URL (expected bolt://[user:password@]host:port).`,
    );
  }
  if (!NEO4J_URL_SCHEMES.has(url.protocol)) {
    throw new Error(
      `${EXTERNAL_NEO4J_URL_ENV} must use a bolt:// or neo4j:// scheme (got ${url.protocol}).`,
    );
  }
  const credentials =
    url.username === "" ?
      undefined
    : {
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
  url.username = "";
  url.password = "";
  const database =
    readExternalUrl(env, EXTERNAL_NEO4J_DATABASE_ENV) ?? DEFAULT_NEO4J_DATABASE;
  return { url: url.toString().replace(/\/$/, ""), credentials, database };
}
