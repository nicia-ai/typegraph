/** CLI wiring for the maintained DoltLite adapter. */
import {
  createDoltliteBackend,
  type DoltliteBackendOptions,
} from "../../src/backend/doltlite";
export { executeDoltliteVersionControl as runVersionControl } from "../../src/backend/doltlite/version-control";

export function openDoltlite(
  path = ":memory:",
  options: Pick<
    DoltliteBackendOptions,
    "schemaProvisioning" | "capabilities"
  > = {},
) {
  return createDoltliteBackend({ ...options, path, vector: false });
}
