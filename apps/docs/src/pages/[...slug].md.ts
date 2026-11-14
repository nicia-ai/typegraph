import type { APIRoute, GetStaticPaths } from "astro";

import { loadDocumentPages } from "../lib/document-pages";
import { MARKDOWN_CONTENT_TYPE, renderPageMarkdown } from "../lib/llms";

export const prerender = true;

export const getStaticPaths = (async () => {
  const pages = await loadDocumentPages();
  const knownIds: ReadonlySet<string> = new Set(pages.map((page) => page.id));
  return pages.map((page) => ({
    params: { slug: page.id },
    props: { markdown: renderPageMarkdown(page, knownIds) },
  }));
}) satisfies GetStaticPaths;

export const GET: APIRoute = ({ props }) =>
  new Response(String(props.markdown), {
    headers: { "Content-Type": MARKDOWN_CONTENT_TYPE },
  });
