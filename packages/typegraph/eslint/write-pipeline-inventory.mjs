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
 * The 40 backend members no module outside the seam may call: the three WRITE
 * classes of `src/backend/member-classes.ts` — graph-entity writes, their
 * sidecars (both claim relations included), and backend-owned bulk ingestion.
 */
export const WRITE_MEMBER_NAMES = [
  // ENTITY_WRITE_MEMBERS
  "insertNode",
  "insertNodeIfAbsent",
  "insertNodeIfAbsentWithSchemaFence",
  "insertNodeWithSchemaFence",
  "commands",
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
  "insertEdgesDurableBatchReturning",
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
  "claimEdgeCardinalityGuarded",
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
 * Four selectors, because the repo writes an optional backend member call in
 * four ways and a syntactic rule must cover all four.
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
export function writePipelineMemberRestrictions(memberNames) {
  if (memberNames.length === 0) return [];
  const directMembers = memberNames.filter((member) => member !== "commands");
  const memberPattern = directMembers.join("|");
  const directRestrictions =
    directMembers.length === 0 ?
      []
    : [
        {
          // 1. direct call: target.insertNode(params)
          selector: `CallExpression > MemberExpression.callee[property.name=/^(${memberPattern})$/]`,
          message: WRITE_PIPELINE_MESSAGE,
        },
        {
          // 2. hoist to local: const updateNodeSet = target.updateNodeSet;
          //    (forced by TypeScript's narrowing of optional members)
          selector: `VariableDeclarator > MemberExpression.init[property.name=/^(${memberPattern})$/]`,
          message: WRITE_PIPELINE_MESSAGE,
        },
        {
          // 3. requireDefined wrap: requireDefined(backend.insertNodesBatch)(params)
          selector: `CallExpression[callee.name="requireDefined"] > MemberExpression[property.name=/^(${memberPattern})$/]`,
          message: WRITE_PIPELINE_MESSAGE,
        },
      ];
  const commandRestrictions =
    memberNames.includes("commands") ?
      [
        {
          // Semantic command call: target.commands.execute(command)
          selector:
            'CallExpression > MemberExpression.callee > MemberExpression.object[property.name="commands"]',
          message: WRITE_PIPELINE_MESSAGE,
        },
        {
          // Hoist the command port: const commands = target.commands;
          selector:
            'VariableDeclarator > MemberExpression.init[property.name="commands"]',
          message: WRITE_PIPELINE_MESSAGE,
        },
        {
          // requireDefined(target.commands).execute(command)
          selector:
            'CallExpression[callee.name="requireDefined"] > MemberExpression[property.name="commands"]',
          message: WRITE_PIPELINE_MESSAGE,
        },
        {
          // executeAuthoritativeGraphCommand(target.commands, command)
          selector:
            'CallExpression[callee.name="executeAuthoritativeGraphCommand"] > MemberExpression[property.name="commands"]:first-child',
          message: WRITE_PIPELINE_MESSAGE,
        },
      ]
    : [];
  return [...directRestrictions, ...commandRestrictions];
}

export const WRITE_PIPELINE_RESTRICTIONS =
  writePipelineMemberRestrictions(WRITE_MEMBER_NAMES);

export const WRITE_PIPELINE_INTERNAL_IMPORT_NAMES = [
  "nodeInsertDispatch",
  "edgeInsertDispatch",
  "runInsertNoReturn",
  "runInsertBatch",
  "runInsertBatchReturning",
  "applyNodeUpdate",
  "applyNodeSoftDelete",
  "applyNodeHardDelete",
  "applyNodeResurrect",
  "applyNodeSetUpdate",
  "applyNodeInsertSyncFans",
  "applyNodeInsertSyncFansBatch",
  "applyEdgeUpdate",
  "applyEdgeSoftDelete",
  "applyEdgeHardDelete",
];

export function writePipelineImportRestrictions(importNames) {
  if (importNames.length === 0) return [];
  return [
    {
      selector:
        `ImportDeclaration[source.value=/\\/(?:insert-dispatch|node-write-pipeline|edge-write-pipeline)$/] ` +
        `ImportSpecifier[imported.name=/^(${importNames.join("|")})$/]`,
      message:
        "Write step and insert-dispatch mutation helpers are private to the fused write session. Add a session method and call it through runWritePlan instead of importing a row-only primitive.",
    },
  ];
}

export const WRITE_PIPELINE_IMPORT_RESTRICTIONS =
  writePipelineImportRestrictions(WRITE_PIPELINE_INTERNAL_IMPORT_NAMES);

/**
 * @typedef {Readonly<{ path: string, reason: string, permanent: boolean, allowedMembers: readonly string[], allowedImports?: readonly string[] }>} WritePipelineExemption
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
    allowedMembers: [
      "updateNode",
      "updateNodeSet",
      "deleteNode",
      "hardDeleteNode",
      "deleteEdge",
      "hardDeleteEdge",
    ],
  },
  {
    path: "src/store/insert-dispatch.ts",
    reason:
      "Insert dispatch: the one module that knows which of the four insert shapes a backend supports. Called only by session methods.",
    permanent: true,
    allowedMembers: [
      "insertNode",
      "insertNodeIfAbsent",
      "insertNodeNoReturn",
      "insertNodesBatch",
      "insertNodesBatchReturning",
      "insertEdge",
      "insertEdgeNoReturn",
      "insertEdgesBatch",
      "insertEdgesBatchReturning",
    ],
  },
  {
    path: "src/store/claims/node-claims.ts",
    reason:
      "The node claim sidecar (uniqueness and disjointness reservations in the uniques relation), called only by the write steps and the session methods that own the row each claim gates.",
    permanent: true,
    allowedMembers: [
      "insertUnique",
      "insertUniqueBatch",
      "deleteUnique",
      "hardDeleteUniquesByNodeIds",
    ],
  },
  {
    path: "src/store/claims/edge-claims.ts",
    reason:
      "The edge cardinality claim sidecar (the edge_claims relation), called only by the session's edge create methods and the edge write steps.",
    permanent: true,
    allowedMembers: [
      "claimEdgeCardinality",
      "claimEdgeCardinalityGuarded",
      "claimEdgeCardinalityBatch",
      "purgeEdgeClaims",
    ],
  },
  {
    path: "src/store/embedding-sync.ts",
    reason: "The embedding sidecar, called only by the write steps.",
    permanent: true,
    allowedMembers: [
      "upsertEmbedding",
      "upsertEmbeddingBatch",
      "deleteEmbedding",
      "deleteEmbeddingBatch",
    ],
  },
  {
    path: "src/store/fulltext-sync.ts",
    reason: "The fulltext sidecar, called only by the write steps.",
    permanent: true,
    allowedMembers: [
      "upsertFulltext",
      "upsertFulltextBatch",
      "deleteFulltext",
      "deleteFulltextBatch",
    ],
  },
  {
    path: "src/store/recorded-capture.ts",
    reason:
      "The capture overlay IS a backend: it wraps every write member and sits BELOW the session, so it cannot route through one.",
    permanent: true,
    allowedMembers: [
      "insertNode",
      "insertNodeIfAbsent",
      "insertNodeIfAbsentWithSchemaFence",
      "insertNodeWithSchemaFence",
      "commands",
      "updateNode",
      "updateNodeSet",
      "deleteNode",
      "hardDeleteNode",
      "insertEdge",
      "insertEdgesDurableBatchReturning",
      "updateEdge",
      "deleteEdge",
      "deleteEdgesBatch",
      "hardDeleteEdge",
      "hardDeleteEdgesBatch",
    ],
    allowedImports: [
      "nodeInsertDispatch",
      "edgeInsertDispatch",
      "runInsertNoReturn",
      "runInsertBatch",
      "runInsertBatchReturning",
    ],
  },
  {
    path: "src/store/fulltext-rebuild.ts",
    reason:
      "Index maintenance that rebuilds the fulltext projection from committed rows. Not a graph write; no WritePlan applies.",
    permanent: true,
    allowedMembers: [
      "upsertFulltext",
      "upsertFulltextBatch",
      "deleteFulltext",
      "deleteFulltextBatch",
    ],
  },
  {
    path: "src/store/store.ts",
    reason:
      "reembedVectorField maintenance and the lifecycle clear() path — store lifecycle, not a managed graph write.",
    permanent: true,
    allowedMembers: ["upsertEmbedding"],
  },
  {
    path: "src/graph-merge/provenance-store.ts",
    reason:
      "A pre-schema-commit marker write under its own LOCK TABLE fence, inside the schema-write transaction the Store cannot join.",
    permanent: true,
    allowedMembers: ["insertNode"],
  },
  {
    path: "src/interchange/trusted-import.ts",
    reason:
      "backend.trustedImport is a backend-owned, all-or-nothing ingestion session that takes the managed-write fence itself and requires empty tables; it is documented to bypass the store write pipeline.",
    permanent: true,
    allowedMembers: ["trustedImport"],
  },
  {
    path: "src/store/operations/edge-operations.ts",
    reason:
      "The edge operation owns convergence command dispatch and passes graph-lock evidence to the authoritative port before the session executes row work.",
    permanent: true,
    allowedMembers: ["commands"],
  },
  {
    path: "src/store/operations/edge-write-pipeline.ts",
    reason:
      "The edge step bodies themselves (updateEdge, deleteEdge, hardDeleteEdge), reachable only through the session.",
    permanent: true,
    allowedMembers: ["updateEdge", "deleteEdge", "hardDeleteEdge"],
  },
  {
    path: "src/store/operations/write-session.ts",
    reason:
      "The fused session is the sole ordinary owner of insert-dispatch and row-step mutation helpers.",
    permanent: true,
    allowedMembers: [
      "insertNodeIfAbsentWithSchemaFence",
      "insertNodeWithSchemaFence",
      "commands",
      "insertEdgesDurableBatchReturning",
    ],
    allowedImports: WRITE_PIPELINE_INTERNAL_IMPORT_NAMES,
  },
  {
    path: "src/provenance/index.ts",
    reason:
      "Provenance currency close and reopen are the documented read-compute-write prelude carve-outs.",
    permanent: true,
    allowedMembers: [],
    allowedImports: ["applyNodeSoftDelete", "applyNodeResurrect"],
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
 * exempt files each receive their own block: the same profile restrictions,
 * plus bans for every write member and private helper that file is NOT
 * explicitly allowed to own. An exemption is therefore capability-scoped,
 * not a blanket suspension of the pipeline guardrail.
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
    const profileExemptions = exemptions.filter((entry) =>
      profileCovers(entry.path, profile),
    );
    const exemptPaths = profileExemptions.map((entry) => entry.path);
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
            ...WRITE_PIPELINE_IMPORT_RESTRICTIONS,
          ],
        },
      },
      ...(profileExemptions.length === 0 ?
        []
      : profileExemptions.map((entry) => {
          const deniedMembers = WRITE_MEMBER_NAMES.filter(
            (member) => !entry.allowedMembers.includes(member),
          );
          const deniedImports = WRITE_PIPELINE_INTERNAL_IMPORT_NAMES.filter(
            (name) => !(entry.allowedImports ?? []).includes(name),
          );
          return {
            name: `typegraph/write-pipeline/${profile.name}/exempt/${entry.path}`,
            files: [entry.path],
            rules: {
              "no-restricted-syntax": [
                "error",
                ...profile.restrictions,
                ...writePipelineMemberRestrictions(deniedMembers),
                ...writePipelineImportRestrictions(deniedImports),
              ],
            },
          };
        })),
    ];
  });
}
