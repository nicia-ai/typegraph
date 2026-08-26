/**
 * The PILOT capability-bundle registry — DATA ONLY, sibling in spirit to
 * `backend/member-classes.ts`.
 *
 * A bundle is a named set of {@link GraphBackend} member names split into a
 * required core and a set of graduated extras, with a dialect scope, an
 * optional declaration source and cross-check mode, a port-surface refusal
 * code, a per-operation disposition table naming the sites and the extras
 * each operation requires, and one verdict resolver (`resolve.ts`) plus one
 * member accessor (`bind.ts`). It is not a re-shaping of `GraphBackend`.
 *
 * Two definition kinds, because the measurement has two shapes:
 *
 * - A GATED bundle has a non-empty required core (every member required).
 *   Its resolver returns supported-with-core-member-names or
 *   unsupported-with-`missing`. Pilot: `claims`, `statementExecution`,
 *   `recordedRevisionOrigins`.
 * - A GRADUATED bundle has no required core: every member is an extra with
 *   its own measured disposition. Its resolver returns the per-extra verdict
 *   map and no `supported` field at all. Pilot: `uniqueSidecarBatch`,
 *   `batchPointRead`, `contributionHealth`.
 *
 * Deliberately absent, by round-5 ruling (no pilot consumer for either):
 * `arity` on core members, `requiresBundles` edges, `AnyOfSelection`,
 * `CapabilityCoreMember`, `AllOfMembers`, `AnyOfMembers`. Both are designed
 * and seeded for WS5b in the design document's appendix, beside their first
 * real consumers.
 *
 * This is the PILOT of a larger sweep (WS5b): 15 of the 91 optional
 * `GraphBackend` members are bundled here; the other 76 are classified in
 * {@link UNBUNDLED_OPTIONAL_MEMBERS} as either `reasoned` (no bundle should
 * ever own them) or `deferred` (WS5b's seed, with a measured ceiling).
 */
import { type SqlDialect } from "../../query/dialect/types";
import { type Assert, type Equal } from "../../utils/type-assert";
import { type BackendCapabilities, type GraphBackend } from "../types";

/**
 * The keys of `T` that are optional — i.e. `undefined` may stand in for the
 * member without violating the type. `object extends Pick<T, K>` is true
 * exactly when `Pick<T, K>` accepts `{}`, which is true exactly when `K` is
 * optional on `T`.
 */
export type OptionalKeys<T> = {
  [K in keyof T]-?: object extends Pick<T, K> ? K : never;
}[keyof T];

/**
 * Every optional `GraphBackend` member — 91 of them, verified equal to the
 * names parsed from `etc/typegraph-backend.api.md` (§Baselines). Derived,
 * never hand-written: a member added or removed from `GraphBackend` changes
 * this type automatically, and the totality proof below fails loudly if the
 * registry has not kept up.
 */
export type OptionalGraphBackendMember = OptionalKeys<GraphBackend>;

/** How an operation degrades — or refuses — when a member it needs is absent. */
export type CapabilityBundleDisposition =
  /** Absence refuses, with ONE typed error per operation. */
  | Readonly<{ kind: "refuse"; code: string }>
  /** Absence degrades along a named, tested path. Never refuses. */
  | Readonly<{ kind: "fallback"; fallback: string }>;

/**
 * A graduated extra: present ⇒ a better path, absent ⇒ this exact
 * disposition. `members` is a list because an extra MAY be an all-or-nothing
 * group; every pilot extra is single-membered (the measured group,
 * `indexMaterialization`'s build-claim protocol, is deferred).
 */
export type CapabilityBundleExtra<
  Id extends string,
  M extends OptionalGraphBackendMember,
> = Readonly<{
  id: Id;
  members: readonly M[];
  /** REQUIRED, and typed — never a bare `fallback: string`. */
  disposition: CapabilityBundleDisposition;
}>;

export type CapabilityCrossCheck =
  /** Presence alone. The default, and 5 of the 6 pilot bundles. */
  | "none"
  /**
   * Declared-but-missing refuses; implements-without-declaring resolves
   * supported. One-directional. No bundle uses this today — it exists so a
   * future cross-check has a shape to grow into, one that must carry its own
   * justification row when adopted.
   */
  | "declared-implies-members"
  /**
   * Disagreement in EITHER direction refuses. `claims` only — the existing
   * `CONSTRAINT_CLAIM_SURFACE_MISMATCH`, whose bidirectionality carries a
   * fence-specific justification ("a silent fallback would unfence exactly
   * the writes the capability exists to fence") that no other family has.
   */
  | "bidirectional";

/** One inventory key an operation row owns. */
export type CapabilityBundleOperationSite = Readonly<{
  file: string;
  member: OptionalGraphBackendMember;
  /**
   * Disambiguator, required only where one `(file, member)` pair is split
   * across two or more operation rows. Three pairs need it in the pilot:
   * `node-operations.ts#checkUniqueBatch`, `guards.ts#executeStatement` and
   * `migrate-recorded-time.ts#executeStatement`.
   */
  lines?: readonly number[];
  /**
   * Set when B7's rewiring pass reclassified this site AWAY from `pilot`
   * instead of rewiring it — additive, optional, and read by nothing but the
   * inventory/report tooling. `"deferred"` names a site whose receiver family
   * needs plumbing this batch must not force (WS5b's input); `"reasoned"`
   * names one this batch decided a verdict must never gate at all. The
   * `code`/`disposition` above stay the classification data they always were;
   * this is a SEPARATE fact about the site, not a replacement for either.
   */
  rewiring?: Readonly<{ class: "deferred" | "reasoned"; reason: string }>;
}>;

/** Every caller-visible operation that consumes a bundle. */
export type CapabilityBundleOperation = Readonly<{
  /** The caller-visible name that lands in `details.operation`. */
  operation: string;
  disposition: CapabilityBundleDisposition;
  /** The extras this operation needs, by id. */
  requires?: readonly string[];
  /** Every inventory key this row owns, as `(file, member)` pairs. */
  sites: readonly CapabilityBundleOperationSite[];
  /**
   * Set only where the site itself reads the declaration to decide between
   * refusing and degrading. One measured instance in the pilot:
   * `probeContributions` (`store.ts:4406`).
   */
  declarationGate?: true;
}>;

type CapabilityBundleCommon = Readonly<{
  /**
   * The registry's own id namespace is derived from `CAPABILITY_BUNDLES`
   * below (never hand-written) — but the derivation cannot be fed back into
   * THIS type: `CapabilityBundleId` is `(typeof CAPABILITY_BUNDLES)[number]
   * ["id"]`, and `CAPABILITY_BUNDLES` is built from values (`CLAIMS`, …)
   * whose own type is checked against `CapabilityBundleDefinition` — which
   * embeds this type. Typing this field `CapabilityBundleId` therefore makes
   * every bundle constant's type depend on its own initializer
   * (`TS2502`/`TS2456`, confirmed by compiling the literal design text).
   * `string` here is the minimal break: each bundle constant still infers
   * its literal id via `as const`, and `CapabilityBundleId` below is still
   * wholly derived from `CAPABILITY_BUNDLES`, never hand-written.
   */
  id: string;
  /** Dialects whose first-party factory implements this bundle's core. Default: both. */
  dialects?: readonly SqlDialect[];
  /** The `BackendCapabilities` field that DECLARES the bundle, when one exists. */
  declaration?: keyof BackendCapabilities;
  /** Read only when not `"none"` (ruling F2). */
  crossCheck: CapabilityCrossCheck;
  /** The code the MEMBER ACCESSOR throws when the port disagrees with the verdict (I20). */
  portSurfaceCode: string;
  operations: readonly CapabilityBundleOperation[];
}>;

/** A bundle with a required core. */
export type GatedBundleDefinition<
  MCore extends OptionalGraphBackendMember,
  XId extends string = never,
  MExtra extends OptionalGraphBackendMember = never,
> = CapabilityBundleCommon &
  Readonly<{
    kind: "gated";
    /** Every name required. No arity wrapper — no pilot bundle has an `any-of` core. */
    core: readonly MCore[];
    extras?: readonly CapabilityBundleExtra<XId, MExtra>[];
    /** The bundle-wide disposition when the CORE is unsatisfied. */
    disposition: CapabilityBundleDisposition;
  }>;

/** A bundle with no required core: every member is a graduated extra. */
export type GraduatedBundleDefinition<
  XId extends string,
  MExtra extends OptionalGraphBackendMember,
> = CapabilityBundleCommon &
  Readonly<{
    kind: "graduated";
    extras: readonly CapabilityBundleExtra<XId, MExtra>[];
    /** No `disposition`: there is no bundle-level verdict to dispose of. */
  }>;

export type CapabilityBundleDefinition =
  | GatedBundleDefinition<
      OptionalGraphBackendMember,
      string,
      OptionalGraphBackendMember
    >
  | GraduatedBundleDefinition<string, OptionalGraphBackendMember>;

// ---------------------------------------------------------------------------
// The six pilot bundles — measured, per §Baselines, against this tree.
// ---------------------------------------------------------------------------

/**
 * `claimSupport` (`store/claims/backing.ts`) is the ONE bidirectional
 * cross-check consumer in the tree. Since B7 it delegates to
 * `resolveBundle`, which runs `resolve.ts`'s `assertClaimsBidirectionalAgreement`
 * — the check's only remaining owner; there is no second copy left in
 * `backing.ts` to keep byte-for-byte in sync with.
 */
export const CLAIMS = {
  id: "claims",
  kind: "gated",
  core: [
    "claimEdgeCardinality",
    "claimEdgeCardinalityBatch",
    "purgeEdgeClaims",
    "hardDeleteUniquesByConcreteKind",
  ],
  declaration: "constraintClaims",
  crossCheck: "bidirectional",
  portSurfaceCode: "CONSTRAINT_CLAIM_SURFACE_MISMATCH",
  disposition: {
    kind: "fallback",
    fallback: "unclaimed writes; the caller's own supported:false branch",
  },
  operations: [
    {
      operation: "edge claim write",
      disposition: {
        kind: "fallback",
        fallback: "unclaimed writes; the caller's own supported:false branch",
      },
      sites: [
        { file: "store/claims/backing.ts", member: "claimEdgeCardinality" },
        {
          file: "store/claims/backing.ts",
          member: "claimEdgeCardinalityBatch",
        },
        { file: "store/claims/backing.ts", member: "purgeEdgeClaims" },
        {
          file: "store/claims/backing.ts",
          member: "hardDeleteUniquesByConcreteKind",
        },
      ],
    },
  ],
} as const satisfies CapabilityBundleDefinition;

/**
 * Three independently-guarded extras. Measured, `hardDeleteUniquesByNodeIds`'
 * only standalone site (`node-claims.ts:732`) reaches the member through
 * `requireDefined` rather than a degrading guard, so — the round-5
 * enumeration's correction to the round-4 table — its disposition is
 * `refuse`, not the fallback round 4 assumed from the bundle's name.
 */
export const UNIQUE_SIDECAR_BATCH = {
  id: "uniqueSidecarBatch",
  kind: "graduated",
  crossCheck: "none",
  portSurfaceCode: "BUNDLE_PORT_SURFACE_MISMATCH",
  extras: [
    {
      id: "insertUniqueBatch",
      members: ["insertUniqueBatch"],
      disposition: { kind: "fallback", fallback: "issueClaimsIndividually" },
    },
    {
      id: "checkUniqueBatch",
      members: ["checkUniqueBatch"],
      disposition: {
        kind: "fallback",
        fallback: "per-key checkUnique loop",
      },
    },
    {
      id: "hardDeleteUniquesByNodeIds",
      members: ["hardDeleteUniquesByNodeIds"],
      disposition: {
        kind: "refuse",
        // Registry-assigned: the real throw is `requireDefined`'s generic
        // `TypeError`, which carries no domain code of its own.
        code: "UNIQUE_REAP_BY_NODE_IDS_UNSUPPORTED",
      },
    },
  ],
  operations: [
    {
      operation: "unique batch probe",
      disposition: { kind: "fallback", fallback: "per-key checkUnique loop" },
      requires: ["checkUniqueBatch"],
      sites: [
        {
          file: "store/operations/node-operations.ts",
          member: "checkUniqueBatch",
          lines: [1275, 1320],
        },
        {
          file: "store/operations/node-operations.ts",
          member: "checkUniqueBatch",
          lines: [1575, 1593],
        },
      ],
    },
    {
      operation: "unique claim issue",
      disposition: { kind: "fallback", fallback: "issueClaimsIndividually" },
      requires: ["insertUniqueBatch"],
      sites: [
        { file: "store/claims/node-claims.ts", member: "insertUniqueBatch" },
      ],
    },
    {
      operation: "unique reap by node ids",
      disposition: {
        kind: "refuse",
        code: "UNIQUE_REAP_BY_NODE_IDS_UNSUPPORTED",
      },
      requires: ["hardDeleteUniquesByNodeIds"],
      sites: [
        {
          file: "store/claims/node-claims.ts",
          member: "hardDeleteUniquesByNodeIds",
        },
      ],
    },
    {
      operation: "set-based node update",
      disposition: {
        kind: "refuse",
        code: "SET_UPDATE_UNIQUENESS_UNSUPPORTED",
      },
      requires: [
        "hardDeleteUniquesByNodeIds",
        "insertUniqueBatch",
        "checkUniqueBatch",
      ],
      sites: [
        {
          file: "store/operations/node-write-pipeline.ts",
          member: "hardDeleteUniquesByNodeIds",
        },
        {
          file: "store/operations/node-write-pipeline.ts",
          member: "insertUniqueBatch",
        },
        {
          file: "store/operations/node-write-pipeline.ts",
          member: "checkUniqueBatch",
        },
        {
          file: "store/operations/node-operations.ts",
          member: "hardDeleteUniquesByNodeIds",
        },
        {
          file: "store/operations/node-operations.ts",
          member: "insertUniqueBatch",
        },
        {
          file: "store/operations/node-operations.ts",
          member: "checkUniqueBatch",
          lines: [1993],
        },
      ],
    },
    {
      operation: "resolved node write",
      disposition: {
        kind: "refuse",
        code: "RESOLVED_NODE_UNIQUENESS_UNSUPPORTED",
      },
      requires: [
        "hardDeleteUniquesByNodeIds",
        "insertUniqueBatch",
        "checkUniqueBatch",
      ],
      sites: [
        {
          file: "store/claims/resolved-node-claims.ts",
          member: "checkUniqueBatch",
          lines: [211],
        },
        {
          file: "store/claims/resolved-node-claims.ts",
          member: "checkUniqueBatch",
          lines: [292],
        },
        {
          file: "store/claims/resolved-node-claims.ts",
          member: "hardDeleteUniquesByNodeIds",
        },
        {
          file: "store/claims/resolved-node-claims.ts",
          member: "insertUniqueBatch",
        },
      ],
    },
  ],
} as const satisfies CapabilityBundleDefinition;

/** Two independently-guarded extras, both fallback. */
export const BATCH_POINT_READ = {
  id: "batchPointRead",
  kind: "graduated",
  crossCheck: "none",
  portSurfaceCode: "BUNDLE_PORT_SURFACE_MISMATCH",
  extras: [
    {
      id: "getNodes",
      members: ["getNodes"],
      disposition: { kind: "fallback", fallback: "per-id getNode" },
    },
    {
      id: "getEdges",
      members: ["getEdges"],
      disposition: { kind: "fallback", fallback: "per-id getEdge" },
    },
  ],
  operations: [
    {
      operation: "search hydration",
      disposition: { kind: "fallback", fallback: "per-id getNode" },
      requires: ["getNodes"],
      sites: [{ file: "store/search.ts", member: "getNodes" }],
    },
    {
      operation: "import reference validation",
      disposition: {
        kind: "fallback",
        fallback: "per-row getNode in the routing loop",
      },
      requires: ["getNodes"],
      sites: [{ file: "interchange/import.ts", member: "getNodes" }],
    },
    {
      operation: "import edge endpoint hydration",
      disposition: { kind: "fallback", fallback: "per-row getEdge" },
      requires: ["getEdges"],
      sites: [{ file: "interchange/import.ts", member: "getEdges" }],
    },
    {
      operation: "edge batch endpoint priming",
      disposition: {
        kind: "fallback",
        fallback: "skip the priming pass; endpoint validation reads per-row",
      },
      requires: ["getNodes"],
      sites: [
        { file: "store/operations/edge-operations.ts", member: "getNodes" },
      ],
    },
    {
      operation: "node create batch priming",
      disposition: {
        kind: "fallback",
        fallback: "skip priming; per-row probes",
      },
      requires: ["getNodes"],
      sites: [
        { file: "store/operations/node-operations.ts", member: "getNodes" },
      ],
    },
    {
      operation: "node collection batch load",
      disposition: { kind: "fallback", fallback: "per-id getNode" },
      requires: ["getNodes"],
      sites: [
        { file: "store/collections/node-collection.ts", member: "getNodes" },
      ],
    },
    {
      operation: "node batch fetch",
      disposition: { kind: "fallback", fallback: "per-id getNode" },
      requires: ["getNodes"],
      sites: [{ file: "store/node-fetch.ts", member: "getNodes" }],
    },
    {
      operation: "edge batch fetch",
      disposition: { kind: "fallback", fallback: "per-id getEdge" },
      requires: ["getEdges"],
      sites: [{ file: "store/edge-fetch.ts", member: "getEdges" }],
    },
    {
      operation: "identity member hydration",
      disposition: { kind: "fallback", fallback: "per-id getNode" },
      requires: ["getNodes"],
      sites: [{ file: "store/store.ts", member: "getNodes" }],
    },
  ],
} as const satisfies CapabilityBundleDefinition;

/**
 * Core `executeStatement`. `IDENTITY_REQUIRES_STATEMENT_EXECUTION` and
 * `IDENTITY_REQUIRES_ATOMIC_BACKEND` are the existing `details.code` values
 * at `identity/sql-target.ts:101` and `store/store.ts:921`; the remaining
 * rows' underlying throws carry no domain code of their own today, so their
 * `code` here is registry-assigned classification (documented per row).
 */
export const STATEMENT_EXECUTION = {
  id: "statementExecution",
  kind: "gated",
  core: ["executeStatement"],
  crossCheck: "none",
  portSurfaceCode: "BUNDLE_PORT_SURFACE_MISMATCH",
  disposition: {
    kind: "refuse",
    code: "IDENTITY_REQUIRES_STATEMENT_EXECUTION",
  },
  operations: [
    {
      operation: "identity statement execution",
      disposition: {
        kind: "refuse",
        code: "IDENTITY_REQUIRES_STATEMENT_EXECUTION",
      },
      sites: [
        {
          file: "identity/sql-target.ts",
          member: "executeStatement",
          rewiring: {
            class: "deferred",
            reason:
              "requires verdict threading through IdentityServiceContext / the capture session — WS5b input, measured at ~13 files/~35 signatures",
          },
        },
      ],
    },
    {
      operation: "recorded capture statement",
      disposition: {
        kind: "refuse",
        code: "RECORDED_CAPTURE_STATEMENT_UNSUPPORTED",
      },
      sites: [
        {
          file: "store/recorded-capture/guards.ts",
          member: "executeStatement",
          lines: [62, 79],
          // DUAL-CLASS (file, member) pair: this same "guards.ts#executeStatement"
          // key also carries the "reasoned" rewiring below (the port-surface
          // fallback site). The live scanner (scripts/bundle-member-access-scan.ts)
          // matches rewiring annotations on (file, member) only — it cannot read
          // `lines` to split the pair — so every live executeStatement access in
          // this file classifies as `annotated-residue` once either sibling
          // annotation exists.
          rewiring: {
            class: "deferred",
            reason:
              "requires verdict threading through IdentityServiceContext / the capture session — WS5b input, measured at ~13 files/~35 signatures",
          },
        },
      ],
    },
    {
      operation: "history construction gate",
      disposition: {
        kind: "refuse",
        code: "HISTORY_REQUIRES_STATEMENT_EXECUTION",
      },
      sites: [
        {
          file: "store/recorded-capture/guards.ts",
          member: "executeStatement",
          lines: [251],
        },
      ],
    },
    {
      operation: "revision tracking construction gate",
      disposition: {
        kind: "refuse",
        code: "REVISION_TRACKING_REQUIRES_STATEMENT_EXECUTION",
      },
      sites: [
        {
          file: "store/recorded-capture/guards.ts",
          member: "executeStatement",
          lines: [299],
        },
      ],
    },
    {
      operation: "history-unsafe raw write overlay",
      disposition: {
        kind: "fallback",
        fallback: "omit the overriding member; the port's own absence stands",
      },
      sites: [
        {
          file: "store/recorded-capture/guards.ts",
          member: "executeStatement",
          lines: [219],
          // DUAL-CLASS (file, member) pair: this same "guards.ts#executeStatement"
          // key also carries the "deferred" rewiring above (the recorded-capture
          // statement site). The live scanner (scripts/bundle-member-access-scan.ts)
          // matches rewiring annotations on (file, member) only — it cannot read
          // `lines` to split the pair — so every live executeStatement access in
          // this file classifies as `annotated-residue` once either sibling
          // annotation exists.
          rewiring: {
            class: "reasoned",
            reason:
              "genuinely a port-surface presence test; re-keying it on a verdict changes behavior in both directions (a phantom-rejecting stub one way, a raw-write escape on a history-enabled store the other — a safety regression), and adding a non-throwing gated accessor to the frozen binder surface for ONE site is the over-generalization anti-pattern",
          },
        },
      ],
    },
    {
      operation: "identity construction gate",
      disposition: {
        kind: "refuse",
        code: "IDENTITY_REQUIRES_ATOMIC_BACKEND",
      },
      sites: [
        { file: "store/store.ts", member: "executeStatement", lines: [921] },
        { file: "store/store.ts", member: "executeStatement", lines: [928] },
      ],
    },
    {
      operation: "validity window repair",
      disposition: {
        kind: "refuse",
        code: "VALIDITY_WINDOW_REPAIR_REQUIRES_STATEMENT_EXECUTION",
      },
      sites: [
        {
          file: "backend/repair-validity-windows.ts",
          member: "executeStatement",
        },
      ],
    },
    {
      operation: "recorded-time migration",
      disposition: {
        kind: "refuse",
        code: "RECORDED_TIME_MIGRATION_REQUIRES_STATEMENT_EXECUTION",
      },
      sites: [
        {
          file: "backend/migrate-recorded-time.ts",
          member: "executeStatement",
          lines: [154, 161, 801],
          rewiring: {
            class: "deferred",
            reason:
              "the delete path's public Pick-typed backend cannot reach resolveBundle, and the shared module-private helpers make a single-path rewire two owners",
          },
        },
      ],
    },
  ],
} as const satisfies CapabilityBundleDefinition;

/**
 * Four extras, one per public `Store` method, each read alone. Three refuse
 * with their own existing error; `probeContributions` is the pilot's one
 * `declarationGate` row — fallback to `{ entries: [] }` when
 * `capabilities.contributions` is undeclared, refuse when it is declared.
 */
export const CONTRIBUTION_HEALTH = {
  id: "contributionHealth",
  kind: "graduated",
  declaration: "contributions",
  crossCheck: "none",
  portSurfaceCode: "BUNDLE_PORT_SURFACE_MISMATCH",
  extras: [
    {
      id: "verifyContributions",
      members: ["verifyContributions"],
      disposition: { kind: "refuse", code: "CONTRIBUTION_VERIFY_UNSUPPORTED" },
    },
    {
      id: "repairContributions",
      members: ["repairContributions"],
      disposition: { kind: "refuse", code: "CONTRIBUTION_REPAIR_UNSUPPORTED" },
    },
    {
      id: "rebuildContribution",
      members: ["rebuildContribution"],
      disposition: {
        kind: "refuse",
        code: "CONTRIBUTION_REBUILD_UNSUPPORTED",
      },
    },
    {
      id: "probeContributions",
      members: ["probeContributions"],
      disposition: { kind: "fallback", fallback: "{entries: []}" },
    },
  ],
  operations: [
    {
      operation: "contribution verify",
      disposition: { kind: "refuse", code: "CONTRIBUTION_VERIFY_UNSUPPORTED" },
      requires: ["verifyContributions"],
      sites: [{ file: "store/store.ts", member: "verifyContributions" }],
    },
    {
      operation: "contribution repair",
      disposition: { kind: "refuse", code: "CONTRIBUTION_REPAIR_UNSUPPORTED" },
      requires: ["repairContributions"],
      sites: [{ file: "store/store.ts", member: "repairContributions" }],
    },
    {
      operation: "contribution rebuild",
      disposition: {
        kind: "refuse",
        code: "CONTRIBUTION_REBUILD_UNSUPPORTED",
      },
      requires: ["rebuildContribution"],
      sites: [{ file: "store/store.ts", member: "rebuildContribution" }],
    },
    {
      operation: "contribution probe",
      disposition: { kind: "fallback", fallback: "{entries: []}" },
      requires: ["probeContributions"],
      sites: [{ file: "store/store.ts", member: "probeContributions" }],
      declarationGate: true,
    },
  ],
} as const satisfies CapabilityBundleDefinition;

/**
 * Core `ensureRevisionOriginsTable`, both refusals existing typed throws
 * (registry-assigned codes; neither underlying throw carries a domain code
 * of its own today).
 */
export const RECORDED_REVISION_ORIGINS = {
  id: "recordedRevisionOrigins",
  kind: "gated",
  core: ["ensureRevisionOriginsTable"],
  crossCheck: "none",
  portSurfaceCode: "BUNDLE_PORT_SURFACE_MISMATCH",
  disposition: {
    kind: "refuse",
    code: "REVISION_TRACKING_REQUIRES_REVISION_ORIGINS",
  },
  operations: [
    {
      operation: "revision tracking construction gate",
      disposition: {
        kind: "refuse",
        code: "REVISION_TRACKING_REQUIRES_REVISION_ORIGINS",
      },
      sites: [
        {
          file: "store/recorded-capture/guards.ts",
          member: "ensureRevisionOriginsTable",
        },
      ],
    },
    {
      operation: "revision origin bootstrap",
      disposition: {
        kind: "refuse",
        code: "REVISION_ORIGIN_BOOTSTRAP_UNSUPPORTED",
      },
      sites: [
        {
          file: "store/recorded-capture/clock.ts",
          member: "ensureRevisionOriginsTable",
        },
      ],
    },
  ],
} as const satisfies CapabilityBundleDefinition;

/** The pilot registry: six bundles, 15 members, 30 operation rows. */
export const CAPABILITY_BUNDLES = [
  CLAIMS,
  UNIQUE_SIDECAR_BATCH,
  BATCH_POINT_READ,
  STATEMENT_EXECUTION,
  CONTRIBUTION_HEALTH,
  RECORDED_REVISION_ORIGINS,
] as const;

export type CapabilityBundleId = (typeof CAPABILITY_BUNDLES)[number]["id"];

// ---------------------------------------------------------------------------
// UNBUNDLED_OPTIONAL_MEMBERS — the other 76, both kinds classified (I5, I6).
// ---------------------------------------------------------------------------

/** No bundle should ever own this member; the reason is the fact to preserve. */
export type ReasonedUnbundledMember = Readonly<{
  kind: "reasoned";
  reason: string;
  /** Measured receiver-scoped access count (§Baselines). May be 0. */
  accesses: number;
}>;

/** The 15 WS5b bundle ids, retained from the round-4 sweep table. */
export type Ws5bBundleId =
  | "batchEntityWrite"
  | "endpointSetRead"
  | "heterogeneousEndpointSetRead"
  | "vectorOperations"
  | "hybridSearch"
  | "vectorSlotContributions"
  | "fulltextOperations"
  | "fulltextProvisioning"
  | "databaseExtensions"
  | "contributionProvisioning"
  | "indexMaterialization"
  | "ddlExecution"
  | "temporaryStatements"
  | "rawStatementReuse"
  | "trustedImport";

/** WS5b's residue: this bundle owns it, and the access count may not grow. */
export type DeferredUnbundledMember = Readonly<{
  kind: "deferred";
  workstream: "WS5b";
  bundle: Ws5bBundleId;
  /** Measured receiver-scoped access count (§Baselines) — the ceiling. */
  ceiling: number;
}>;

export type UnbundledOptionalMember =
  ReasonedUnbundledMember | DeferredUnbundledMember;

/**
 * The 27 `reasoned` + 49 `deferred` members
 * (B9's scanner corrected two `reasoned` counts: `tableNames` 22→23,
 * `ensureIdentityTables` 3→4; #520 then added `recordedTableDdl` with one
 * access), 15 + 76 = 91 members total.
 */
export const UNBUNDLED_OPTIONAL_MEMBERS = {
  ensureEdgeMatchIdentityStorage: {
    kind: "reasoned",
    reason:
      "Focused privileged base-schema adoption hook. Schema preparation calls its single owner on every open because all edge writes name the nullable columns; runtime stores never consult it. Custom backends may omit it only when their durableEdgeMatchIdentity declaration promises independently provisioned storage.",
    accesses: 1,
  },
  claimEdgeCardinalityGuarded: {
    kind: "reasoned",
    reason:
      "A stronger first-party single-claim operation whose member presence explicitly permits the store to fold the legacy entity probe into the claim; custom and legacy claim backends keep probe-then-claim, so it is not part of the claims bundle's required portable surface.",
    accesses: 1,
  },
  insertNodeIfAbsentWithSchemaFence: {
    kind: "reasoned",
    reason:
      "First-party schema-managed insert fast path selected only by the node create session; a missing member retains the ordinary fence then insert path.",
    accesses: 6,
  },
  insertNodeWithSchemaFence: {
    kind: "reasoned",
    reason:
      "Same first-party schema-fenced node insert family; generated ids use it only when no earlier lock-bearing work is required.",
    accesses: 7,
  },
  bootstrapTables: {
    kind: "reasoned",
    reason:
      "One-shot provisioning hook consulted by createStore before any capability question exists; it has no operation that could refuse or degrade.",
    accesses: 3,
  },
  tableNames: {
    kind: "reasoned",
    reason:
      "Not a capability — a name map the compiler reads on every backend. Absence is impossible in practice and meaningless as a decision.",
    // 23, not the grep tier's 22: store/store.ts holds two `backend.tableNames`
    // accesses on one physical line, which a line-keyed grep counts once but
    // the type-aware scanner counts as two access nodes (§Baselines).
    accesses: 23,
  },
  commitSchemaVersionIfKindsEmpty: {
    kind: "reasoned",
    reason:
      "Schema-version write fence, a SchemaCommitBackend role member. Its absence is dispositioned by the schema manager's own gate, which is a write-pipeline decision, not a feature-family one.",
    accesses: 2,
  },
  commitSchemaVersionWithPreflight: {
    kind: "reasoned",
    reason:
      "Same schema-version write-fence family as commitSchemaVersionIfKindsEmpty.",
    accesses: 3,
  },
  lockSchemaVersionForWrite: {
    kind: "reasoned",
    reason:
      "Same family; also the one schema member on TransactionBackend, so bundling it would re-open the accessor's B-1 port-typing question for no pilot consumer.",
    accesses: 1,
  },
  lockSchemaVersionAndGraphWrite: {
    kind: "reasoned",
    reason:
      "PostgreSQL/PGlite transaction-only latency seam which preserves the existing schema-then-graph lock order in one dependent-CTE statement; SQLite and custom backends retain the two portable lock operations.",
    accesses: 1,
  },
  schemaWriteTransaction: {
    kind: "reasoned",
    reason:
      "Same family — and it returns a narrowed transaction backend, so it is a port constructor rather than an operation.",
    accesses: 4,
  },
  registerGraphTemplate: {
    kind: "reasoned",
    reason:
      "Administrative template registration is gated by the graph-template facade, which refuses absent backends rather than treating a missing registry as an empty template set.",
    accesses: 1,
  },
  instantiateGraphTemplate: {
    kind: "reasoned",
    reason:
      "Administrative schema bootstrap operation, gated by the graph-template facade; it is not a runtime feature family because absence is a typed refusal before any graph write.",
    accesses: 1,
  },
  ensureIdentityTables: {
    kind: "reasoned",
    reason:
      "Identity DDL, gated by the identity construction gate (store.ts:918-935), which is the write-fence design's decision and must stay one owner there.",
    // 4, not the grep tier's 3: identity/schema-transition.ts:228 accesses
    // `input.ensureIdentityTables` through a derived (arm-b) receiver whose
    // property name never matches the grep receiver-name filter
    // (backend|Backend|target|Target|tx|port|source). The type-aware scanner
    // resolves it via the receiver's declared type node, which textually
    // references `GraphBackend["ensureIdentityTables"]` (§Baselines).
    accesses: 4,
  },
  identityTableDdl: {
    kind: "reasoned",
    reason: "Same identity-DDL family as ensureIdentityTables.",
    accesses: 2,
  },
  recordedTableDdl: {
    kind: "reasoned",
    reason:
      "Recorded-time migration DDL factory; its only consumer has its own typed capability refusal, so it is a provisioning port rather than a feature-family operation.",
    accesses: 1,
  },
  ensureKindRemovalsTable: {
    kind: "reasoned",
    reason:
      "Kind-removal provisioning; the removal path's own gate is a schema-lifecycle decision with a single consumer (materialize-removals.ts) and no second theory to consolidate.",
    accesses: 3,
  },
  getAllKindRemovals: {
    kind: "reasoned",
    reason: "Same kind-removal family as ensureKindRemovalsTable.",
    accesses: 2,
  },
  getPendingKindRemovals: {
    kind: "reasoned",
    reason: "Same kind-removal family as ensureKindRemovalsTable.",
    accesses: 4,
  },
  recordKindRemoval: {
    kind: "reasoned",
    reason: "Same kind-removal family as ensureKindRemovalsTable.",
    accesses: 4,
  },
  ensureReconciliationMarkersTable: {
    kind: "reasoned",
    reason:
      "Reconciliation-marker family; single consumer, single gate, same reasoning.",
    accesses: 2,
  },
  getReconciliationMarker: {
    kind: "reasoned",
    reason: "Same reconciliation-marker family.",
    accesses: 2,
  },
  setReconciliationMarker: {
    kind: "reasoned",
    reason: "Same reconciliation-marker family.",
    accesses: 2,
  },
  readConstraintFenceViolations: {
    kind: "reasoned",
    reason:
      'Read-only fence audit with exactly one caller and a documented "absent ⇒ the report is unavailable" contract (history-store-backend.ts:105-108); no operation degrades or refuses on it.',
    accesses: 1,
  },
  ensureContributionMaterializationsTable: {
    kind: "reasoned",
    reason:
      "Zero consumers in src/** outside the backend implementations — measured, not inferred. A member no code path consults has no measurable arity or disposition.",
    accesses: 0,
  },
  getContributionMaterialization: {
    kind: "reasoned",
    reason:
      "Same zero-consumer family as ensureContributionMaterializationsTable.",
    accesses: 0,
  },
  recordContributionMaterialization: {
    kind: "reasoned",
    reason:
      "Zero consumers outside the backend implementations; its only in-tree use is a backend implementation calling its own member (backend/drizzle/contribution-materializations.ts:1588), which the scanner excludes by scope.",
    accesses: 0,
  },

  assertRuntimeContributionsInitialized: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "contributionProvisioning",
    ceiling: 1,
  },
  assertVectorSlotInitialized: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorSlotContributions",
    ceiling: 1,
  },
  assertVectorSlotsInitialized: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorSlotContributions",
    ceiling: 1,
  },
  claimIndexMaterialization: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "indexMaterialization",
    ceiling: 2,
  },
  compileSql: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "rawStatementReuse",
    ceiling: 9,
  },
  createVectorIndex: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorOperations",
    ceiling: 4,
  },
  deleteEdgesBatch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 5,
  },
  deleteEmbedding: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorOperations",
    ceiling: 8,
  },
  deleteEmbeddingBatch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorOperations",
    ceiling: 4,
  },
  deleteFulltext: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "fulltextOperations",
    ceiling: 11,
  },
  deleteFulltextBatch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "fulltextOperations",
    ceiling: 6,
  },
  deleteVectorSlotContribution: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorSlotContributions",
    ceiling: 0,
  },
  dropVectorIndex: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorOperations",
    ceiling: 0,
  },
  ensureExtension: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "databaseExtensions",
    ceiling: 2,
  },
  ensureFulltextTable: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "fulltextProvisioning",
    ceiling: 1,
  },
  ensureIndexMaterializationsTable: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "indexMaterialization",
    ceiling: 2,
  },
  ensureRuntimeContributions: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "contributionProvisioning",
    ceiling: 2,
  },
  ensureTrigramExtension: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "databaseExtensions",
    ceiling: 2,
  },
  ensureVectorSlotContribution: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorSlotContributions",
    ceiling: 4,
  },
  ensureVectorSlotContributions: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorSlotContributions",
    ceiling: 1,
  },
  executeDdl: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "ddlExecution",
    ceiling: 13,
  },
  executeRaw: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "rawStatementReuse",
    ceiling: 7,
  },
  executeTemporaryStatement: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "temporaryStatements",
    ceiling: 3,
  },
  findEdgesByEndpointSet: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "endpointSetRead",
    ceiling: 1,
  },
  findEdgesByHeterogeneousEndpointSet: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "heterogeneousEndpointSetRead",
    ceiling: 3,
  },
  fulltextSearch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "fulltextOperations",
    ceiling: 4,
  },
  fulltextStrategy: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "fulltextOperations",
    ceiling: 2,
  },
  getIndexMaterialization: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "indexMaterialization",
    ceiling: 3,
  },
  getIndexMaterializations: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "indexMaterialization",
    ceiling: 2,
  },
  hardDeleteEdgesBatch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 5,
  },
  hybridSearch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "hybridSearch",
    ceiling: 2,
  },
  insertEdgeNoReturn: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 4,
  },
  insertEdgesBatch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 4,
  },
  insertEdgesBatchReturning: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 4,
  },
  insertEdgesDurableBatchReturning: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 8,
  },
  insertNodeNoReturn: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 4,
  },
  insertNodeIfAbsent: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 7,
  },
  insertNodesBatch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 4,
  },
  insertNodesBatchReturning: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 4,
  },
  recordIndexMaterialization: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "indexMaterialization",
    ceiling: 6,
  },
  releaseIndexMaterializationClaim: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "indexMaterialization",
    ceiling: 2,
  },
  trustedImport: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "trustedImport",
    ceiling: 1,
  },
  updateNodeSet: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "batchEntityWrite",
    ceiling: 6,
  },
  upsertEmbedding: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorOperations",
    ceiling: 10,
  },
  upsertEmbeddingBatch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorOperations",
    ceiling: 4,
  },
  upsertFulltext: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "fulltextOperations",
    ceiling: 9,
  },
  upsertFulltextBatch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "fulltextOperations",
    ceiling: 6,
  },
  vectorSearch: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorOperations",
    ceiling: 4,
  },
  vectorStrategy: {
    kind: "deferred",
    workstream: "WS5b",
    bundle: "vectorOperations",
    ceiling: 9,
  },
} as const satisfies Record<string, UnbundledOptionalMember>;

/**
 * The appendix's 15 WS5b bundles, as (bundle id → member names) — written
 * INDEPENDENTLY of `UNBUNDLED_OPTIONAL_MEMBERS`'s `deferred` entries, so the
 * totality proof below is not a tautology: grouping the `deferred` entries
 * by `bundle` must reproduce this table exactly.
 */
export const WS5B_SEED_BUNDLES = {
  batchEntityWrite: [
    "insertNodesBatch",
    "insertNodesBatchReturning",
    "insertEdgesBatch",
    "insertEdgesBatchReturning",
    "insertEdgesDurableBatchReturning",
    "deleteEdgesBatch",
    "hardDeleteEdgesBatch",
    "insertNodeNoReturn",
    "insertNodeIfAbsent",
    "insertEdgeNoReturn",
    "updateNodeSet",
  ],
  endpointSetRead: ["findEdgesByEndpointSet"],
  heterogeneousEndpointSetRead: ["findEdgesByHeterogeneousEndpointSet"],
  vectorOperations: [
    "upsertEmbedding",
    "deleteEmbedding",
    "upsertEmbeddingBatch",
    "deleteEmbeddingBatch",
    "vectorSearch",
    "vectorStrategy",
    "createVectorIndex",
    "dropVectorIndex",
  ],
  hybridSearch: ["hybridSearch"],
  vectorSlotContributions: [
    "assertVectorSlotsInitialized",
    "assertVectorSlotInitialized",
    "ensureVectorSlotContributions",
    "ensureVectorSlotContribution",
    "deleteVectorSlotContribution",
  ],
  fulltextOperations: [
    "upsertFulltext",
    "deleteFulltext",
    "upsertFulltextBatch",
    "deleteFulltextBatch",
    "fulltextSearch",
    "fulltextStrategy",
  ],
  fulltextProvisioning: ["ensureFulltextTable"],
  databaseExtensions: ["ensureExtension", "ensureTrigramExtension"],
  contributionProvisioning: [
    "ensureRuntimeContributions",
    "assertRuntimeContributionsInitialized",
  ],
  indexMaterialization: [
    "getIndexMaterialization",
    "recordIndexMaterialization",
    "getIndexMaterializations",
    "ensureIndexMaterializationsTable",
    "claimIndexMaterialization",
    "releaseIndexMaterializationClaim",
  ],
  ddlExecution: ["executeDdl"],
  temporaryStatements: ["executeTemporaryStatement"],
  rawStatementReuse: ["executeRaw", "compileSql"],
  trustedImport: ["trustedImport"],
} as const satisfies Record<
  Ws5bBundleId,
  readonly OptionalGraphBackendMember[]
>;

// ---------------------------------------------------------------------------
// Compile-time proofs — written exactly as member-classes.ts:288,306-376.
// ---------------------------------------------------------------------------

// Structural, not nominal: reads `core`/`extras` off each bundle directly
// rather than matching against `GatedBundleDefinition`/`GraduatedBundleDefinition`.
// Measured against the compiler: matching the named definition types instead
// (`D extends GatedBundleDefinition<infer MCore, string, infer MExtra> ? …`)
// infers `MCore` correctly but, for a gated bundle with no `extras` field
// (`CLAIMS`), leaves `MExtra` with NO inference candidate — and TypeScript's
// fallback for an unmatched `infer` is the type parameter's CONSTRAINT
// (`OptionalGraphBackendMember`, the full 91), not `never`, silently widening
// `MCore | MExtra` to every optional member. The structural form below has no
// such unmatched parameter: `extras` is read only when the field is actually
// present, so a bundle without one contributes no `ExtrasMembersOf` members
// at all.
type CoreMembersOf<D> = D extends { core: readonly (infer M)[] } ? M : never;
type ExtrasMembersOf<D> =
  D extends { extras: readonly (infer E)[] } ?
    E extends { members: readonly (infer M)[] } ?
      M
    : never
  : never;
type BundleMembers<D> = CoreMembersOf<D> | ExtrasMembersOf<D>;

type BundledMember = BundleMembers<(typeof CAPABILITY_BUNDLES)[number]>;

type ReasonedMember = {
  [
    K in keyof typeof UNBUNDLED_OPTIONAL_MEMBERS
  ]: (typeof UNBUNDLED_OPTIONAL_MEMBERS)[K] extends { kind: "reasoned" } ? K
  : never;
}[keyof typeof UNBUNDLED_OPTIONAL_MEMBERS];

type DeferredMember = {
  [
    K in keyof typeof UNBUNDLED_OPTIONAL_MEMBERS
  ]: (typeof UNBUNDLED_OPTIONAL_MEMBERS)[K] extends { kind: "deferred" } ? K
  : never;
}[keyof typeof UNBUNDLED_OPTIONAL_MEMBERS];

type Ws5bSeedMember = (typeof WS5B_SEED_BUNDLES)[Ws5bBundleId][number];

/**
 * DISJOINTNESS, written to REPORT the offender — `Assert<Equal<Extract<A,
 * B>, never>>` looks like the obvious spelling and is useless here: inside a
 * generic alias `Equal` defers to `boolean`, which satisfies neither `true`
 * nor `false`, so the assertion passes whatever it is given.
 */
type Disjoint<A, B> =
  [Extract<A, B>] extends [never] ? true
  : ["MEMBER CLASSIFIED TWICE", Extract<A, B>];

/* eslint-disable @typescript-eslint/no-unused-vars -- compile-time assertions */

// (i) Totality: the three-way partition covers exactly the 91 optional members.
type _totality = Assert<
  Equal<
    BundledMember | ReasonedMember | DeferredMember,
    OptionalGraphBackendMember
  >
>;

// (ii) Pairwise disjointness, across the partition and across the six bundles.
type _partitionDisjoint1 = Assert<
  Disjoint<BundledMember, ReasonedMember | DeferredMember>
>;
type _partitionDisjoint2 = Assert<Disjoint<ReasonedMember, DeferredMember>>;

type _bundleDisjoint1 = Assert<
  Disjoint<
    (typeof CLAIMS)["core"][number],
    | (typeof UNIQUE_SIDECAR_BATCH)["extras"][number]["members"][number]
    | (typeof BATCH_POINT_READ)["extras"][number]["members"][number]
    | (typeof STATEMENT_EXECUTION)["core"][number]
    | (typeof CONTRIBUTION_HEALTH)["extras"][number]["members"][number]
    | (typeof RECORDED_REVISION_ORIGINS)["core"][number]
  >
>;
type _bundleDisjoint2 = Assert<
  Disjoint<
    (typeof UNIQUE_SIDECAR_BATCH)["extras"][number]["members"][number],
    | (typeof BATCH_POINT_READ)["extras"][number]["members"][number]
    | (typeof STATEMENT_EXECUTION)["core"][number]
    | (typeof CONTRIBUTION_HEALTH)["extras"][number]["members"][number]
    | (typeof RECORDED_REVISION_ORIGINS)["core"][number]
  >
>;
type _bundleDisjoint3 = Assert<
  Disjoint<
    (typeof BATCH_POINT_READ)["extras"][number]["members"][number],
    | (typeof STATEMENT_EXECUTION)["core"][number]
    | (typeof CONTRIBUTION_HEALTH)["extras"][number]["members"][number]
    | (typeof RECORDED_REVISION_ORIGINS)["core"][number]
  >
>;
type _bundleDisjoint4 = Assert<
  Disjoint<
    (typeof STATEMENT_EXECUTION)["core"][number],
    | (typeof CONTRIBUTION_HEALTH)["extras"][number]["members"][number]
    | (typeof RECORDED_REVISION_ORIGINS)["core"][number]
  >
>;
type _bundleDisjoint5 = Assert<
  Disjoint<
    (typeof CONTRIBUTION_HEALTH)["extras"][number]["members"][number],
    (typeof RECORDED_REVISION_ORIGINS)["core"][number]
  >
>;

// (iii) The deferred set and the appendix's seed list name the same members.
type _ws5bSeedEqualsDeferred = Assert<Equal<DeferredMember, Ws5bSeedMember>>;

/* eslint-enable @typescript-eslint/no-unused-vars */
