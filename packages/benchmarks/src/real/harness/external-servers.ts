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
 * A value that does not parse as a URL is withheld entirely rather than
 * echoed, since it may still carry a credential.
 */
export function redactUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password !== "") url.password = "***";
    return url.toString();
  } catch {
    return "<unparseable URL withheld>";
  }
}
