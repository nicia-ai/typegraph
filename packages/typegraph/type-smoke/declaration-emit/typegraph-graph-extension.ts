/**
 * Declaration-emit consumer of `@nicia-ai/typegraph/graph-extension` alone (see `typegraph.ts` in this
 * directory): every export has an inferred type that this entrypoint's
 * declarations spell, and this file's program holds no other entrypoint.
 */
import {
  defineGraphExtension,
  introspectGraphExtension,
  validateGraphExtension,
} from "@nicia-ai/typegraph/graph-extension";

export const extension = defineGraphExtension({
  nodes: {
    Ticket: {
      properties: {
        title: { type: "string" },
        priority: { type: "number", optional: true },
      },
    },
  },
  edges: {
    blocks: { from: ["Ticket"], to: ["Ticket"] },
  },
});

export const introspected = introspectGraphExtension(extension);
export const validated = validateGraphExtension(extension);
