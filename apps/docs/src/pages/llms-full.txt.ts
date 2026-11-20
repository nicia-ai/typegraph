import type { APIRoute } from "astro";

// Retired in favor of the single curated /llms.txt plus per-page `.md` files.
// Server-rendered so the redirect is a real HTTP 301 (see sitemap.xml.ts).
export const GET: APIRoute = ({ redirect }) => redirect("/llms.txt", 301);
