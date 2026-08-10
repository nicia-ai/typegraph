import { type ReadCoordinate } from "../core/temporal";
import {
  ConfigurationError,
  NodeNotFoundError,
  ValidationError,
} from "../errors";
import { type SqlSchema } from "../query/compiler/schema";
import { sql } from "../query/sql-fragment";
import { asCompiledRowsSql } from "../query/sql-intent";
import { type KindRegistry } from "../registry/kind-registry";
import { chunk } from "../utils/array";
import { nowIso } from "../utils/date";
import { requireDefined } from "../utils/presence";
import type {
  Backend,
  IdentitySnapshot,
  RawClosureClassRow,
} from "./service-read";
import {
  compareReferences,
  containsRef,
  loadAssertions,
  loadNodeSnapshot,
  referenceCondition,
  refKey,
} from "./service-read";
import {
  identityChunkSize,
  MAX_REFERENCE_CHUNK_SIZE,
  type PlainNodeRef,
} from "./sql-target";
import { type IdentityAssertionStorageRow } from "./storage-types";
import { type IdentityRelation } from "./types";

/** @internal Exported for the stack-safety / union-by-size regression test. */
export class UnionFind {
  readonly #parents = new Map<string, string>();
  readonly #sizes = new Map<string, number>();
  readonly #refs = new Map<string, PlainNodeRef>();

  add(ref: PlainNodeRef): void {
    const key = refKey(ref);
    if (this.#parents.has(key)) return;
    this.#parents.set(key, key);
    this.#sizes.set(key, 1);
    this.#refs.set(key, ref);
  }

  // Iterative walk-then-compress: an adversarially ordered chain of unions can
  // build O(N) depth, which a recursive find would blow the stack on.
  #find(key: string): string {
    let root = key;
    for (;;) {
      const parent = this.#parents.get(root);
      if (parent === undefined) {
        throw new Error(`Unknown identity member ${root}`);
      }
      if (parent === root) break;
      root = parent;
    }
    let cursor = key;
    while (cursor !== root) {
      const next = requireDefined(
        this.#parents.get(cursor),
        `Unknown identity member ${cursor}`,
      );
      this.#parents.set(cursor, root);
      cursor = next;
    }
    return root;
  }

  // Union by size keeps trees shallow. Canonical member selection is
  // independent of root identity — components() sorts each group and takes the
  // code-point-least member — so linking by size never changes the closure.
  union(first: PlainNodeRef, second: PlainNodeRef): void {
    this.add(first);
    this.add(second);
    const firstRoot = this.#find(refKey(first));
    const secondRoot = this.#find(refKey(second));
    if (firstRoot === secondRoot) return;
    const firstSize = requireDefined(this.#sizes.get(firstRoot));
    const secondSize = requireDefined(this.#sizes.get(secondRoot));
    const [root, child] =
      firstSize >= secondSize ?
        [firstRoot, secondRoot]
      : [secondRoot, firstRoot];
    this.#parents.set(child, root);
    this.#sizes.set(root, firstSize + secondSize);
  }

  // Public root accessor for callers that maintain their own member index
  // incrementally (bulkAssertPairs) rather than re-deriving components().
  root(ref: PlainNodeRef): string {
    return this.#find(refKey(ref));
  }

  components(): ReadonlyMap<string, readonly PlainNodeRef[]> {
    const groups = new Map<string, PlainNodeRef[]>();
    for (const [key, ref] of this.#refs) {
      const root = this.#find(key);
      const group = groups.get(root) ?? [];
      group.push(ref);
      groups.set(root, group);
    }
    const byMember = new Map<string, readonly PlainNodeRef[]>();
    for (const group of groups.values()) {
      const sorted = group.toSorted((left, right) =>
        compareReferences(left, right),
      );
      for (const member of sorted) byMember.set(refKey(member), sorted);
    }
    return byMember;
  }
}

export function buildComponents(
  structuralNodes: readonly PlainNodeRef[],
  assertions: readonly Pick<
    IdentityAssertionStorageRow,
    "rel" | "a_kind" | "a_id" | "b_kind" | "b_id"
  >[],
  sameIdAcrossKinds: "fold" | "ignore",
): ReadonlyMap<string, readonly PlainNodeRef[]> {
  const unionFind = new UnionFind();
  const byId = new Map<string, PlainNodeRef[]>();
  for (const ref of structuralNodes) {
    unionFind.add(ref);
    const group = byId.get(ref.id) ?? [];
    group.push(ref);
    byId.set(ref.id, group);
  }
  if (sameIdAcrossKinds === "fold") {
    for (const group of byId.values()) {
      const first = group[0];
      if (first === undefined) continue;
      for (const member of group.slice(1)) unionFind.union(first, member);
    }
  }
  for (const assertion of assertions) {
    if (assertion.rel !== "same") continue;
    unionFind.union(
      { kind: assertion.a_kind, id: assertion.a_id },
      { kind: assertion.b_kind, id: assertion.b_id },
    );
  }
  return unionFind.components();
}

/**
 * Which node kinds an identity derivation is allowed to see: exactly the kinds
 * the graph's registry declares.
 *
 * The single owner of that filter, next to the {@link loadSnapshot} scoping it
 * feeds. Every derivation applies it, so an assertion naming a kind this schema
 * does not register is part of neither the closure nor the separation
 * projection. Anything that PREDICTS what a derivation will produce —
 * `separationRebuildRequired`, which decides whether a graph still owes
 * separation rows — has to apply the same filter, or it predicts rows the fill
 * will never write and asks for a rebuild that cannot converge.
 */
export function identityActiveKinds(
  registry: KindRegistry,
): ReadonlySet<string> {
  return new Set(registry.nodeKinds.keys());
}

export async function loadSnapshot(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  coordinate?: ReadCoordinate,
  allowedKinds?: ReadonlySet<string>,
  sameIdAcrossKinds: "fold" | "ignore" = "fold",
): Promise<IdentitySnapshot> {
  const currentInstant = nowIso();
  const [nodes, assertions] = await Promise.all([
    loadNodeSnapshot(target, schema, graphId, coordinate),
    loadAssertions(target, schema, graphId, coordinate, currentInstant),
  ]);
  const scopedNodes =
    allowedKinds === undefined ? nodes : (
      nodes.filter((node) => allowedKinds.has(node.ref.kind))
    );
  const scopedAssertions =
    allowedKinds === undefined ? assertions : (
      assertions.filter(
        (assertion) =>
          allowedKinds.has(assertion.a_kind) &&
          allowedKinds.has(assertion.b_kind),
      )
    );
  const structuralNodes = scopedNodes
    .filter((node) => node.deletedAt === undefined)
    .map((node) => node.ref);
  return {
    nodes: scopedNodes,
    structuralNodes,
    assertions: scopedAssertions,
    components: buildComponents(
      structuralNodes,
      scopedAssertions,
      sameIdAcrossKinds,
    ),
  };
}

export function componentFor(
  snapshot: IdentitySnapshot,
  ref: PlainNodeRef,
): readonly PlainNodeRef[] {
  return snapshot.components.get(refKey(ref)) ?? [ref];
}

function sameComponent(
  snapshot: IdentitySnapshot,
  first: PlainNodeRef,
  second: PlainNodeRef,
): boolean {
  return containsRef(componentFor(snapshot, first), second);
}

function kindsOf(members: readonly PlainNodeRef[]): ReadonlySet<string> {
  return new Set(members.map((member) => member.kind));
}

/**
 * Disjointness is a property of kinds, not of members, so an identity class of
 * n members carries at most as many distinct kinds as the registry declares.
 * Collapsing each class to its kind set before the pairwise scan keeps the check
 * quadratic in kinds instead of in class size. `Set` preserves first-insertion
 * order, so the reported pair is the same one the member-pair scan found.
 */
export function classHasDisjointKinds(
  registry: KindRegistry,
  first: readonly PlainNodeRef[],
  second: readonly PlainNodeRef[],
): readonly [string, string] | undefined {
  return kindSetsHaveDisjointKinds(registry, kindsOf(first), kindsOf(second));
}

export function kindSetsHaveDisjointKinds(
  registry: KindRegistry,
  first: ReadonlySet<string>,
  second: ReadonlySet<string>,
): readonly [string, string] | undefined {
  for (const left of first) {
    for (const right of second) {
      if (registry.areDisjoint(left, right)) return [left, right];
    }
  }
  return undefined;
}

export type DifferentAssertionIndex = Map<
  string,
  Map<string, IdentityAssertionStorageRow>
>;

export function indexDifferentAssertion(
  index: DifferentAssertionIndex,
  firstRoot: string,
  secondRoot: string,
  assertion: IdentityAssertionStorageRow,
): void {
  const firstNeighbors =
    index.get(firstRoot) ?? new Map<string, IdentityAssertionStorageRow>();
  const secondNeighbors =
    index.get(secondRoot) ?? new Map<string, IdentityAssertionStorageRow>();
  if (!firstNeighbors.has(secondRoot)) {
    firstNeighbors.set(secondRoot, assertion);
  }
  if (!secondNeighbors.has(firstRoot)) {
    secondNeighbors.set(firstRoot, assertion);
  }
  index.set(firstRoot, firstNeighbors);
  index.set(secondRoot, secondNeighbors);
}

export function mergeDifferentAssertionRoots(
  index: DifferentAssertionIndex,
  survivingRoot: string,
  retiredRoot: string,
): void {
  const survivingNeighbors =
    index.get(survivingRoot) ?? new Map<string, IdentityAssertionStorageRow>();
  const retiredNeighbors = index.get(retiredRoot);
  survivingNeighbors.delete(retiredRoot);
  if (retiredNeighbors !== undefined) {
    for (const [neighborRoot, assertion] of retiredNeighbors) {
      if (neighborRoot === survivingRoot) continue;
      const canonicalAssertion =
        survivingNeighbors.get(neighborRoot) ?? assertion;
      survivingNeighbors.set(neighborRoot, canonicalAssertion);
      const neighborMap = index.get(neighborRoot);
      if (neighborMap !== undefined) {
        neighborMap.delete(retiredRoot);
        neighborMap.set(survivingRoot, canonicalAssertion);
      }
    }
  }
  index.delete(retiredRoot);
  if (survivingNeighbors.size === 0) {
    index.delete(survivingRoot);
  } else {
    index.set(survivingRoot, survivingNeighbors);
  }
}

export function validateSnapshotIntegrity(
  snapshot: IdentitySnapshot,
  registry: KindRegistry,
  graphId: string,
): void {
  const structuralKeys = new Set(
    snapshot.structuralNodes.map((ref) => refKey(ref)),
  );
  for (const assertion of snapshot.assertions) {
    const a = { kind: assertion.a_kind, id: assertion.a_id };
    const b = { kind: assertion.b_kind, id: assertion.b_id };
    if (!structuralKeys.has(refKey(a)) || !structuralKeys.has(refKey(b))) {
      throw new ConfigurationError(
        "Operational Identity contains a current assertion with a missing or deleted endpoint.",
        {
          code: "IDENTITY_SCHEMA_CONTRADICTION",
          graphId,
          assertionId: assertion.id,
          a,
          b,
        },
      );
    }
    if (assertion.rel === "different" && sameComponent(snapshot, a, b)) {
      throw new ConfigurationError(
        "Operational Identity contains a different assertion within one identity class.",
        {
          code: "IDENTITY_SCHEMA_CONTRADICTION",
          graphId,
          assertionId: assertion.id,
          a,
          b,
        },
      );
    }
  }

  const visited = new Set<string>();
  for (const [memberKey, component] of snapshot.components) {
    if (visited.has(memberKey)) continue;
    for (const member of component) visited.add(refKey(member));
    // Self-pairs are safe to include: `areDisjoint(kind, kind)` is false by
    // construction, so scanning the component's kind set against itself finds
    // exactly the member pairs an upper-triangle member scan would.
    const conflictingKinds = classHasDisjointKinds(
      registry,
      component,
      component,
    );
    if (conflictingKinds !== undefined) {
      throw new ConfigurationError(
        "Operational Identity class conflicts with ontology disjointness.",
        {
          code: "IDENTITY_SCHEMA_CONTRADICTION",
          graphId,
          classMembers: component,
          conflictingKinds,
        },
      );
    }
  }
}

type RawClosureRow = RawClosureClassRow &
  Readonly<{ class_kind: string; class_id: string }>;

export function closureMismatchError(
  graphId: string,
  detail: Record<string, unknown>,
): ConfigurationError {
  return new ConfigurationError(
    "Operational Identity materialized closure does not match computed identity components.",
    { code: "IDENTITY_SCHEMA_CONTRADICTION", graphId, ...detail },
    {
      suggestion:
        "Run rebuildIdentityClosure(store) to rebuild the materialized identity closure.",
    },
  );
}

/**
 * Asserts the persisted `identityClosureTable` matches the closure the engine
 * derives from the current snapshot, so a stale or corrupted materialized
 * closure — which every current read trusts — cannot pass verification
 * silently. The expected rows are emitted by the same rule as
 * {@link insertClosureComponents}: only components with two or more members
 * carry rows, each member labeled with the component's code-point-least member;
 * singletons carry none.
 */
export async function assertClosureMatchesComponents(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  components: ReadonlyMap<string, readonly PlainNodeRef[]>,
): Promise<void> {
  const expected = new Map<
    string,
    Readonly<{ member: PlainNodeRef; classRef: PlainNodeRef }>
  >();
  const emitted = new Set<string>();
  for (const [memberKey, component] of components) {
    if (emitted.has(memberKey) || component.length < 2) continue;
    const canonical = requireDefined(component[0]);
    for (const member of component) {
      const key = refKey(member);
      emitted.add(key);
      expected.set(key, { member, classRef: canonical });
    }
  }

  const rows = await target.execute<RawClosureRow>(
    asCompiledRowsSql(sql`
      SELECT member_kind, member_id, class_kind, class_id
      FROM ${schema.identityClosureTable}
      WHERE graph_id = ${graphId}
    `),
  );
  const seen = new Set<string>();
  for (const row of rows) {
    const member = { kind: row.member_kind, id: row.member_id };
    const memberKey = refKey(member);
    const match = expected.get(memberKey);
    if (
      match?.classRef.kind !== row.class_kind ||
      match.classRef.id !== row.class_id
    ) {
      throw closureMismatchError(graphId, {
        member,
        class: { kind: row.class_kind, id: row.class_id },
        expectedClass: match?.classRef,
      });
    }
    seen.add(memberKey);
  }
  for (const [memberKey, { member, classRef }] of expected) {
    if (seen.has(memberKey)) continue;
    throw closureMismatchError(graphId, {
      member,
      expectedClass: classRef,
      reason: "missing-closure-row",
    });
  }
}

export function selfAssertionError(
  relation: IdentityRelation,
): ValidationError {
  return new ValidationError(
    `Identity ${relation} assertions require two distinct node references.`,
    {
      issues: [
        {
          path: "pair",
          message: "Identity self-assertions are not allowed",
          code: "IDENTITY_SELF_ASSERTION",
        },
      ],
    },
    {
      suggestion:
        "Filter reflexive pairs before calling an identity assertion method.",
    },
  );
}

export async function requireLiveEndpoint(
  target: Backend,
  graphId: string,
  ref: PlainNodeRef,
): Promise<void> {
  const row = await target.getNode(graphId, ref.kind, ref.id);
  if (row === undefined || row.deleted_at !== undefined) {
    throw new NodeNotFoundError(ref.kind, ref.id);
  }
}

export async function loadLiveReferences(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<readonly PlainNodeRef[]> {
  if (references.length === 0) return [];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  if (references.length > chunkSize) {
    const byKey = new Map<string, PlainNodeRef>();
    for (const refChunk of chunk(references, chunkSize)) {
      const live = await loadLiveReferences(target, schema, graphId, refChunk);
      for (const ref of live) byKey.set(refKey(ref), ref);
    }
    return [...byKey.values()];
  }
  const matches = referenceCondition(sql`kind`, sql`id`, references);
  const rows = await target.execute<Readonly<{ kind: string; id: string }>>(
    asCompiledRowsSql(sql`
      SELECT kind, id
      FROM ${schema.nodesTable}
      WHERE graph_id = ${graphId}
        AND deleted_at IS NULL
        AND ${matches}
    `),
  );
  return rows.map((row) => ({ kind: row.kind, id: row.id }));
}

export async function requireLiveEndpoints(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<void> {
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const ref of references) uniqueByKey.set(refKey(ref), ref);
  const live = await loadLiveReferences(target, schema, graphId, references);
  const liveKeys = new Set(live.map((ref) => refKey(ref)));
  for (const [key, ref] of uniqueByKey) {
    if (!liveKeys.has(key)) throw new NodeNotFoundError(ref.kind, ref.id);
  }
}

/**
 * Requires every reference to name a node ROW — deleted or not. Ended
 * assertions take the raw-INSERT import branch and never touch the closure,
 * but historical reconstruction still conducts identity through them, so an
 * endpoint that never existed would become a phantom bridge: two real nodes
 * reporting `areSame` at an `asOf` coordinate via a node no one ever wrote.
 * The store's own archival exports satisfy this by construction (hard
 * deletion removes the assertions touching the node), so only hand-built
 * documents are refused.
 */
export async function requireStructuralEndpoints(
  target: Backend,
  schema: SqlSchema,
  graphId: string,
  references: readonly PlainNodeRef[],
): Promise<void> {
  if (references.length === 0) return;
  const uniqueByKey = new Map<string, PlainNodeRef>();
  for (const ref of references) uniqueByKey.set(refKey(ref), ref);
  const unique = [...uniqueByKey.values()];
  const chunkSize = identityChunkSize(target, {
    fixedParameters: 1,
    maxItems: MAX_REFERENCE_CHUNK_SIZE,
    parametersPerItem: 2,
  });
  const presentKeys = new Set<string>();
  for (const refChunk of chunk(unique, chunkSize)) {
    const matches = referenceCondition(sql`kind`, sql`id`, refChunk);
    const rows = await target.execute<Readonly<{ kind: string; id: string }>>(
      asCompiledRowsSql(sql`
        SELECT kind, id
        FROM ${schema.nodesTable}
        WHERE graph_id = ${graphId}
          AND ${matches}
      `),
    );
    for (const row of rows) {
      presentKeys.add(refKey({ kind: row.kind, id: row.id }));
    }
  }
  for (const [key, ref] of uniqueByKey) {
    if (!presentKeys.has(key)) throw new NodeNotFoundError(ref.kind, ref.id);
  }
}
