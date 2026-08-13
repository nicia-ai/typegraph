/**
 * The bundle BINDING half (ruling B1): the actual member functions, bound at
 * the call site off whichever port the site holds. The accessor is the
 * SINGLE owner of binding — it never re-derives presence, only reads the
 * verdict's `present`/`missing` fields to decide which names to bind, then
 * binds them off the port passed to it. It throws the bundle's
 * `portSurfaceCode` when the verdict says present and the port disagrees
 * (I20) — the generalization of the check `store/claims/backing.ts:157-169`
 * performs today.
 */
import { ConfigurationError } from "../../errors";
import { createDataKeyedBag } from "../../utils/object";
import { type GraphBackend } from "../types";
import {
  BATCH_POINT_READ,
  CAPABILITY_BUNDLES,
  type CapabilityBundleId,
  CLAIMS,
  CONTRIBUTION_HEALTH,
  type GatedBundleDefinition,
  type OptionalGraphBackendMember,
  RECORDED_REVISION_ORIGINS,
  STATEMENT_EXECUTION,
  UNIQUE_SIDECAR_BATCH,
} from "./bundle-registry";
import {
  type BundleVerdictOf,
  type ExtraMember,
  type ExtrasOf,
  type ExtraVerdict,
} from "./resolve";

/**
 * I21. The brand is what makes a BOUND member type-distinguishable from a
 * PORT member: without it, `binding.getNodes` at a rewired site still has a
 * receiver assignable to `Pick<GraphBackend, …>`, and a syntactic scanner
 * could never tell a bound value from an unbound one.
 */
declare const BUNDLE_BINDING: unique symbol;

/** Every named member, guaranteed present — bound off the port, never a port member itself. */
export type BundleBinding<M extends OptionalGraphBackendMember> = Required<
  Pick<GraphBackend, M>
> &
  Readonly<{ [BUNDLE_BINDING]: true }>;

/**
 * The graduated twin of {@link BundleBinding}: a bundle with no required
 * core cannot promise every member is present, so its bundle-wide "members"
 * accessor (`uniqueSidecarBatchMembers`, `batchPointReadMembers`,
 * `contributionHealthMembers`) reports whichever extras the verdict marks
 * present — never all of them by construction, and never a cast that claims
 * otherwise.
 */
export type PartialBundleBinding<M extends OptionalGraphBackendMember> =
  Readonly<Partial<Pick<GraphBackend, M>>> &
    Readonly<{ [BUNDLE_BINDING]: true }>;

function portSurfaceCodeFor(bundle: CapabilityBundleId): string {
  const definition = CAPABILITY_BUNDLES.find(
    (candidate) => candidate.id === bundle,
  );
  return definition?.portSurfaceCode ?? "BUNDLE_PORT_SURFACE_MISMATCH";
}

function bindNames<const M extends OptionalGraphBackendMember>(
  port: Readonly<Partial<Pick<GraphBackend, M>>>,
  names: readonly M[],
  bundle: CapabilityBundleId,
): Record<string, unknown> {
  const bound = createDataKeyedBag<unknown>();
  const portRecord = port as Readonly<Record<string, unknown>>;
  for (const name of names) {
    const value = portRecord[name];
    if (value === undefined) {
      throw new ConfigurationError(
        `The port passed to capability bundle "${bundle}" is missing "${name}", which the resolved verdict says is present.`,
        {
          code: portSurfaceCodeFor(bundle),
          bundle,
          member: name,
        },
      );
    }
    bound[name] = value;
  }
  return bound;
}

/**
 * Bind a gated bundle's core off the port the calls execute on. The port
 * parameter is the STRUCTURAL MINIMUM over the members (ruling B-1), so
 * every one of the pilot's receiver shapes is accepted:
 * `GraphBackend`, `TransactionBackend`, `WriteTarget`, `IdentityTarget`,
 * `Pick<GraphBackend, "dialect" | "executeStatement">` and the
 * `RevisionOriginBackend`-shaped `Pick<GraphBackend, "dialect" |
 * "ensureRevisionOriginsTable" | "execute" | "executeStatement">`.
 *
 * @throws {ConfigurationError} with the bundle's `portSurfaceCode` when the
 *   verdict says a core member is present and the port lacks it (I20).
 */
export function bindCore<
  const D extends GatedBundleDefinition<
    OptionalGraphBackendMember,
    string,
    OptionalGraphBackendMember
  >,
  M extends D["core"][number],
>(
  port: Readonly<Partial<Pick<GraphBackend, M>>>,
  verdict: Extract<BundleVerdictOf<D>, { supported: true }>,
  definition: D,
): BundleBinding<M> {
  const bound = bindNames(
    port,
    verdict.members as readonly M[],
    definition.id as CapabilityBundleId,
  );
  return bound as BundleBinding<M>;
}

/**
 * Bind one graduated extra. Takes the EXTRA's own verdict, not the bundle's:
 * `requireExtras` (`resolve.ts`) narrows `verdict.extras.someExtra` at an
 * `if`/assertion, not `verdict` as a whole, so a signature demanding the
 * whole narrowed verdict would compile only after that call — the common
 * case is the fallback branch, which never calls `requireExtras` at all.
 *
 * @throws {ConfigurationError} with the bundle's `portSurfaceCode` when the
 *   extra verdict says present and the port lacks the member (I20).
 */
export function bindExtra<const M extends OptionalGraphBackendMember>(
  port: Readonly<Partial<Pick<GraphBackend, M>>>,
  extraVerdict: Extract<ExtraVerdict<M>, { present: true }>,
  bundle: CapabilityBundleId,
): BundleBinding<M> {
  const bound = bindNames(port, extraVerdict.members, bundle);
  return bound as BundleBinding<M>;
}

/**
 * The one owner of "bind every extra the verdict marks present" — the three
 * graduated bundle-wide "members" accessors below each call this with their
 * own bundle id rather than re-spelling the present/absent fold.
 */
function bindPresentExtraVerdicts(
  port: Readonly<Partial<Pick<GraphBackend, OptionalGraphBackendMember>>>,
  extras: Readonly<Record<string, ExtraVerdict<OptionalGraphBackendMember>>>,
  bundle: CapabilityBundleId,
): Record<string, unknown> {
  const bound = createDataKeyedBag<unknown>();
  for (const extraVerdict of Object.values(extras)) {
    if (!extraVerdict.present) continue;
    Object.assign(bound, bindExtra(port, extraVerdict, bundle));
  }
  return bound;
}

export function claimsMembers(
  port: Readonly<Partial<Pick<GraphBackend, (typeof CLAIMS)["core"][number]>>>,
  verdict: Extract<BundleVerdictOf<typeof CLAIMS>, { supported: true }>,
): BundleBinding<(typeof CLAIMS)["core"][number]> {
  return bindCore(port, verdict, CLAIMS);
}

export function statementExecutionMembers(
  port: Readonly<
    Partial<Pick<GraphBackend, (typeof STATEMENT_EXECUTION)["core"][number]>>
  >,
  verdict: Extract<
    BundleVerdictOf<typeof STATEMENT_EXECUTION>,
    { supported: true }
  >,
): BundleBinding<(typeof STATEMENT_EXECUTION)["core"][number]> {
  return bindCore(port, verdict, STATEMENT_EXECUTION);
}

export function recordedRevisionOriginsMembers(
  port: Readonly<
    Partial<
      Pick<GraphBackend, (typeof RECORDED_REVISION_ORIGINS)["core"][number]>
    >
  >,
  verdict: Extract<
    BundleVerdictOf<typeof RECORDED_REVISION_ORIGINS>,
    { supported: true }
  >,
): BundleBinding<(typeof RECORDED_REVISION_ORIGINS)["core"][number]> {
  return bindCore(port, verdict, RECORDED_REVISION_ORIGINS);
}

type UniqueSidecarBatchExtraMember = ExtraMember<
  typeof UNIQUE_SIDECAR_BATCH,
  keyof ExtrasOf<typeof UNIQUE_SIDECAR_BATCH>
>;

export function uniqueSidecarBatchMembers(
  port: Readonly<Partial<Pick<GraphBackend, UniqueSidecarBatchExtraMember>>>,
  verdict: BundleVerdictOf<typeof UNIQUE_SIDECAR_BATCH>,
): PartialBundleBinding<UniqueSidecarBatchExtraMember> {
  const bound = bindPresentExtraVerdicts(
    port,
    verdict.extras,
    UNIQUE_SIDECAR_BATCH.id,
  );
  return bound as unknown as PartialBundleBinding<UniqueSidecarBatchExtraMember>;
}

type BatchPointReadExtraMember = ExtraMember<
  typeof BATCH_POINT_READ,
  keyof ExtrasOf<typeof BATCH_POINT_READ>
>;

export function batchPointReadMembers(
  port: Readonly<Partial<Pick<GraphBackend, BatchPointReadExtraMember>>>,
  verdict: BundleVerdictOf<typeof BATCH_POINT_READ>,
): PartialBundleBinding<BatchPointReadExtraMember> {
  const bound = bindPresentExtraVerdicts(
    port,
    verdict.extras,
    BATCH_POINT_READ.id,
  );
  return bound as unknown as PartialBundleBinding<BatchPointReadExtraMember>;
}

type ContributionHealthExtraMember = ExtraMember<
  typeof CONTRIBUTION_HEALTH,
  keyof ExtrasOf<typeof CONTRIBUTION_HEALTH>
>;

export function contributionHealthMembers(
  port: Readonly<Partial<Pick<GraphBackend, ContributionHealthExtraMember>>>,
  verdict: BundleVerdictOf<typeof CONTRIBUTION_HEALTH>,
): PartialBundleBinding<ContributionHealthExtraMember> {
  const bound = bindPresentExtraVerdicts(
    port,
    verdict.extras,
    CONTRIBUTION_HEALTH.id,
  );
  return bound as unknown as PartialBundleBinding<ContributionHealthExtraMember>;
}
