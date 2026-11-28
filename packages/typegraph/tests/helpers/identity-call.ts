/**
 * Reaches the internal identity replay functions by module path the way a
 * root `store.identity` call does: a context whose statements go through the
 * store's pooled root, and the call's statement-free refusals run first.
 */
import type { GraphBackend } from "../../src/backend/types";
import type { GraphDef } from "../../src/core/define-graph";
import {
  identityReplay,
  type IdentityReplayOptions,
  identityTransitionsOf,
  identityTransitionWalkRequest,
} from "../../src/identity/replay";
import type { IdentityCallContext } from "../../src/identity/service-types";
import type { IdentityNodeRefInput } from "../../src/identity/types";
import { storeRuntime } from "../../src/store/runtime-port";

/** The root a root identity call's context goes through, as its entry. */
function rootEntry<G extends GraphDef>(
  ctx: IdentityCallContext<G>,
): GraphBackend {
  const backend = ctx.backend;
  if (!("transaction" in backend)) {
    throw new TypeError("A root identity call context goes through the root.");
  }
  return backend;
}

/** The context of a root identity call on `store`. */
export function rootIdentityCallContext<G extends GraphDef>(
  store: Parameters<typeof storeRuntime<G>>[0],
): IdentityCallContext<G> {
  const runtime = storeRuntime(store);
  return { ...runtime.identityContext(), backend: runtime.backend };
}

/** `identityTransitionsOf` as `store.identity.transitionsOf` calls it. */
export async function transitionsOfAt<G extends GraphDef>(
  ctx: IdentityCallContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): ReturnType<typeof identityTransitionsOf<G>> {
  const request = identityTransitionWalkRequest(
    ctx,
    ref,
    options,
    "transitionsOf",
  );
  return identityTransitionsOf(ctx, rootEntry(ctx), request, options);
}

/** `identityReplay` as `store.identity.replay` calls it. */
export async function replayAt<G extends GraphDef>(
  ctx: IdentityCallContext<G>,
  ref: IdentityNodeRefInput<G>,
  options?: IdentityReplayOptions,
): ReturnType<typeof identityReplay<G>> {
  const request = identityTransitionWalkRequest(ctx, ref, options, "replay");
  return identityReplay(ctx, rootEntry(ctx), request, options);
}
