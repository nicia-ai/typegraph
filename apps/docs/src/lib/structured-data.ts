/**
 * Site-wide JSON-LD entity graph (Organization, WebSite, Person).
 *
 * Kept as a plain module rather than exported from an Astro component:
 * `astro/no-exports-from-components` bans value exports from `.astro`
 * files, and these ids are consumed by pages that never render
 * `<StructuredData />` themselves (e.g. the homepage's FAQPage schema
 * references `organizationId` without instantiating the component).
 */

export const SITE_URL = "https://typegraph.dev";

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const AUTHOR_ID = `${SITE_URL}/#author-pdlug`;

export function buildEntityGraph(): Readonly<{
  "@context": "https://schema.org";
  "@graph": readonly unknown[];
}> {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": ORGANIZATION_ID,
        name: "TypeGraph",
        url: SITE_URL,
        logo: `${SITE_URL}/apple-touch-icon.png`,
        sameAs: [
          "https://github.com/nicia-ai/typegraph",
          "https://www.npmjs.com/package/@nicia-ai/typegraph",
        ],
        founder: { "@id": AUTHOR_ID },
      },
      {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        url: SITE_URL,
        name: "TypeGraph",
        description:
          "TypeScript-first embedded knowledge graph library with reasoning",
        publisher: { "@id": ORGANIZATION_ID },
      },
      {
        "@type": "Person",
        "@id": AUTHOR_ID,
        name: "Paul Dlug",
        url: "https://x.com/pdlug",
        sameAs: ["https://x.com/pdlug", "https://github.com/nicia-ai"],
        worksFor: { "@id": ORGANIZATION_ID },
      },
    ],
  };
}
