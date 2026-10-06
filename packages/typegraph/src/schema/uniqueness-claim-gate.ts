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
 *   value is accepted. This holds for a kind the commit adds as well: rows a
 *   dropped kind left behind (`discardDroppedKindRows`) become live again under
 *   a re-added kind of the same name, with no claim.
 * - A `kindWithSubClasses` constraint writes at the code-point minimum of the
 *   kind's subclass component and probes that component. Claims of one kind
 *   can sit at any axis of any component it belonged to while populated: a
 *   merge moves where NEW claims are written without moving old ones. So a
 *   component that loses a member sorting before the kind — a removed
 *   `subClassOf` / `equivalentTo`, a removed kind — may leave claims at an axis
 *   the kind no longer probes, whichever member was the minimum when the
 *   previous schema was written. A lost member sorting after the kind cannot
 *   hold its claims: the kind is always in its own component, so every axis it
 *   was ever written at is at or before the kind.
 *
 * Neither can be repaired inside a schema commit, so both are refused while
 * the kind holds rows. A kind with no rows has no claims to strand and is
 * unaffected.
 */
import { schemaKindHasRows } from "../backend/schema-kind-emptiness";
import { type SchemaCommitPreflightBackend } from "../backend/types";
import { MigrationError } from "../errors";
import { type KindRegistry } from "../registry/kind-registry";
import { uniquenessClaimAxis } from "../store/claims/axis";
import { compareCodePoints, compareStrings } from "../utils/compare";
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
 * `lostKinds`, on a moved axis, are the members of the kind's subclass
 * component under the previous schema that sort before the kind and are no
 * longer in it: claims of existing rows may sit at any of their axes, which the
 * kind no longer probes.
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
      lostKinds: readonly string[];
    }>;

/** A unique constraint a node kind declares in `after`. */
type DeclaredKindConstraint = Readonly<{
  kind: string;
  constraint: SerializedUniqueConstraint;
  change: UniqueConstraintEnforcementChange | undefined;
}>;

/**
 * Every unique constraint `after` declares on a node kind, with how its
 * declaration changed. A kind `before` lacks has no declaration to compare, so
 * each of its constraints reads as added: the kind may still own rows a
 * previous removal left in the table.
 */
export function declaredKindUniqueConstraints(
  before: OntologySnapshot,
  after: OntologySnapshot,
): readonly DeclaredKindConstraint[] {
  return Object.entries(after.nodes)
    .toSorted(([left], [right]) => compareStrings(left, right))
    .flatMap(([kind, afterDef]) => {
      const existing =
        hasOwnKey(before.nodes, kind) ?
          (before.nodes[kind]?.uniqueConstraints ?? [])
        : [];
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
  constraints: readonly DeclaredKindConstraint[],
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
 * An unchanged constraint is gated exactly when the proposed component lost a
 * member that sorts before the kind. A claim sits at the code-point minimum of
 * the component it was written under, which contains the kind itself, so it
 * sits at the kind or at a member before it. A component that only GAINS
 * members, or loses only later ones, keeps every such axis inside it: a merge
 * moves where new claims are written without hiding the old ones. Once an
 * earlier member is lost, the axis of any earlier claim may be the lost one,
 * and the previous schema's own axis does not tell which — an earlier merge
 * leaves claims at more than one.
 */
export function uniquenessClaimGates(
  constraints: readonly DeclaredKindConstraint[],
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
      if (constraint.scope === "kind") return [];
      const proposedComponent = afterRegistry.getSubClassComponent(kind);
      const lostKinds = beforeRegistry
        .getSubClassComponent(kind)
        .filter(
          (member) =>
            compareCodePoints(member, kind) < 0 &&
            !proposedComponent.includes(member),
        );
      if (lostKinds.length === 0) return [];
      return [{ ...named, cause: "claim-axis-moved", lostKinds }];
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
    return `${subject} (no longer shares a subclass component with ${gate.lostKinds.map((lost) => `"${lost}"`).join(", ")}; claim axis "${gate.axis}")`;
  }
  return `${subject} (${gate.cause === "constraint-added" ? "added" : "reshaped"}, claim axis "${gate.axis}")`;
}

/**
 * Refuses when any gated kind holds rows. Asks the same question over the
 * same row population `Store.evolve` requires to be empty before it accepts a
 * unique constraint on a graph-extension kind, through the same probe.
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
    const populated = await schemaKindHasRows(target, transition.graphId, {
      entity: "node",
      kind,
      rows: "nonDeleted",
    });
    if (populated) populatedKinds.add(kind);
  }
  const closed = gates.filter((gate) => populatedKinds.has(gate.kind));
  if (closed.length === 0) return;
  throw new MigrationError(
    `Schema change refused: it would leave a uniqueness constraint unenforced over existing rows of ${[...populatedKinds].map((kind) => `"${kind}"`).join(", ")}. ` +
      `${closed.map((gate) => describeGate(gate)).join("; ")}. ` +
      "A schema commit does not validate existing rows against a unique constraint or rebuild its claims. " +
      "Declare the constraint, and the subclass hierarchy it spans, before the kind holds rows; " +
      "otherwise delete the kind's rows (for a re-added kind, run store.materializeRemovals() to reclaim rows its removal left), commit the schema, then write them again.",
    {
      graphId: transition.graphId,
      fromVersion: transition.fromVersion,
      toVersion: transition.toVersion,
      reason: "unique-constraint-requires-empty-kind",
      constraints: closed,
    },
  );
}
