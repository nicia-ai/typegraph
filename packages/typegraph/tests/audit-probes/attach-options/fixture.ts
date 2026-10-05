import { z } from "zod";

import {
  defineEdge,
  defineGraph,
  defineNode,
  partOf,
  type Store,
} from "../../../src";
import { createInitializedStore, createTestBackend } from "../../test-utils";

export const Book = defineNode("AoBook", { schema: z.object({}) });
export const Chapter = defineNode("AoChapter", {
  schema: z.object({ slug: z.string(), title: z.string().optional() }),
});
export const Show = defineNode("AoShow", { schema: z.object({}) });
export const Clip = defineNode("AoClip", {
  schema: z.object({ slug: z.string(), title: z.string().optional() }),
});
export const ReqClip = defineNode("AoReqClip", {
  schema: z.object({ slug: z.string(), title: z.string().optional() }),
});

export const chapterOf = defineEdge("aoChapterOf", {
  schema: z.object({ order: z.number().int().optional() }),
});
export const clipOf = defineEdge("aoClipOf", {
  schema: z.object({ order: z.number().int().optional() }),
});
export const reqClipOf = defineEdge("aoReqClipOf", {
  schema: z.object({ order: z.number().int().optional() }),
});
export const draftChapterOf = defineEdge("aoDraftChapterOf", {
  schema: z.object({}),
});

const UNIQUE_SLUG = {
  name: "slug",
  fields: ["slug"],
  scope: "kind",
  collation: "binary",
} as const;

export function buildGraph(id: string) {
  return defineGraph({
    id,
    nodes: {
      AoBook: { type: Book },
      AoChapter: { type: Chapter, unique: [UNIQUE_SLUG] },
      AoShow: { type: Show },
      AoClip: { type: Clip, unique: [UNIQUE_SLUG] },
      AoReqClip: { type: ReqClip, unique: [UNIQUE_SLUG] },
    },
    edges: {
      aoChapterOf: {
        type: chapterOf,
        from: [Chapter],
        to: [Book],
        cardinality: "one",
      },
      aoDraftChapterOf: {
        type: draftChapterOf,
        from: [Chapter],
        to: [Book],
        cardinality: "one",
      },
      aoClipOf: {
        type: clipOf,
        from: [Clip],
        to: [Show],
        cardinality: "oneActive",
      },
      aoReqClipOf: {
        type: reqClipOf,
        from: [ReqClip],
        to: [Show],
        cardinality: "oneActive",
      },
    },
    ontology: [
      partOf(Chapter, Book, { via: chapterOf }),
      partOf(Chapter, Book, { via: draftChapterOf }),
      partOf(Clip, Show, { via: clipOf }),
      partOf(ReqClip, Show, { via: reqClipOf, existence: "required" }),
    ],
  });
}

let counter = 0;

export async function createFixtureStore(): Promise<
  Store<ReturnType<typeof buildGraph>>
> {
  counter += 1;
  return createInitializedStore(
    buildGraph(`attach_options_${counter}`),
    createTestBackend(),
  );
}

export const WINDOW_FROM = "2020-01-01T00:00:00.000Z";
export const WINDOW_TO = "2090-01-01T00:00:00.000Z";
export const OTHER_FROM = "2021-06-01T00:00:00.000Z";
export const OTHER_TO = "2095-06-01T00:00:00.000Z";
