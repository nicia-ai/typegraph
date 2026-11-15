/** Which backend member one `Store.clear()` deletes its graph through. */
import type { GraphBackend, TransactionBackend } from "../backend/types";
import { UnsupportedBackendCapabilityError } from "../errors";

type ClearGraphCommand = GraphBackend["clearGraph"];

const CLEAR_OPERATION =
  "store.clear({ preserveContributionMaterializations: true })";
const PRESERVING_CLEAR_MEMBER =
  "clearGraphPreservingContributionMaterializations";

/**
 * - `preserve: false` clears through `clearGraph`, markers included.
 * - `preserve: true` is a stated requirement: a backend without the
 *   preserving member cannot honor it and is refused, never silently cleared
 *   through `clearGraph`.
 * - An omitted option prefers the preserving member and otherwise keeps a
 *   custom backend's own `clearGraph` behavior.
 */
export function resolveClearGraphCommand(
  target: GraphBackend | TransactionBackend,
  preserve: boolean | undefined,
): ClearGraphCommand {
  if (preserve === false) return target.clearGraph;
  const preservingClear =
    target.clearGraphPreservingContributionMaterializations;
  if (preservingClear !== undefined) return preservingClear;
  if (preserve === undefined) return target.clearGraph;
  throw new UnsupportedBackendCapabilityError(
    CLEAR_OPERATION,
    PRESERVING_CLEAR_MEMBER,
    {},
    `Use a backend that implements ${PRESERVING_CLEAR_MEMBER}, or omit the option to clear through the backend's own clearGraph.`,
  );
}
