/**
 * Framework-agnostic conformance checks for the endpoint-set read family.
 *
 * The runner deliberately accepts prepared backend parameters and expected
 * rows: graph schemas and database setup belong to the adapter's own test
 * suite. It owns the protocol that every implementation must share — the
 * operation exists, successful reads preserve the adapter's row contract,
 * and invalid requests fail with an error instead of being silently widened
 * into a different query.
 */
import { TypeGraphError } from "../../errors";
import { endpointSetReadMembers } from "../capabilities/bind";
import { endpointSetReadVerdict } from "../capabilities/resolve";
import type {
  EdgeRow,
  FindEdgesByEndpointSetParams,
  GraphBackend,
} from "../types";

export type EndpointSetReadEquality = (
  actual: readonly EdgeRow[],
  expected: readonly EdgeRow[],
) => boolean;

export type EndpointSetReadConformanceSuccess = Readonly<{
  name: string;
  params: FindEdgesByEndpointSetParams;
  expected: readonly EdgeRow[];
}>;

export type EndpointSetReadConformanceRefusal = Readonly<{
  name: string;
  params: FindEdgesByEndpointSetParams;
  errorMatches?: (error: unknown) => boolean;
}>;

export type EndpointSetReadConformanceFixture = Readonly<{
  backend: GraphBackend;
  equal: EndpointSetReadEquality;
  successes: readonly EndpointSetReadConformanceSuccess[];
  refusals: readonly EndpointSetReadConformanceRefusal[];
}>;

export type EndpointSetReadConformanceReport = Readonly<{
  passed: readonly string[];
}>;

export class EndpointSetReadConformanceError extends TypeGraphError {
  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message, "ENDPOINT_SET_READ_CONFORMANCE_ERROR", {
      category: "system",
      details,
    });
    this.name = "EndpointSetReadConformanceError";
  }
}

function assertEqual(
  equal: EndpointSetReadEquality,
  actual: readonly EdgeRow[],
  expected: readonly EdgeRow[],
  check: string,
): void {
  if (equal(actual, expected)) return;
  throw new EndpointSetReadConformanceError(
    `Endpoint-set read conformance check failed: ${check}.`,
    { check, actual, expected },
  );
}

/**
 * Runs the endpoint-set read contract against the exact backend object the
 * adapter author supplies. No SQL, schema, or test-framework assumptions are
 * made, so the same fixture can run on SQLite, PostgreSQL, or a third-party
 * backend.
 */
export async function runEndpointSetReadConformance(
  fixture: EndpointSetReadConformanceFixture,
): Promise<EndpointSetReadConformanceReport> {
  const read = endpointSetReadMembers(
    fixture.backend,
    endpointSetReadVerdict(fixture.backend),
  ).findEdgesByEndpointSet;
  if (read === undefined) {
    throw new EndpointSetReadConformanceError(
      "Endpoint-set read conformance requires findEdgesByEndpointSet.",
      { capability: "findEdgesByEndpointSet" },
    );
  }
  if (fixture.successes.length === 0) {
    throw new EndpointSetReadConformanceError(
      "Endpoint-set read conformance requires at least one success case.",
      { check: "success case inventory" },
    );
  }
  if (fixture.refusals.length === 0) {
    throw new EndpointSetReadConformanceError(
      "Endpoint-set read conformance requires at least one refusal case.",
      { check: "refusal case inventory" },
    );
  }

  const passed: string[] = [];
  for (const success of fixture.successes) {
    const actual = await read(success.params);
    assertEqual(fixture.equal, actual, success.expected, success.name);
    passed.push(`success: ${success.name}`);
  }

  for (const refusal of fixture.refusals) {
    let error: unknown;
    try {
      await read(refusal.params);
    } catch (error_) {
      error = error_;
    }
    if (error === undefined) {
      throw new EndpointSetReadConformanceError(
        `Endpoint-set read accepted a request that must be refused: ${refusal.name}.`,
        { check: refusal.name },
      );
    }
    if (refusal.errorMatches !== undefined && !refusal.errorMatches(error)) {
      throw new EndpointSetReadConformanceError(
        `Endpoint-set read returned an unexpected refusal: ${refusal.name}.`,
        { check: refusal.name, error },
      );
    }
    passed.push(`refusal: ${refusal.name}`);
  }

  return { passed };
}
