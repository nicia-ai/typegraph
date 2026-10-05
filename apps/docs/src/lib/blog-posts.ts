import type { ImageMetadata } from "astro";
import { getCollection } from "astro:content";

// The newest blog posts for pages outside Starlight (the landing page), where
// starlight-blog's route data isn't available. Mirrors the plugin's own
// listing rules so the homepage and /blog agree: posts live under
// content/docs/blog/<slug>/, drafts are hidden from production builds, and
// ordering is newest date first with the title as a tie-breaker.

const BLOG_ID_PREFIX = "blog/";

export type BlogPostSummary = Readonly<{
  href: string;
  title: string;
  excerpt: string | undefined;
  date: Date;
  cover: Readonly<{ alt: string; image: ImageMetadata }> | undefined;
}>;

// Shape of the blog frontmatter fields read here (see starlight-blog/schema
// and src/content.config.ts). Declared locally, as in
// src/components/starlight/Head.astro: the docs collection's schema is
// composed from Starlight and starlight-blog and its entry type resolves to
// `any`, so the fields are typed explicitly at this one boundary.
type CoverFrontmatter =
  | Readonly<{ alt: string; image: ImageMetadata | string }>
  | Readonly<{ alt: string; dark: ImageMetadata | string }>;

type DocumentationEntry = Readonly<{
  id: string;
  data: Readonly<{
    title: string;
    date?: Date;
    excerpt?: string;
    draft?: boolean;
    cover?: CoverFrontmatter;
  }>;
}>;

type BlogEntry = DocumentationEntry &
  Readonly<{ data: Readonly<{ date: Date }> }>;

export async function getLatestBlogPosts(
  count: number,
): Promise<readonly BlogPostSummary[]> {
  const entries = (await getCollection(
    "docs",
  )) as readonly DocumentationEntry[];

  return entries
    .filter((entry): entry is BlogEntry => isPublishedBlogPost(entry))
    .map((entry) => toSummary(entry))
    .toSorted(
      (a, b) =>
        b.date.getTime() - a.date.getTime() || a.title.localeCompare(b.title),
    )
    .slice(0, count);
}

function isPublishedBlogPost(entry: DocumentationEntry): boolean {
  if (!entry.id.startsWith(BLOG_ID_PREFIX)) return false;
  if (entry.data.date === undefined) return false;
  return !(import.meta.env.PROD && entry.data.draft === true);
}

function toSummary(entry: BlogEntry): BlogPostSummary {
  const { title, excerpt, date, cover } = entry.data;
  return {
    href: `/${entry.id}`,
    title,
    excerpt,
    date,
    cover: localCover(cover),
  };
}

// Every post ships a co-located `cover.png` (enforced by
// scripts/check-blog-images.mjs), so covers are local images. The schema
// also admits remote URLs and light/dark pairs; no post uses them, and they
// render without a cover here.
function localCover(
  cover: CoverFrontmatter | undefined,
): BlogPostSummary["cover"] {
  if (cover === undefined || !("image" in cover)) return undefined;
  if (typeof cover.image === "string") return undefined;
  return { alt: cover.alt, image: cover.image };
}
