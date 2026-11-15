import type { APIRoute } from "astro";

import { loadDocumentPages } from "../lib/document-pages";
import { buildLlmsTxt, PLAIN_TEXT_CONTENT_TYPE } from "../lib/llms";
import { documentationSidebar } from "../lib/sidebar";

export const prerender = true;

export const GET: APIRoute = async () =>
  new Response(buildLlmsTxt(documentationSidebar, await loadDocumentPages()), {
    headers: { "Content-Type": PLAIN_TEXT_CONTENT_TYPE },
  });
