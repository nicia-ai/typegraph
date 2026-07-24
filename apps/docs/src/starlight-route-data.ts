import type { StarlightRouteData } from "@astrojs/starlight/route-data";
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

type SidebarEntry = StarlightRouteData["sidebar"][number];

// Shape of the `Astro.locals` fields this middleware reads. Declared
// locally rather than relying on Astro's ambient `App.Locals` type:
// `@astrojs/starlight`'s locals.d.ts isn't reachable from this file under
// typed linting (same issue as src/components/starlight/Head.astro), so
// the boundary is typed explicitly here instead of threading `any` through
// the rest of the file.
interface BlogSidebarLocals {
  t: (key: string) => string;
  starlightRoute: { sidebar: SidebarEntry[] };
}

// Starlight bolds every top-level (un-nested) sidebar link (see the
// `.large` class in @astrojs/starlight's SidebarSublist.astro) — fine when
// links sit inside collapsible groups, but once the "Recent posts" group
// below is flattened to top level, every post title would read as bold,
// not just the active one. Tag flattened links with this class so
// custom.css can un-bold everything except the active page.
const RECENT_LINK_CLASS = "blog-recent-link";

function markAsRecentLink(entry: SidebarEntry): SidebarEntry {
  if (entry.type !== "link") return entry;
  return {
    ...entry,
    attrs: {
      ...entry.attrs,
      class: [entry.attrs.class, RECENT_LINK_CLASS].filter(Boolean).join(" "),
    },
  };
}

// starlight-blog replaces the sidebar on every blog route with All posts /
// Featured posts / Recent posts / Tags / Authors / RSS. That's a lot of
// near-empty sections for a blog with a couple of posts and one author.
// Simplify it to "All posts" plus a flat list of recent posts — no
// collapsible "Recent posts" wrapper, no Tags/Featured/Authors groups, no
// RSS link (RSS itself stays on: the feed and the header icon are
// unaffected, this only prunes the sidebar link).
//
// Registered via `routeMiddleware` in astro.config.mjs. Runs `next()` first
// so it executes AFTER starlight-blog's middleware has built the sidebar —
// see https://starlight.astro.build/guides/route-data/#how-to-customize-route-data.
export const onRequest = defineRouteMiddleware(async (context, next) => {
  await next();

  const { t, starlightRoute } = context.locals as unknown as BlogSidebarLocals;
  const recentLabel = t("starlightBlog.sidebar.recent");

  // Only blog routes get a sidebar with a "Recent posts" group — every
  // other route's sidebar comes from the static `sidebar` config in
  // astro.config.mjs and must be left untouched.
  const isBlogSidebar = starlightRoute.sidebar.some(
    (entry) => entry.type === "group" && entry.label === recentLabel,
  );
  if (!isBlogSidebar) return;

  const rssLabel = t("starlightBlog.sidebar.rss");

  starlightRoute.sidebar = starlightRoute.sidebar.flatMap(
    (entry): SidebarEntry[] => {
      if (entry.type === "group") {
        return entry.label === recentLabel ?
            entry.entries.map((recentEntry) => markAsRecentLink(recentEntry))
          : [];
      }
      return entry.label === rssLabel ? [] : [entry];
    },
  );
});
