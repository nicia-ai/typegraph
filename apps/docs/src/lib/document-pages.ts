import { getCollection } from "astro:content";

import { type DocumentPage, hasMarkdownTwin } from "./llms";

// Shape of the docs entry fields read here. Declared locally, as in
// src/lib/blog-posts.ts: the docs collection's schema is composed from
// Starlight and starlight-blog and its entry type resolves to `any`.
type DocumentationEntry = Readonly<{
  id: string;
  body?: string;
  data: Readonly<{ title: string; description?: string; draft?: boolean }>;
}>;

// Blog posts are narrative MDX with components, so they are not republished
// as markdown twins.
export async function loadDocumentPages(): Promise<readonly DocumentPage[]> {
  const entries = (await getCollection(
    "docs",
  )) as readonly DocumentationEntry[];
  return entries
    .filter((entry) => hasMarkdownTwin(entry.id) && entry.data.draft !== true)
    .map((entry) => ({
      id: entry.id,
      title: entry.data.title,
      description: entry.data.description ?? "",
      body: entry.body ?? "",
    }));
}
