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

// The single product description. Mirrored (it cannot be imported) in
// packages/typegraph/package.json and the GitHub repository description.
export const PRODUCT_DESCRIPTION =
  "TypeScript embedded knowledge graph on SQLite and PostgreSQL: Zod schemas, type-safe queries, ontology, hybrid vector + fulltext search, bitemporal history.";

export const NPM_PACKAGE_URL =
  "https://www.npmjs.com/package/@nicia-ai/typegraph";
export const GITHUB_REPOSITORY_URL = "https://github.com/nicia-ai/typegraph";

export const ORGANIZATION_ID = `${SITE_URL}/#organization`;
export const WEBSITE_ID = `${SITE_URL}/#website`;
export const SOFTWARE_ID = `${SITE_URL}/#software`;
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
        sameAs: [GITHUB_REPOSITORY_URL, NPM_PACKAGE_URL],
        founder: { "@id": AUTHOR_ID },
      },
      {
        "@type": "WebSite",
        "@id": WEBSITE_ID,
        url: SITE_URL,
        name: "TypeGraph",
        description: PRODUCT_DESCRIPTION,
        publisher: { "@id": ORGANIZATION_ID },
      },
      {
        "@type": "SoftwareApplication",
        "@id": SOFTWARE_ID,
        name: "TypeGraph",
        alternateName: "@nicia-ai/typegraph",
        description: PRODUCT_DESCRIPTION,
        url: SITE_URL,
        applicationCategory: "DeveloperApplication",
        applicationSubCategory: "Knowledge graph library",
        operatingSystem: "Cross-platform",
        programmingLanguage: "TypeScript",
        license: "https://opensource.org/license/mit",
        codeRepository: GITHUB_REPOSITORY_URL,
        downloadUrl: NPM_PACKAGE_URL,
        installUrl: NPM_PACKAGE_URL,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        author: { "@id": AUTHOR_ID },
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
