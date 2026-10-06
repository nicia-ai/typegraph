/**
 * The schema transitions that would leave a uniqueness constraint unenforced
 * over rows that already exist, and the refusal a commit owes for them.
 *
 * A uniqueness constraint is enforced by claim rows: each node write reserves
 * `(axis, constraint, key)` and probes the axes its scope covers. A schema
 * commit rewrites no claim rows, so two kinds of transition strand existing
 * rows outside the fence:
 *
 * - A constraint that is added or reshaped has no claim row for any existing
 *   node, so pre-existing duplicates stay and a new node duplicating an old
 *   value is accepted.
 * - A `kindWithSubClasses` constraint writes at the code-point minimum of the
 *   kind's subclass component and probes that component. When the component
 *   changes so that the axis existing claims sit at is no longer one the kind
 *   probes — a removed `subClassOf` / `equivalentTo`, or a removed kind that
 *   was the minimum — later writes cannot see those claims.
 *
 * Neither can be repaired inside a schema commit, so both are refused while
 * the kind holds rows. A kind with no rows has no claims to strand and is
 * unaffected.
 */
import { countSchemaKindRows } from "../backend/schema-kind-emptiness";
import { type SchemaCommitPreflightBackend } from "../backend/types";
import { MigrationError } from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import { uniquenessClaimAxis } from "../store/claims/axis";
import { compareStrings } from "../utils/compare";
import { hasOwnKey } from "../utils/object";
import { type OntologySnapshot } from "./ontology-change";
import { type SerializedUniqueConstraint } from "./types";
import {
  type UniqueConstraintEnforcementChange,
  uniqueConstraintEnforcementChange,
} from "./unique-constraint-change";

/**
 * One uniqueness constraint a schema transition can only publish while the
 * kind declaring it holds no rows.
 *
 * `axis` is the claim axis the proposed schema writes the constraint at.
 * `previousAxis`, on a moved axis, is where the claims of existing rows sit:
 * an axis the kind no longer probes under the proposed schema.
 */
export type UniquenessClaimGate =
  | Readonly<{
      cause: "constraint-added" | "constraint-reshaped";
      kind: string;
      constraintName: string;
      axis: string;
    }>
  | Readonly<{
      cause: "claim-axis-moved";
      kind: string;
      constraintName: string;
      axis: string;
      previousAxis: string;
    }>;

/** A unique constraint a kind present on both sides declares in `after`. */
type SurvivingKindConstraint = Readonly<{
  kind: string;
  constraint: SerializedUniqueConstraint;
  change: UniqueConstraintEnforcementChange | undefined;
}>;

/**
 * Every unique constraint `after` declares on a node kind `before` also has,
 * with how its declaration changed. A kind absent from `before` is skipped:
 * it cannot hold rows the commit would strand.
 */
export function survivingKindUniqueConstraints(
  before: OntologySnapshot,
  after: OntologySnapshot,
): readonly SurvivingKindConstraint[] {
  return Object.entries(after.nodes)
    .toSorted(([left], [right]) => compareStrings(left, right))
    .flatMap(([kind, afterDef]) => {
      if (!hasOwnKey(before.nodes, kind)) return [];
      const existing = before.nodes[kind]?.uniqueConstraints ?? [];
      return afterDef.uniqueConstraints.map((constraint) => ({
        kind,
        constraint,
        change: uniqueConstraintEnforcementChange(existing, constraint),
      }));
    });
}

/**
 * Whether a transition can gate anything at all, decided without building a
 * registry: a declaration changed, or the ontology changed under an
 * unchanged `kindWithSubClasses` constraint (the only scope whose axis the
 * ontology decides).
 */
export function mayGateUniquenessClaims(
  constraints: readonly SurvivingKindConstraint[],
  ontologyChanged: boolean,
): boolean {
  return constraints.some(
    ({ change, constraint }) =>
      change !== undefined ||
      (ontologyChanged && constraint.scope === "kindWithSubClasses"),
  );
}

/**
 * The gates a transition owes, in `(kind, constraint)` order.
 *
 * An unchanged constraint is gated exactly when the axis its existing claims
 * sit at falls outside the component the proposed schema probes. A component
 * that only GAINS members keeps the old axis inside it, so a merge moves
 * where new claims are written without hiding the old ones and is not gated.
 */
export function uniquenessClaimGates(
  constraints: readonly SurvivingKindConstraint[],
  beforeRegistry: KindRegistry,
  afterRegistry: KindRegistry,
): readonly UniquenessClaimGate[] {
  return constraints.flatMap(
    ({ kind, constraint, change }): readonly UniquenessClaimGate[] => {
      const axis = uniquenessClaimAxis(kind, constraint.scope, afterRegistry);
      const named = { kind, constraintName: constraint.name, axis };
      if (change !== undefined) {
        return [
          {
            ...named,
            cause:
              change === "added" ? "constraint-added" : "constraint-reshaped",
          },
        ];
      }
      const previousAxis = uniquenessClaimAxis(
        kind,
        constraint.scope,
        beforeRegistry,
      );
      if (
        constraint.scope === "kind" ||
        afterRegistry.getSubClassComponent(kind).includes(previousAxis)
      ) {
        return [];
      }
      return [{ ...named, cause: "claim-axis-moved", previousAxis }];
    },
  );
}

type SchemaVersionTransition = Readonly<{
  graphId: string;
  fromVersion: number;
  toVersion: number;
}>;

function describeGate(gate: UniquenessClaimGate): string {
  const subject = `"${gate.constraintName}" on "${gate.kind}"`;
  if (gate.cause === "claim-axis-moved") {
    return `${subject} (claim axis moves from "${gate.previousAxis}" to "${gate.axis}")`;
  }
  return `${subject} (${gate.cause === "constraint-added" ? "added" : "reshaped"}, claim axis "${gate.axis}")`;
}

/**
 * Refuses when any gated kind holds rows. Counts the same row population
 * `Store.evolve` requires to be empty before it accepts a unique constraint
 * on a graph-extension kind, through the same counter.
 *
 * @throws MigrationError (`reason: "unique-constraint-requires-empty-kind"`)
 *   naming every gate whose kind is populated.
 */
export async function assertUniquenessClaimGatesOpen(
  target: SchemaCommitPreflightBackend,
  transition: SchemaVersionTransition,
  gates: readonly UniquenessClaimGate[],
): Promise<void> {
  const populatedKinds = new Set<string>();
  for (const kind of new Set(gates.map((gate) => gate.kind))) {
    const count = await countSchemaKindRows(target, transition.graphId, {
      entity: "node",
      kind,
      rows: "nonDeleted",
    });
    if (count > 0) populatedKinds.add(kind);
  }
  const closed = gates.filter((gate) => populatedKinds.has(gate.kind));
  if (closed.length === 0) return;
  throw new MigrationError(
    `Schema change refused: it would leave a uniqueness constraint unenforced over existing rows of ${[...populatedKinds].map((kind) => `"${kind}"`).join(", ")}. ` +
      `${closed.map((gate) => describeGate(gate)).join("; ")}. ` +
      "A schema commit does not validate existing rows against a unique constraint or rebuild its claims. " +
      "Declare the constraint, and the subclass hierarchy it spans, before the kind holds rows; " +
      "otherwise delete the kind's rows, commit the schema, then write them again.",
    {
      graphId: transition.graphId,
      fromVersion: transition.fromVersion,
      toVersion: transition.toVersion,
      reason: "unique-constraint-requires-empty-kind",
      constraints: closed,
    },
  );
}
