import { type DatabaseSync } from "@dolthub/doltlite";

import { ConfigurationError } from "../../errors";
import { backendDerivationChain } from "../derive-backend";
import { type DoltliteBackendOptions } from "./index";

export type DoltliteSource = Readonly<{
  connection: DatabaseSync;
  options: DoltliteBackendOptions;
}>;
const sources = new WeakMap<object, DoltliteSource>();

export function registerDoltliteSource(
  backend: object,
  source: DoltliteSource,
): void {
  sources.set(backend, source);
}

export function resolveDoltliteSource(backend: object): DoltliteSource {
  for (const candidate of backendDerivationChain(backend)) {
    const source = sources.get(candidate);
    if (source !== undefined) return source;
  }
  throw new ConfigurationError(
    "This store does not own a DoltLite connection",
    { code: "DOLTLITE_CONNECTION_REQUIRED" },
  );
}
