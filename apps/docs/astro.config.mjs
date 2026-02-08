import cloudflare from "@astrojs/cloudflare";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, passthroughImageService } from "astro/config";
import starlightLlmsTxt from "starlight-llms-txt";

export default defineConfig({
  site: "https://typegraph.dev",
  vite: {
    plugins: [tailwindcss()],
  },
  image: {
    service: passthroughImageService(),
  },
  integrations: [
    starlight({
      components: {
        Head: "./src/components/starlight/Head.astro",
      },
      plugins: [
        starlightLlmsTxt({
          promote: ["overview*", "getting-started*", "core-concepts*"],
          demote: ["ejecting*", "examples/*"],
          customSets: [
            {
              label: "Examples",
              paths: ["examples/*"],
              description:
                "Complete application examples demonstrating TypeGraph patterns",
            },
          ],
        }),
      ],
      title: "TypeGraph",
      description:
        "TypeScript-first embedded knowledge graph library with reasoning",
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: true,
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/nicia-ai/typegraph",
        },
      ],
      sidebar: [
        {
          label: "Getting Started",
          items: [
            { label: "What is TypeGraph?", slug: "overview" },
            { label: "Quick Start", slug: "getting-started" },
            { label: "Project Structure", slug: "project-structure" },
          ],
        },
        {
          label: "Guides",
          items: [
            { label: "Schemas & Types", slug: "core-concepts" },
            { label: "Ontology & Reasoning", slug: "ontology" },
            { label: "Semantic Search", slug: "semantic-search" },
            { label: "Backend Setup", slug: "backend-setup" },
            { label: "Schema Migrations", slug: "schema-management" },
            { label: "Multiple Graphs", slug: "multiple-graphs" },
            { label: "Import/export", slug: "interchange" },
          ],
        },
        {
          label: "Query Builder",
          items: [
            { label: "Overview", slug: "queries/overview" },
            { label: "Source", slug: "queries/source" },
            { label: "Filter", slug: "queries/filter" },
            { label: "Traverse", slug: "queries/traverse" },
            { label: "Recursive", slug: "queries/recursive" },
            { label: "Shape", slug: "queries/shape" },
            { label: "Aggregate", slug: "queries/aggregate" },
            { label: "Order", slug: "queries/order" },
            { label: "Temporal", slug: "queries/temporal" },
            { label: "Compose", slug: "queries/compose" },
            { label: "Combine", slug: "queries/combine" },
            { label: "Execute", slug: "queries/execute" },
            { label: "Subqueries", slug: "queries/advanced" },
            { label: "Predicates", slug: "queries/predicates" },
          ],
        },
        {
          label: "Recipes",
          items: [
            { label: "Common Patterns", slug: "recipes" },
            { label: "Data Sync", slug: "data-sync" },
            { label: "Integration Patterns", slug: "integration" },
          ],
        },
        {
          label: "Examples",
          items: [
            {
              label: "Knowledge Graph for RAG",
              slug: "examples/knowledge-graph-rag",
            },
            {
              label: "Document Management",
              slug: "examples/document-management",
            },
            { label: "Product Catalog", slug: "examples/product-catalog" },
            { label: "Workflow Engine", slug: "examples/workflow-engine" },
            { label: "Audit Trail", slug: "examples/audit-trail" },
            { label: "Multi-Tenant SaaS", slug: "examples/multi-tenant" },
          ],
        },
        {
          label: "Performance",
          items: [
            { label: "Overview", slug: "performance/overview" },
            { label: "Indexes", slug: "performance/indexes" },
            { label: "Query Profiler", slug: "performance/profiler" },
          ],
        },
        {
          label: "Reference",
          items: [
            { label: "Schemas & Stores", slug: "schemas-stores" },
            { label: "Types", slug: "types" },
            { label: "Errors", slug: "errors" },
            { label: "Troubleshooting", slug: "troubleshooting" },
            { label: "Limitations", slug: "limitations" },
            { label: "Architecture", slug: "architecture" },
            { label: "LLM Support", slug: "llm-support" },
          ],
        },
        {
          label: "Ejecting",
          slug: "ejecting",
        },
      ],
      customCss: ["./src/styles/tailwind.css", "./src/styles/custom.css"],
      favicon: "/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
        },
        {
          tag: "link",
          attrs: {
            rel: "icon",
            type: "image/png",
            sizes: "32x32",
            href: "/favicon-32.png",
          },
        },
        {
          tag: "link",
          attrs: {
            rel: "apple-touch-icon",
            sizes: "180x180",
            href: "/apple-touch-icon.png",
          },
        },
        {
          tag: "script",
          attrs: { type: "module", src: "/diagram.js" },
        },
      ],
    }),
  ],
  output: "server",
  adapter: cloudflare({
    imageService: "passthrough",
    platformProxy: {
      enabled: true,
    },
  }),
});
