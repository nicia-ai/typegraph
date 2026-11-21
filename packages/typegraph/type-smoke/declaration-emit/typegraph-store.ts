/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/store` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  defineSubgraphProject,
  indexSubgraph,
  StoreSearch,
  StoreView,
} from "@nicia-ai/typegraph/store";

export const projectFor = (...args: Parameters<typeof defineSubgraphProject>) =>
  defineSubgraphProject(...args);
export const indexed = (...args: Parameters<typeof indexSubgraph>) =>
  indexSubgraph(...args);
export const viewOf = (...args: ConstructorParameters<typeof StoreView>) =>
  new StoreView(...args);
export const searchOf = (...args: ConstructorParameters<typeof StoreSearch>) =>
  new StoreSearch(...args);
