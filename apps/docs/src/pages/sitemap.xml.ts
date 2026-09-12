import type { APIRoute } from "astro";

// @astrojs/sitemap (bundled by Starlight) publishes the real sitemap at
// /sitemap-index.xml. Some crawlers and SEO tooling only ever look for the
// conventional /sitemap.xml path, so alias it here rather than duplicating
// the generated index.
//
// This must stay server-rendered (no `prerender = true`): Astro serves a
// prerendered redirect as a static HTML meta-refresh page marked `noindex`,
// which is not valid sitemap XML and defeats the alias. Rendering on request
// emits a real HTTP 301 with a `Location` header instead.
export const GET: APIRoute = ({ redirect }) =>
  redirect("/sitemap-index.xml", 301);
