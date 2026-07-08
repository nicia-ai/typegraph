import { docsLoader, i18nLoader } from "@astrojs/starlight/loaders";
import { docsSchema, i18nSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro:content";
import { blogSchema } from "starlight-blog/schema";

export const collections = {
  docs: defineCollection({
    loader: docsLoader(),
    // Extend the docs schema with starlight-blog's frontmatter fields (date,
    // tags, excerpt, featured, draft, authors, cover). Only files under blog/
    // use them.
    schema: docsSchema({ extend: (context) => blogSchema(context) }),
  }),
  i18n: defineCollection({ loader: i18nLoader(), schema: i18nSchema() }),
};
