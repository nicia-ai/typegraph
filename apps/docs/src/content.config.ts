import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { z } from "astro/zod";
import { defineCollection } from "astro:content";
import { blogSchema } from "starlight-blog/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    // Extend the docs schema with starlight-blog's frontmatter fields (date,
    // tags, excerpt, featured, draft, authors, cover) plus our own `social`
    // field. Only files under blog/ use them.
    //
    // `cover` and `social` are deliberately separate images: `cover` is a
    // title-free illustration rendered on the page (blog index + post
    // header), while `social` bakes the title in and is used only for the
    // og:image/twitter:image share card (see
    // src/components/starlight/Head.astro) — so the title isn't shown
    // twice. Each post is a directory (blog/<slug>/index.mdx) with its own
    // co-located generate-images.mjs, cover.png, and social.png — see
    // blog/_template/ for the starting point.
    schema: docsSchema({
      extend: (context) =>
        blogSchema(context).extend({
          social: z
            .object({
              alt: z.string(),
              image: z.union([context.image(), z.string()]),
            })
            .optional(),
        }),
    }),
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
