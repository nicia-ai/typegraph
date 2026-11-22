/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/provenance` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  createRetractionCapability,
  FactNotHoldingError,
} from "@nicia-ai/typegraph/provenance";

export const retraction = (
  ...args: Parameters<typeof createRetractionCapability>
) => createRetractionCapability(...args);
export const notHolding = (
  ...args: ConstructorParameters<typeof FactNotHoldingError>
) => new FactNotHoldingError(...args);
