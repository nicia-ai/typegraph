import cloudflare from "@astrojs/cloudflare";
import { satteri } from "@astrojs/markdown-satteri";
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, envField, passthroughImageService } from "astro/config";
import starlightBlog from "starlight-blog";

import { documentationSidebar } from "./src/lib/sidebar.ts";
import { PRODUCT_DESCRIPTION } from "./src/lib/structured-data.ts";

// Entrypoints that are only discovered lazily by Vite's dependency
// optimizer (see the "optimize-ssr-deps" plugin comment below) — shared
// between the client and non-client `optimizeDeps.include` lists so they
// can't drift out of sync.
const LAZILY_DISCOVERED_DEPS = [
  "astro/actions/runtime/entrypoints/client.js",
  "astro/assets/services/noop",
  "astro/zod",
  "starlight-blog/middleware",
  "starlight-blog/routes/rss",
  "starlight-blog/routes/rss-archive",
];

// Tailwind's layers must sit below Starlight's. Whichever stylesheet declares a
// layer first fixes its priority, and in `astro dev` the CSS a route emits
// follows its component import order: starlight-blog's routes emit Starlight
// component styles before tailwind.css, which sank `starlight.components` and
// `starlight.content` beneath Tailwind's Preflight and stripped the blog's
// layout. Declaring the order up front makes it independent of emission order.
const CASCADE_LAYER_ORDER =
  "@layer properties, theme, base, components, utilities, starlight;";

export default defineConfig({
  site: "https://typegraph.dev",
  markdown: {
    processor: satteri(),
  },
  vite: {
    plugins: [
      tailwindcss(),
      // Works around a known upstream issue (withastro/astro#16248): Vite's
      // initial crawl only sees statically-imported modules, so
      // integration-injected entrypoints that only get imported once a
      // matching route is actually hit (actions, the passthrough image
      // service, Zod re-exports, starlight-blog's route middleware/RSS
      // feeds) get discovered lazily instead. Each lazy discovery forces a
      // mid-session "optimized dependencies changed" reload, which the
      // Cloudflare/workerd dev runner doesn't survive (`deps_ssr` chunk
      // hashes change out from under an already-warm worker isolate),
      // crashing with "The file does not exist at .../deps_ssr/*.js".
      //
      // The root-level `optimizeDeps.include` below only reliably reaches
      // the client Vite Environment — the SSR/workerd environment
      // (`@cloudflare/vite-plugin`) has its own separate optimizer, so
      // fixing this for real requires `configEnvironment` to inject the
      // include list directly into every non-client environment. This is
      // the same workaround Astro maintainers confirmed fixes the bug
      // (see the issue above) pending an upstream fix in the adapter.
      //
      // If dev crashes again with this error, the offending module is
      // named right before the crash in `astro dev logs` as
      // "dependency optimized: <name>" — add it to this list.
      {
        name: "optimize-ssr-deps",
        configEnvironment(name) {
          if (name === "client") return;
          return {
            optimizeDeps: {
              include: LAZILY_DISCOVERED_DEPS,
            },
          };
        },
      },
    ],
    optimizeDeps: {
      exclude: ["astro/actions/runtime/entrypoints/route.js"],
      include: LAZILY_DISCOVERED_DEPS,
    },
  },
  image: {
    service: passthroughImageService(),
  },
  integrations: [
    starlight({
      components: {
        Head: "./src/components/starlight/Head.astro",
        PageTitle: "./src/components/starlight/PageTitle.astro",
        ThemeProvider: "./src/components/starlight/ThemeProvider.astro",
      },
      routeMiddleware: "./src/starlight-route-data.ts",
      plugins: [
        starlightBlog({
          title: "Blog",
          authors: {
            paul: {
              name: "Paul Dlug",
              title: "Creator of TypeGraph",
              url: "https://x.com/pdlug",
            },
          },
          metrics: {
            readingTime: true,
          },
          // The sidebar lists every post: it defaults to the ten most recent,
          // which left older posts absent with nothing saying so.
          recentPostCount: Infinity,
        }),
      ],
      disable404Route: true,
      title: "TypeGraph",
      description: PRODUCT_DESCRIPTION,
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
      sidebar: documentationSidebar,
      customCss: ["./src/styles/tailwind.css", "./src/styles/custom.css"],
      favicon: "/favicon.svg",
      head: [
        { tag: "style", content: CASCADE_LAYER_ORDER },
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
  env: {
    schema: {
      NICIA_EMAIL_LIST_API_URL: envField.string({
        context: "server",
        access: "secret",
      }),
      NICIA_EMAIL_LIST_API_KEY: envField.string({
        context: "server",
        access: "secret",
      }),
    },
  },
  output: "server",
  // No route in this app touches Astro's session API — opt out of bundling
  // it to cut cold-start parsing overhead on Cloudflare Workers.
  session: false,
  adapter: cloudflare({
    imageService: "passthrough",
    prerenderEnvironment: "node",
    platformProxy: {
      enabled: true,
    },
  }),
});
