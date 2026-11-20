/**
 * The property-graph shape the Neo4j driver builds from the LDBC rows: each
 * node kind's labels and properties and each relationship kind's type and
 * endpoints. Both load paths read it (the offline `neo4j-admin` import in
 * `./neo4j.ts` and the online `UNWIND` load in `./neo4j-online-load.ts`),
 * so the graph they produce, and therefore what the queries run against,
 * cannot drift apart between a container run and an existing-server run.
 *
 * Every property is a string, as it is in the LDBC rows: a native Neo4j
 * date/datetime would round-trip through neo4j-driver as a different JS type
 * than the ISO-8601 string every other engine returns.
 */

/**
 * Every node kind's labels and string properties, shared by both load paths
 * so the offline import (CSV headers, `--nodes=` labels) and the online
 * `UNWIND` writes cannot drift into different graphs. `id` comes first and
 * becomes the importer's `:ID` column, which neo4j-admin also keeps as an
 * ordinary `id` property.
 */
export const NEO4J_NODE_KINDS = {
  person: {
    labels: ["Person"],
    properties: [
      "id",
      "firstName",
      "lastName",
      "gender",
      "birthday",
      "creationDate",
      "locationIp",
      "browserUsed",
      "cityId",
    ],
  },
  forum: {
    labels: ["Forum"],
    properties: ["id", "title", "creationDate", "moderatorId"],
  },
  post: {
    labels: ["Post", "Message"],
    properties: ["id", "content", "creationDate"],
  },
  comment: {
    labels: ["Comment", "Message"],
    properties: ["id", "content", "creationDate"],
  },
} as const satisfies Record<
  string,
  Readonly<{ labels: readonly string[]; properties: readonly string[] }>
>;

export type Neo4jNodeKind = keyof typeof NEO4J_NODE_KINDS;
export type Neo4jNodeRow = Readonly<Record<string, string>>;

/** neo4j-admin's header for a node file: `id:ID` then `name:string` columns. */
export function importHeader(kind: Neo4jNodeKind): readonly string[] {
  return NEO4J_NODE_KINDS[kind].properties.map((property) =>
    property === "id" ? "id:ID" : `${property}:string`,
  );
}

/** A node row's property values, in `NEO4J_NODE_KINDS` order. */
export function nodeValues(
  kind: Neo4jNodeKind,
  row: Neo4jNodeRow,
): readonly string[] {
  return NEO4J_NODE_KINDS[kind].properties.map((property) => {
    const value = row[property];
    if (value === undefined) {
      throw new Error(`Neo4j ${kind} row is missing property ${property}`);
    }
    return value;
  });
}

/**
 * Relationship kinds. `fromLabel`/`toLabel` are what the online load
 * matches endpoints on: always a label backed by a uniqueness constraint
 * (`Person`, `Forum` or the shared `Message` label), never a bare
 * `Post`/`Comment`, so every endpoint lookup is an index seek. The offline
 * importer resolves endpoints by `:ID` and ignores them.
 */
export const NEO4J_EDGE_KINDS = {
  knows: {
    type: "KNOWS",
    fromLabel: "Person",
    toLabel: "Person",
    properties: ["since"],
  },
  hasCreator: {
    type: "HAS_CREATOR",
    fromLabel: "Message",
    toLabel: "Person",
    properties: [],
  },
  containerOf: {
    type: "CONTAINER_OF",
    fromLabel: "Forum",
    toLabel: "Message",
    properties: [],
  },
  replyOf: {
    type: "REPLY_OF",
    fromLabel: "Message",
    toLabel: "Message",
    properties: [],
  },
} as const satisfies Record<
  string,
  Readonly<{
    type: string;
    fromLabel: string;
    toLabel: string;
    properties: readonly string[];
  }>
>;

export type Neo4jEdgeKind = keyof typeof NEO4J_EDGE_KINDS;
