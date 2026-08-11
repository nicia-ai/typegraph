// @ts-check

/**
 * The write-pipeline ban, as data.
 *
 * ESLint's flat config cannot import TypeScript, and the ratchet test cannot
 * import ESLint's config resolution cheaply, so the two things that must never
 * drift — the banned member names and the exemption list — live here as plain
 * ESM and are consumed by both. `write-pipeline-ratchet.test.ts` asserts these
 * names equal `WRITE_MEMBER_KEYS` (which is derived from `GraphBackend` by the
 * member classification), so neither side is hand-copied from the other and a
 * drift in either direction fails the suite.
 */

/**
 * The 34 backend members no module outside the seam may call: the three WRITE
 * classes of `src/backend/member-classes.ts` — graph-entity writes, their
 * sidecars (both claim relations included), and backend-owned bulk ingestion.
 */
export const WRITE_MEMBER_NAMES = [
  // ENTITY_WRITE_MEMBERS
  "insertNode",
  "insertNodeNoReturn",
  "insertNodesBatch",
  "insertNodesBatchReturning",
  "updateNode",
  "updateNodeSet",
  "deleteNode",
  "hardDeleteNode",
  "insertEdge",
  "insertEdgeNoReturn",
  "insertEdgesBatch",
  "insertEdgesBatchReturning",
  "updateEdge",
  "deleteEdge",
  "deleteEdgesBatch",
  "hardDeleteEdge",
  "hardDeleteEdgesBatch",
  // SIDECAR_WRITE_MEMBERS
  "insertUnique",
  "insertUniqueBatch",
  "deleteUnique",
  "hardDeleteUniquesByNodeIds",
  "hardDeleteUniquesByConcreteKind",
  "claimEdgeCardinality",
  "claimEdgeCardinalityBatch",
  "purgeEdgeClaims",
  "upsertEmbedding",
  "upsertEmbeddingBatch",
  "deleteEmbedding",
  "deleteEmbeddingBatch",
  "upsertFulltext",
  "upsertFulltextBatch",
  "deleteFulltext",
  "deleteFulltextBatch",
  // BULK_WRITE_MEMBERS
  "trustedImport",
];

export const WRITE_PIPELINE_MESSAGE =
  "Graph state is mutated through the write session (src/store/operations/" +
  "write-session.ts), reached from the executor (write-executor.ts). Calling " +
  "a backend mutation member directly re-creates the two defect classes the " +
  "pipeline closes: a primary row written without the sidecars it obliges, " +
  "and a verdict reached outside the write that carries it. Raw member calls " +
  "belong in a step or sidecar module, which the session composes.";

/**
 * Three selectors, because the repo writes an optional backend member call in
 * three ways and a syntactic rule must cover all three.
 *
 * Capability PROBES (`x.member === undefined`) are deliberately out of scope:
 * asking whether a backend has a member is not writing through it, and the
 * set-update path legitimately probes eleven of these names. Banning member
 * ACCESS instead of member CALLS would flag every probe in the tree.
 *
 * Known-uncovered spellings, recorded so the next reader does not mistake this
 * for closure over the language: destructuring (`const { insertNode } =
 * target`), passing `target.insertNode` as a callback to anything other than
 * `requireDefined`, and computed access (`target["insertNode"](…)`). An AST
 * scan of `src/**` found zero occurrences of all three; only a type-aware rule
 * would close them, and its cost (a rule package plus type information on the
 * lint program) was weighed and rejected.
 */
export const WRITE_PIPELINE_RESTRICTIONS = [
  {
    // 1. direct call: target.insertNode(params)
    selector: `CallExpression > MemberExpression.callee[property.name=/^(${WRITE_MEMBER_NAMES.join("|")})$/]`,
    message: WRITE_PIPELINE_MESSAGE,
  },
  {
    // 2. hoist to local: const updateNodeSet = target.updateNodeSet;
    //    (forced by TypeScript's narrowing of optional members)
    selector: `VariableDeclarator > MemberExpression.init[property.name=/^(${WRITE_MEMBER_NAMES.join("|")})$/]`,
    message: WRITE_PIPELINE_MESSAGE,
  },
  {
    // 3. requireDefined wrap: requireDefined(backend.insertNodesBatch)(params)
    selector: `CallExpression[callee.name="requireDefined"] > MemberExpression[property.name=/^(${WRITE_MEMBER_NAMES.join("|")})$/]`,
    message: WRITE_PIPELINE_MESSAGE,
  },
];

/**
 * @typedef {Readonly<{ path: string, reason: string, permanent: boolean }>} WritePipelineExemption
 */

/**
 * Files that call a banned member today, each with the reason it may.
 *
 * This list is asserted EQUAL to the set of violating files by
 * `write-pipeline-ratchet.test.ts` — both directions, so an entry that stops
 * violating fails just as loudly as a violator that is not listed.
 *
 * Every entry is now PERMANENT: the migration's debt reached zero when
 * interchange import moved onto the executor. What remains is the seam itself
 * (the step and sidecar modules the session composes) plus the reasoned
 * carve-outs — a backend overlay, a bulk ingestion session, index maintenance,
 * store lifecycle and a pre-schema-commit marker — each of which states why it
 * cannot route through a write plan.
 */
export const WRITE_PIPELINE_EXEMPTIONS = [
  {
    path: "src/store/operations/node-write-pipeline.ts",
    reason:
      "The node step bodies themselves (updateNode, deleteNode, hardDeleteNode, and the delete-behavior edge cascade), reachable only through the session.",
    permanent: true,
  },
  {
    path: "src/store/insert-dispatch.ts",
    reason:
      "Insert dispatch: the one module that knows which of the four insert shapes a backend supports. Called only by session methods.",
    permanent: true,
  },
  {
    path: "src/store/claims/node-claims.ts",
    reason:
      "The node claim sidecar (uniqueness and disjointness reservations in the uniques relation), called only by the write steps and the session methods that own the row each claim gates.",
    permanent: true,
  },
  {
    path: "src/store/claims/resolved-node-claims.ts",
    reason:
      "The resolved-write-set claim sidecar: the key-blind drop and rebuild a set update and a graph merge need, reached only from the step that owns their row write.",
    permanent: true,
  },
  {
    path: "src/store/claims/edge-claims.ts",
    reason:
      "The edge cardinality claim sidecar (the edge_claims relation), called only by the session's edge create methods and the edge write steps.",
    permanent: true,
  },
  {
    path: "src/store/claims/backing.ts",
    reason:
      "claimSupport reads the claim members to NARROW them for the sidecars above; it issues no write itself, and the syntactic rule cannot tell a requireDefined presence read from a call.",
    permanent: true,
  },
  {
    path: "src/store/embedding-sync.ts",
    reason: "The embedding sidecar, called only by the write steps.",
    permanent: true,
  },
  {
    path: "src/store/fulltext-sync.ts",
    reason: "The fulltext sidecar, called only by the write steps.",
    permanent: true,
  },
  {
    path: "src/store/recorded-capture.ts",
    reason:
      "The capture overlay IS a backend: it wraps every write member and sits BELOW the session, so it cannot route through one.",
    permanent: true,
  },
  {
    path: "src/store/fulltext-rebuild.ts",
    reason:
      "Index maintenance that rebuilds the fulltext projection from committed rows. Not a graph write; no WritePlan applies.",
    permanent: true,
  },
  {
    path: "src/store/store.ts",
    reason:
      "reembedVectorField maintenance and the lifecycle clear() path — store lifecycle, not a managed graph write.",
    permanent: true,
  },
  {
    path: "src/graph-merge/provenance-store.ts",
    reason:
      "A pre-schema-commit marker write under its own LOCK TABLE fence, inside the schema-write transaction the Store cannot join.",
    permanent: true,
  },
  {
    path: "src/interchange/trusted-import.ts",
    reason:
      "backend.trustedImport is a backend-owned, all-or-nothing ingestion session that takes the managed-write fence itself and requires empty tables; it is documented to bypass the store write pipeline.",
    permanent: true,
  },
  {
    path: "src/store/operations/edge-write-pipeline.ts",
    reason:
      "The edge step bodies themselves (updateEdge, deleteEdge, hardDeleteEdge), reachable only through the session.",
    permanent: true,
  },
];

/**
 * Matches a repo-relative path against one `files` pattern of the shapes this
 * config uses: a literal path, or a directory glob ending in `**\/*.ts`.
 *
 * ONE owner for "is this file in that block?", shared by the generator and the
 * ratchet — a second implementation in the test would let the two disagree
 * about the very partition the test is supposed to certify.
 *
 * @param {string} filePath
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesFilePattern(filePath, pattern) {
  const source = pattern
    .split("**/")
    .map((segment) =>
      segment
        .replaceAll(/[.+^${}()|[\]\\]/g, String.raw`\$&`)
        .replaceAll("*", "[^/]*"),
    )
    .join("(?:.*/)?");
  return new RegExp(`^${source}$`).test(filePath);
}

/**
 * @param {string} filePath
 * @param {Readonly<{ files: readonly string[], ignores?: readonly string[] }>} profile
 * @returns {boolean}
 */
export function profileCovers(filePath, profile) {
  const ignored = (profile.ignores ?? []).some((pattern) =>
    matchesFilePattern(filePath, pattern),
  );
  if (ignored) return false;
  return profile.files.some((pattern) => matchesFilePattern(filePath, pattern));
}

/**
 * Generates the write-pipeline lint blocks: one IN-SCHEME block and one EXEMPT
 * block per restriction profile.
 *
 * Why generated rather than written out: flat-config rule entries REPLACE
 * rather than merge, so every block that sets `no-restricted-syntax` for a
 * subset of `src/**` must respell its profile's whole restriction list. Doing
 * that by hand for four profiles × two halves is how a guardrail silently
 * disappears from a file. Here each profile states its list once, and the
 * exempt half is the same list MINUS the write-pipeline selectors — which is
 * the only difference an exemption is allowed to make.
 *
 * @param {Readonly<{
 *   profiles: readonly Readonly<{
 *     name: string,
 *     files: readonly string[],
 *     ignores?: readonly string[],
 *     restrictions: readonly unknown[],
 *   }>[],
 *   exemptions: readonly WritePipelineExemption[],
 * }>} options
 */
export function writePipelineBlocks({ profiles, exemptions }) {
  return profiles.flatMap((profile) => {
    const exemptPaths = exemptions
      .map((entry) => entry.path)
      .filter((path) => profileCovers(path, profile));
    const ignores = [...(profile.ignores ?? [])];
    return [
      {
        name: `typegraph/write-pipeline/${profile.name}`,
        files: [...profile.files],
        ignores: [...ignores, ...exemptPaths],
        rules: {
          "no-restricted-syntax": [
            "error",
            ...profile.restrictions,
            ...WRITE_PIPELINE_RESTRICTIONS,
          ],
        },
      },
      ...(exemptPaths.length === 0 ?
        []
      : [
          {
            name: `typegraph/write-pipeline/${profile.name}/exempt`,
            files: exemptPaths,
            rules: {
              "no-restricted-syntax": ["error", ...profile.restrictions],
            },
          },
        ]),
    ];
  });
}
