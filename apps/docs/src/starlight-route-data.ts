import type { StarlightRouteData } from "@astrojs/starlight/route-data";
import { defineRouteMiddleware } from "@astrojs/starlight/route-data";

type SidebarEntry = StarlightRouteData["sidebar"][number];
type SidebarLink = Extract<SidebarEntry, { type: "link" }>;

// Where a blog page links back to the post list, resolved from the sidebar
// starlight-blog built so the URL and label stay the plugin's own. Set on
// `Astro.locals` for every blog page except the list itself; read by
// src/components/starlight/PageTitle.astro.
export interface BlogIndexLink {
  href: string;
  label: string;
}

// Shape of the `Astro.locals` fields this middleware reads. Declared
// locally rather than relying on Astro's ambient `App.Locals` type:
// `@astrojs/starlight`'s locals.d.ts isn't reachable from this file under
// typed linting (same issue as src/components/starlight/Head.astro), so
// the boundary is typed explicitly here instead of threading `any` through
// the rest of the file.
interface BlogSidebarLocals {
  t: (key: string) => string;
  starlightRoute: { sidebar: SidebarEntry[] };
  blogIndexLink?: BlogIndexLink;
}

// Starlight bolds every top-level (un-nested) sidebar link (see the
// `.large` class in @astrojs/starlight's SidebarSublist.astro) — fine when
// links sit inside collapsible groups, but once the "Recent posts" group
// below is flattened to top level, every post title would read as bold,
// not just the active one. Tag flattened links with this class so
// custom.css can un-bold everything except the active page.
const RECENT_LINK_CLASS = "blog-recent-link";

// The "All posts" link back to the list gets its own class so custom.css can
// set it apart from the posts beneath it and mark it as a way back.
const INDEX_LINK_CLASS = "blog-index-link";

function withLinkClass(entry: SidebarEntry, className: string): SidebarEntry {
  if (entry.type !== "link") return entry;
  return {
    ...entry,
    attrs: {
      ...entry.attrs,
      class: [entry.attrs.class, className].filter(Boolean).join(" "),
    },
  };
}

// starlight-blog replaces the sidebar on every blog route with All posts /
// Featured posts / Recent posts / Tags / Authors / RSS. That's a lot of
// near-empty sections for a blog with a couple of posts and one author.
// Simplify it to "All posts" plus a flat list of posts — no collapsible
// "Recent posts" wrapper, no Tags/Featured/Authors groups, no RSS link (RSS
// itself stays on: the feed and the header icon are unaffected, this only
// prunes the sidebar link). The list holds every post (`recentPostCount` in
// astro.config.mjs), so the reader can always see where a post sits.
//
// Registered via `routeMiddleware` in astro.config.mjs. Runs `next()` first
// so it executes AFTER starlight-blog's middleware has built the sidebar —
// see https://starlight.astro.build/guides/route-data/#how-to-customize-route-data.
export const onRequest = defineRouteMiddleware(async (context, next) => {
  await next();

  const locals = context.locals as unknown as BlogSidebarLocals;
  const { t, starlightRoute } = locals;
  const recentLabel = t("starlightBlog.sidebar.recent");
  const indexLabel = t("starlightBlog.sidebar.all");

  // Only blog routes get a sidebar with a "Recent posts" group — every
  // other route's sidebar comes from the static `sidebar` config in
  // astro.config.mjs and must be left untouched.
  const isBlogSidebar = starlightRoute.sidebar.some(
    (entry) => entry.type === "group" && entry.label === recentLabel,
  );
  if (!isBlogSidebar) return;

  const rssLabel = t("starlightBlog.sidebar.rss");

  const indexLink = starlightRoute.sidebar.find(
    (entry): entry is SidebarLink =>
      entry.type === "link" && entry.label === indexLabel,
  );
  if (indexLink !== undefined && !indexLink.isCurrent) {
    locals.blogIndexLink = { href: indexLink.href, label: indexLink.label };
  }

  starlightRoute.sidebar = starlightRoute.sidebar.flatMap(
    (entry): SidebarEntry[] => {
      if (entry.type === "group") {
        return entry.label === recentLabel ?
            entry.entries.map((recentEntry) =>
              withLinkClass(recentEntry, RECENT_LINK_CLASS),
            )
          : [];
      }
      if (entry.label === rssLabel) return [];
      return [
        entry.label === indexLabel ?
          withLinkClass(entry, INDEX_LINK_CLASS)
        : entry,
      ];
    },
  );
});
