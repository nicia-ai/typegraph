/**
 * The one declaration of TypeGraph's graph-scoped relations: every bundled
 * table whose rows carry a `graph_id` column.
 *
 * Clearing a graph, forking a graph namespace, cloning a PostgreSQL working
 * copy, probing a graph id for occupancy and reading a graph's storage
 * inventory all need to know which relations hold one graph's rows. They used
 * to spell that set independently, which is how a relation added for one
 * consumer could be silently missed by another. Each consumer now reads this
 * declaration and takes from it only the facts it legitimately differs on:
 *
 *  - `clear`: how `Store.clear()` removes the relation and in what order;
 *  - `workingCopyClonePolicy`: what a PostgreSQL working copy does with it;
 *  - `role`: whether the rows are graph content or per-graph bookkeeping;
 *  - `presenceAnchor`: whether a row here is what makes a graph "hold data" for
 *    the graph id listing.
 *
 * The relations are identified by their logical key (`nodes`, `edges`, ...),
 * the same key the Drizzle table factories and `SqlTableNames` use, so custom
 * physical table names are resolved per backend by {@link
 * resolveGraphRelationNames} rather than assumed.
 *
 * Not in this inventory, on purpose: the deployment-shared `fences`,
 * `baseSchemaVersions` and `graphTemplates` relations carry no `graph_id`
 * column, and the per-`(kind, field)` vector tables are owned by the active
 * vector strategy and enumerated from a graph's vector slots. A ratchet test
 * fails when a bundled table gains a `graph_id` column without being
 * classified here.
 */
import { requireDefined } from "../utils/presence";
import { defaultPostgresTableNames } from "./drizzle/schema/postgres-table-names";
import type { TableContribution } from "./table-contribution";

/** The column every graph-scoped relation is keyed by. */
export const GRAPH_ID_COLUMN = "graph_id";

/**
 * Logical keys of the graph-scoped relations, in declaration order.
 *
 * The order is the order a namespace fork copies and digests relations in. It
 * is part of the fork's durable content digest, so it must not be reshuffled
 * for tidiness; `clear.order` carries the (different) deletion order.
 */
export const GRAPH_RELATION_KEYS = [
  "nodes",
  "edges",
  "recordedNodes",
  "recordedEdges",
  "recordedClock",
  "revisionOrigins",
  "revisionChanges",
  "identityAssertions",
  "recordedIdentityAssertions",
  "identityClosure",
  "identitySeparation",
  "uniques",
  "edgeClaims",
  "schemaVersions",
  "fulltext",
  "indexMaterializations",
  "contributionMaterializations",
  "kindRemovals",
  "reconciliationMarkers",
] as const;

export type GraphRelationKey = (typeof GRAPH_RELATION_KEYS)[number];

/**
 * How `Store.clear()` disposes of one relation's rows for the cleared graph.
 *
 *  - `delete`: a `DELETE ... WHERE graph_id = ?` issued in ascending `order`.
 *    `missingTable: "tolerated"` marks a relation that is provisioned lazily
 *    (or after first boot), so a database that never created it must not fail
 *    the clear. `preservable` marks a relation `Store.clear()` may keep when it
 *    retains initialized storage for immediate reuse.
 *  - `fulltextStrategy`: the delete is owned by the active fulltext strategy
 *    (the table is database-shared and does not exist without a strategy).
 *
 * `revisionOrigins` is an ordinary delete for every clear, whether or not the
 * clearing store mints origin-namespaced tokens: another store on the same
 * database may have minted the row, and a row left behind would keep the
 * graph occupied and let a repopulated graph match a pre-clear token.
 * `Store.clear()` additionally rotates the row itself for a backend whose own
 * `clearGraph` does not consume this inventory.
 *
 * Deletion order carries two constraints. Relations that name rows of another
 * relation (`uniques` and `edgeClaims`, which name the nodes and edges that
 * hold them) are emptied BEFORE the relation they point into. And the revision
 * journal is emptied AFTER every relation whose deletes its triggers observe,
 * or those deletes would journal new rows behind the cleanup.
 */
type GraphRelationClearBehavior =
  | Readonly<{
      kind: "delete";
      order: number;
      missingTable: "required" | "tolerated";
      preservable?: true;
    }>
  | Readonly<{ kind: "fulltextStrategy"; order: number }>;

/**
 * `content` rows are written by applications or derived from those writes.
 * `bookkeeping` rows are per-graph metadata TypeGraph maintains about the
 * graph's schema and storage; a graph id that holds only bookkeeping is not
 * evidence that an application used it.
 */
type GraphRelationRole = "content" | "bookkeeping";

type GraphRowsClonePolicy = Extract<
  NonNullable<TableContribution["workingCopyClonePolicy"]>,
  { kind: "graphRows" }
>;
type RebuildAfterClonePolicy = Extract<
  NonNullable<TableContribution["workingCopyClonePolicy"]>,
  { kind: "rebuildAfterClone" }
>;

type GraphRelationBehavior = Readonly<{
  clear: GraphRelationClearBehavior;
  role: GraphRelationRole;
  /**
   * A row in this relation is what makes a graph count as holding data, so the
   * graph id listing anchors on it. Every graph that holds data has a row in
   * each anchor, and the default `Store.clear()` empties each anchor (it is a
   * `delete` that is not `preservable`), so a cleared graph stops being listed.
   * Anchors also lead their primary key with `graph_id`, which is what lets the
   * listing step from one graph id to the next by index seek. A test holds all
   * three properties.
   */
  presenceAnchor?: true;
  /**
   * The stack that creates the relation. `"fulltext"` relations exist only on a
   * backend with the fulltext stack enabled; a consumer that reads every
   * relation unconditionally must select with {@link graphRelationsProvisionedBy}.
   */
  provisionedBy: "base" | "fulltext";
  /**
   * The PostgreSQL working-copy decision. `fulltext` carries the policy of the
   * bundled strategies; a strategy declares its own on its contribution, which
   * a test holds equal to this one.
   */
  workingCopyClonePolicy: GraphRowsClonePolicy | RebuildAfterClonePolicy;
}>;

export type GraphRelationDeclaration = GraphRelationBehavior &
  Readonly<{ key: GraphRelationKey }>;

const COPY_GRAPH_ROWS = {
  kind: "graphRows",
  graphIdColumn: GRAPH_ID_COLUMN,
} as const satisfies GraphRowsClonePolicy;

const REBUILD_AFTER_CLONE = {
  kind: "rebuildAfterClone",
} as const satisfies RebuildAfterClonePolicy;

const BEHAVIOR = {
  nodes: {
    clear: { kind: "delete", order: 12, missingTable: "required" },
    role: "content",
    presenceAnchor: true,
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  edges: {
    clear: { kind: "delete", order: 11, missingTable: "required" },
    role: "content",
    presenceAnchor: true,
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  recordedNodes: {
    clear: { kind: "delete", order: 4, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  recordedEdges: {
    clear: { kind: "delete", order: 3, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  recordedClock: {
    clear: { kind: "delete", order: 5, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  revisionOrigins: {
    clear: { kind: "delete", order: 19, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  revisionChanges: {
    clear: { kind: "delete", order: 13, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  identityAssertions: {
    clear: { kind: "delete", order: 8, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  recordedIdentityAssertions: {
    clear: { kind: "delete", order: 2, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  identityClosure: {
    clear: { kind: "delete", order: 7, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  identitySeparation: {
    clear: { kind: "delete", order: 6, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  uniques: {
    clear: { kind: "delete", order: 9, missingTable: "required" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  edgeClaims: {
    clear: { kind: "delete", order: 10, missingTable: "tolerated" },
    role: "content",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  schemaVersions: {
    clear: { kind: "delete", order: 18, missingTable: "required" },
    role: "bookkeeping",
    presenceAnchor: true,
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  fulltext: {
    clear: { kind: "fulltextStrategy", order: 1 },
    role: "content",
    provisionedBy: "fulltext",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  indexMaterializations: {
    clear: { kind: "delete", order: 14, missingTable: "required" },
    role: "bookkeeping",
    provisionedBy: "base",
    workingCopyClonePolicy: REBUILD_AFTER_CLONE,
  },
  contributionMaterializations: {
    clear: {
      kind: "delete",
      order: 17,
      missingTable: "tolerated",
      preservable: true,
    },
    role: "bookkeeping",
    provisionedBy: "base",
    workingCopyClonePolicy: REBUILD_AFTER_CLONE,
  },
  kindRemovals: {
    clear: { kind: "delete", order: 15, missingTable: "required" },
    role: "bookkeeping",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
  reconciliationMarkers: {
    clear: { kind: "delete", order: 16, missingTable: "required" },
    role: "bookkeeping",
    provisionedBy: "base",
    workingCopyClonePolicy: COPY_GRAPH_ROWS,
  },
} as const satisfies Readonly<Record<GraphRelationKey, GraphRelationBehavior>>;

/** Every graph-scoped relation, in declaration order. */
export const GRAPH_RELATIONS: readonly GraphRelationDeclaration[] =
  GRAPH_RELATION_KEYS.map((key) => ({ key, ...BEHAVIOR[key] }));

const DECLARATIONS_BY_KEY: ReadonlyMap<
  GraphRelationKey,
  GraphRelationDeclaration
> = new Map(GRAPH_RELATIONS.map((relation) => [relation.key, relation]));

export function isGraphRelationKey(value: string): value is GraphRelationKey {
  return Object.hasOwn(BEHAVIOR, value);
}

export function graphRelationDeclaration(
  key: GraphRelationKey,
): GraphRelationDeclaration {
  return requireDefined(
    DECLARATIONS_BY_KEY.get(key),
    `Graph relation ${key} is not declared.`,
  );
}

/**
 * The relations a backend provisions, in declaration order. Only the fulltext
 * relation depends on backend configuration.
 */
export function graphRelationsProvisionedBy(
  stack: Readonly<{ fulltext: boolean }>,
): readonly GraphRelationDeclaration[] {
  return GRAPH_RELATIONS.filter(
    (relation) => relation.provisionedBy === "base" || stack.fulltext,
  );
}

/**
 * The relations the graph id listing anchors on, in declaration order: the
 * relations whose rows mean a graph holds data and that a default
 * `Store.clear()` empties.
 */
export const GRAPH_PRESENCE_ANCHOR_KEYS: readonly GraphRelationKey[] =
  GRAPH_RELATIONS.filter((relation) => relation.presenceAnchor === true).map(
    (relation) => relation.key,
  );

/** A relation `Store.clear()` empties with a graph-scoped statement. */
export type GraphRelationClearStep = Readonly<{
  key: GraphRelationKey;
  clear: GraphRelationClearBehavior;
}>;

/** The relations `Store.clear()` deletes, in the order it deletes them. */
export const GRAPH_RELATION_CLEAR_SEQUENCE: readonly GraphRelationClearStep[] =
  GRAPH_RELATIONS.map((relation) => ({
    key: relation.key,
    clear: relation.clear,
  })).toSorted((left, right) => left.clear.order - right.clear.order);

/** Physical table names keyed by graph-relation key. */
export type GraphRelationNames = Readonly<Record<GraphRelationKey, string>>;

/**
 * The physical names a backend gave the graph-scoped relations. Unstated names
 * resolve to the bundled defaults, exactly as `createSqlSchema` resolves the
 * relations it knows.
 */
export type GraphRelationNameSource = Readonly<
  Partial<Record<GraphRelationKey, string | undefined>>
>;

export function resolveGraphRelationNames(
  names: GraphRelationNameSource | undefined,
): GraphRelationNames {
  return Object.fromEntries(
    GRAPH_RELATION_KEYS.map((key) => [
      key,
      names?.[key] ?? defaultPostgresTableNames[key],
    ]),
  ) as GraphRelationNames;
}
