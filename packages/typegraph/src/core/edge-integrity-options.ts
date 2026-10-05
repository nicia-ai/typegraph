/**
 * The values an edge registration's integrity options may take, and the one
 * check that refuses anything else.
 *
 * `cardinality`, `targetCardinality`, `endpointExistence` and `acyclic` are read by string and
 * strict-boolean comparison all over the store (the claim axes, the
 * acyclicity relation, the serializer, introspection), and every one of those
 * readers treats a value it does not recognize as "undeclared". So an
 * untyped caller's `acyclic: "yes"` or `cardinality: "bogus"` must be refused
 * where the registration is accepted, never carried into a graph whose
 * declared constraint then silently does not hold — or into a stored schema
 * the loader's own enum rejects.
 *
 * The value lists live here because the layers validate against them: this
 * module (`defineGraph`), the stored-schema parser (`src/schema/types.ts`)
 * and the runtime graph-extension validator
 * (`src/graph-extension/validation.ts`).
 */
import { ConfigurationError } from "../errors/index";
import {
  type Cardinality,
  type EndpointExistence,
  type TargetCardinality,
} from "./types";

export const CARDINALITY_VALUES = [
  "many",
  "one",
  "unique",
  "oneActive",
] as const satisfies readonly Cardinality[];

/** Every {@link CARDINALITY_VALUES} entry a target side may declare. */
export const TARGET_CARDINALITY_VALUES: readonly TargetCardinality[] =
  CARDINALITY_VALUES.filter(
    (cardinality): cardinality is TargetCardinality => cardinality !== "unique",
  );

export const ENDPOINT_EXISTENCE_VALUES = [
  "notDeleted",
  "currentlyValid",
  "ever",
] as const satisfies readonly EndpointExistence[];

/** The integrity options of one edge registration, as an untyped caller may state them. */
type StatedEdgeIntegrityOptions = Readonly<{
  cardinality?: unknown;
  targetCardinality?: unknown;
  endpointExistence?: unknown;
  acyclic?: unknown;
}>;

function assertStatedLiteral(
  edgeName: string,
  option: "cardinality" | "targetCardinality" | "endpointExistence",
  value: unknown,
  allowed: readonly string[],
): void {
  if (value === undefined) return;
  if (typeof value === "string" && allowed.includes(value)) return;
  const list = allowed.map((entry) => `"${entry}"`).join(", ");
  throw new ConfigurationError(
    `Edge "${edgeName}" declares \`${option}\` with a value that is not one of: ${list}.`,
    {
      code: "EDGE_INTEGRITY_OPTION_INVALID",
      edgeKind: edgeName,
      option,
      value,
    },
    { suggestion: `Declare \`${option}\` as one of ${list}, or omit it.` },
  );
}

/**
 * Refuses an edge registration whose `cardinality`, `targetCardinality`,
 * `endpointExistence` or `acyclic` is stated with a value outside its domain.
 *
 * @throws ConfigurationError (`EDGE_INTEGRITY_OPTION_INVALID`)
 */
export function assertEdgeIntegrityOptions(
  edgeName: string,
  stated: StatedEdgeIntegrityOptions,
): void {
  assertStatedLiteral(
    edgeName,
    "cardinality",
    stated.cardinality,
    CARDINALITY_VALUES,
  );
  assertStatedLiteral(
    edgeName,
    "targetCardinality",
    stated.targetCardinality,
    TARGET_CARDINALITY_VALUES,
  );
  assertStatedLiteral(
    edgeName,
    "endpointExistence",
    stated.endpointExistence,
    ENDPOINT_EXISTENCE_VALUES,
  );
  if (stated.acyclic !== undefined && typeof stated.acyclic !== "boolean") {
    throw new ConfigurationError(
      `Edge "${edgeName}" declares \`acyclic\` with a value that is not a boolean.`,
      {
        code: "EDGE_INTEGRITY_OPTION_INVALID",
        edgeKind: edgeName,
        option: "acyclic",
        value: stated.acyclic,
      },
      { suggestion: "Declare `acyclic` as `true` or `false`, or omit it." },
    );
  }
}
