import type { EdgeMatchIdentity } from "../core/types";
import { ConfigurationError } from "../errors";
import type { BackendCapabilities } from "./types";

/** Refuses a declared identity before a backend can silently drop its key. */
export function assertEdgeMatchIdentityBackendSupport(
  identity: EdgeMatchIdentity | undefined,
  capabilities: BackendCapabilities,
  edgeKind: string,
): void {
  if (
    identity === undefined ||
    capabilities.durableEdgeMatchIdentity === true
  ) {
    return;
  }
  throw new ConfigurationError(
    `Backend cannot persist the declared match identity for edge kind "${edgeKind}".`,
    {
      capability: "durableEdgeMatchIdentity",
      edgeKind,
      identityName: identity.name,
    },
  );
}
