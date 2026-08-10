/**
 * Constraint-aware working copies for untrusted ingestion.
 *
 * An ingestion branch persists a mechanically-derived schema with node
 * uniqueness declarations removed. That lets aliases reach merge planning,
 * where canonical candidate generation and final resolved-write validation use
 * the canonical graph's constraints. Every other working-copy constraint stays
 * active during staging.
 */

import { registerIngestionImportTarget } from "../interchange/ingestion-import-target";
import { branch } from "./branch";
import { BranchError } from "./errors";
import type { Result } from "./result";
import { err, isErr, ok } from "./result";
import type {
  GraphDef,
  IdentityAssertionWriteFacade,
  IdentityFacade,
} from "./typegraph-internal";
import { storeBackend } from "./typegraph-internal";
import type {
  BranchOptions,
  GraphBranch,
  IngestionBranch,
  MergeBranch,
} from "./types";
import type { MakeBackend } from "./working-copy";
import { cloneIngestionWorkingCopyStrategy } from "./working-copy";

const PRIVATE_BRANCHES = new WeakMap<object, unknown>();

/** Restricts a full identity facade to the assertions accepted during ingestion. */
function createIngestionIdentityFacade<G extends GraphDef>(
  identity: IdentityFacade<G>,
): IdentityAssertionWriteFacade<G> {
  return Object.freeze({
    assertSame(a, b, window) {
      return identity.assertSame(a, b, window);
    },
    assertDifferent(a, b, window) {
      return identity.assertDifferent(a, b, window);
    },
    bulkAssertSame(pairs) {
      return identity.bulkAssertSame(pairs);
    },
    bulkAssertDifferent(pairs) {
      return identity.bulkAssertDifferent(pairs);
    },
  });
}

/**
 * Creates an isolated ingestion branch whose node uniqueness constraints are
 * deferred until the resolved merge write set is applied.
 *
 * The returned handle deliberately exposes no ordinary Store. Its typed node
 * and edge collections are sufficient to stage and inspect incoming data, and
 * merge entrypoints accept the handle directly. Call `close()` when the working
 * copy is no longer needed.
 */
export async function ingestionBranch<G extends GraphDef>(
  baseStore: GraphBranch<G>["store"],
  makeBackend: MakeBackend,
  options?: BranchOptions,
): Promise<Result<IngestionBranch<G>, BranchError>> {
  try {
    const created = await branch(
      baseStore,
      makeBackend,
      options,
      cloneIngestionWorkingCopyStrategy<G>(makeBackend),
    );
    if (isErr(created)) {
      return err(
        new BranchError("Failed to create constraint-aware ingestion branch", {
          cause: created.error,
        }),
      );
    }
    const privateBranch = created.data;
    const { base, id, store } = privateBranch;
    const identityAccess =
      store.graph.identity === undefined ?
        {}
      : {
          identity: createIngestionIdentityFacade(
            (store as typeof store & Readonly<{ identity: IdentityFacade<G> }>)
              .identity,
          ),
        };
    const handle = Object.freeze({
      id,
      base,
      nodes: store.nodes,
      edges: store.edges,
      ...identityAccess,
      close: async (): Promise<void> => storeBackend(store).close(),
    }) as unknown as IngestionBranch<G>;
    PRIVATE_BRANCHES.set(handle, privateBranch);
    registerIngestionImportTarget(handle, store);
    return ok(handle);
  } catch (error) {
    return err(
      new BranchError("Failed to create constraint-aware ingestion branch", {
        cause: error,
      }),
    );
  }
}

/** Resolves an opaque ingestion handle to its private planner-facing branch. */
function unwrapMergeBranch<G extends GraphDef>(
  input: MergeBranch<G>,
): GraphBranch<G> {
  const privateBranch = PRIVATE_BRANCHES.get(input);
  if (privateBranch !== undefined) {
    return privateBranch as GraphBranch<G>;
  }
  return input as GraphBranch<G>;
}

/** Resolves all public branch inputs once at a merge entrypoint boundary. */
export function unwrapMergeBranches<G extends GraphDef>(
  inputs: readonly MergeBranch<G>[],
): readonly GraphBranch<G>[] {
  return inputs.map((input) => unwrapMergeBranch(input));
}
