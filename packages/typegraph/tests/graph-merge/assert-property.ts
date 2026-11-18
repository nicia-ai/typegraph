import fc from "fast-check";

import { errorChain } from "../../src/utils/sql-errors";

const DRIVER_FIELDS = [
  "code",
  "severity",
  "detail",
  "hint",
  "routine",
  "table",
  "constraint",
  "query",
  "params",
] as const;

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function describeLink(link: unknown): string {
  if (typeof link !== "object" || link === null) return String(link);
  const name = link instanceof Error ? link.name : link.constructor.name;
  const message = Reflect.get(link, "message") as unknown;
  const fields = DRIVER_FIELDS.flatMap((field) => {
    const value = Reflect.get(link, field) as unknown;
    if (value === undefined) return [];
    const rendered = typeof value === "string" ? value : safeJson(value);
    return [`${field}=${rendered}`];
  });
  return [
    `${name}: ${typeof message === "string" ? message : "(no message)"}`,
    ...fields,
  ].join("\n      ");
}

/**
 * Renders an error and every `cause` beneath it, outermost first, including
 * the SQLSTATE (`code`) and the statement when a driver error carries them.
 * Test runners print only `.message`, which hid the driver error behind a
 * wrapper's summary (#860).
 */
export function formatErrorChain(error: unknown): string {
  return [...errorChain(error)]
    .map((link, depth) =>
      depth === 0 ?
        describeLink(link)
      : `  caused by [${depth}]: ${describeLink(link)}`,
    )
    .join("\n");
}

/**
 * `fc.assert` for the graph-merge property lanes. fast-check reports the seed
 * and counterexample but keeps the failing error only as `.cause`, which the
 * runner does not print; this puts the full chain in the message.
 */
export async function assertProperty<Ts>(
  property: fc.IAsyncProperty<Ts>,
  parameters?: fc.Parameters<Ts>,
): Promise<void> {
  try {
    await fc.assert(property, parameters);
  } catch (error) {
    const failure = error instanceof Error ? error.cause : undefined;
    if (failure === undefined) throw error;
    throw new Error(
      `${(error as Error).message}\n\nFailing error chain:\n${formatErrorChain(failure)}`,
      { cause: error },
    );
  }
}
