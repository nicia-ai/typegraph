import { type GraphDef, type GraphIdentityConfig } from "../core/define-graph";
import { type Store } from "../store/store";

/**
 * Rebuilds the derived current identity closure for an identity-enabled store.
 * This is a repair operation: it does not change graph revision or assertions.
 */
export async function rebuildIdentityClosure<
  G extends GraphDef & Readonly<{ identity: GraphIdentityConfig }>,
>(store: Store<G>): Promise<void> {
  await store.rebuildIdentityClosure();
}
