/**
 * The values an edge registration's integrity options may take, and the one
 * check that refuses anything else.
 *
 * `cardinality`, `targetCardinality` and `acyclic` are read by string and
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
import { type Cardinality, type TargetCardinality } from "./types";

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

/**
 * The target-side cardinality a registration or stored edge declares. An
 * absent `targetCardinality` means `"many"`: the serializer omits the
 * default (see {@link serializedTargetCardinalityField}), so documents stored
 * before the option existed keep their hash.
 */
export function effectiveTargetCardinality(
  declared: TargetCardinality | undefined,
): TargetCardinality {
  return declared ?? "many";
}

/**
 * The `targetCardinality` field a serialized edge carries: omitted when
 * undeclared or declared as the default, so a graph that never uses the
 * option serializes and hashes byte-identically to a document produced
 * before it existed.
 */
export function serializedTargetCardinalityField(
  declared: TargetCardinality | undefined,
): Readonly<{ targetCardinality?: TargetCardinality }> {
  return declared === undefined || declared === "many" ?
      {}
    : { targetCardinality: declared };
}

/** The integrity options of one edge registration, as an untyped caller may state them. */
type StatedEdgeIntegrityOptions = Readonly<{
  cardinality?: unknown;
  targetCardinality?: unknown;
  endpointExistence?: unknown;
  acyclic?: unknown;
}>;

function assertStatedLiteral(
  edgeName: string,
  option: "cardinality" | "targetCardinality",
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
 * `endpointExistence` was accepted, stored and reported but never read by any
 * edge write, and was removed. A registration that still states it (an
 * untyped caller, or code written against an earlier release) is refused
 * rather than having the value silently dropped. The edge writes check their
 * endpoints exactly as they did when it was accepted.
 */
function assertRemovedEndpointExistenceNotStated(
  edgeName: string,
  value: unknown,
): void {
  if (value === undefined) return;
  throw new ConfigurationError(
    `Edge "${edgeName}" declares \`endpointExistence\`, which is no longer an edge option.`,
    {
      code: "EDGE_INTEGRITY_OPTION_INVALID",
      edgeKind: edgeName,
      option: "endpointExistence",
      value,
    },
    {
      suggestion:
        "Delete `endpointExistence` from the edge registration. It never changed how any edge write checks its endpoints.",
    },
  );
}

/**
 * Refuses an edge registration whose `cardinality`, `targetCardinality` or
 * `acyclic` is stated with a value outside its domain, or that states the
 * removed `endpointExistence` option at all.
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
  assertRemovedEndpointExistenceNotStated(edgeName, stated.endpointExistence);
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

/**
 * The registration without an `endpointExistence` key. An explicit
 * `endpointExistence: undefined` states nothing, as an explicit `undefined`
 * does for every sibling option, so {@link assertEdgeIntegrityOptions}
 * accepts it; the key itself is dropped here so it never reaches the graph's
 * registration and everything derived from it.
 */
export function withoutRemovedEdgeOptionKeys<
  R extends Readonly<{ endpointExistence?: unknown }>,
>(registration: R): R {
  if (!Object.hasOwn(registration, "endpointExistence")) return registration;
  const { endpointExistence: _undefinedEndpointExistence, ...rest } =
    registration;
  return rest as R;
}
