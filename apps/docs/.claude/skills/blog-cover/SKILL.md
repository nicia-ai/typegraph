---
name: blog-cover
description: Generate the cover + social images a new apps/docs blog post needs (src/content/docs/blog/<slug>/index.mdx), following this project's established two-image, content-accurate design system. Use when creating or publishing a new blog post, or when asked to add/regenerate a post's cover art.
---

# Blog cover + social image generation

Applies to `apps/docs`. Every post is a directory —
`src/content/docs/blog/<slug>/` — containing `index.mdx`,
`generate-images.mjs`, `cover.png`, and `social.png` side by side. Copy
`src/content/docs/blog/_template/` to start a new one. Every published
(non-draft) post needs both PNGs: `cover` (shown on the page) and `social`
(used only for the OG/Twitter share card). `scripts/check-blog-images.mjs`
enforces this at build time — a post without both fields fails
`pnpm typecheck` / `pnpm build`.

## Why two images, not one

Never bake the post title into the on-page `cover` image — it duplicates the
`<h1>` that renders right below it. `cover` is title-free; `social` reuses
the same illustration with the title overlaid, and is never rendered on the
page (see `src/components/starlight/Head.astro`, which picks `social` over
`cover` for `og:image`/`twitter:image`).

## Why co-located, not a parallel scripts/ + assets/ tree

Earlier versions of this system kept a bespoke `scripts/generate-<name>-diagram.mjs`
per post in `apps/docs/scripts/` and the resulting PNGs in
`src/assets/blog/`, both growing in parallel with (and separately from)
`src/content/docs/blog/`. Three directories to touch for one post is worse
than one. Now everything about a post — content, the script that generated
its images, and the images themselves — lives in one folder. Shared
primitives (`lib/blog-art.mjs`, the generic fallback generator) stay in
`apps/docs/scripts/` since they don't grow per post; every per-post script
reaches them via the `#blog-art` / `#generic-blog-image` subpath imports
declared in `apps/docs/package.json`'s `"imports"` field — these resolve
correctly from any folder depth, so never write a relative `../../../lib/...`
path by hand.

## Step 0: bespoke diagram, or generic fallback?

Ask: does this post have a concrete mechanism, example, or before/after
worth drawing — something a reader who'd read the post would recognize?
(A retraction cascade, a state machine, a before/after diff, a request
flow.) If yes, build a bespoke diagram (Step 1a). If the post is a meta/
announcement post with nothing concrete to visualize, use the generic
seeded-graph fallback (Step 1b). Never generate generic abstract art for a
post that has a real diagram to draw — that's the exact "just an image with
a background" problem this system was built to avoid. Both must still avoid
AI-slop: precise labeled shapes and purposeful color, not decorative
gradients-with-random-shapes.

## Step 1a: bespoke diagram (preferred when there's real content)

Copy `src/content/docs/blog/graph-merge/generate-images.mjs` into your new
post's folder as your starting point — it's a worked example, not a generic
template with parameters. Read it first. Pattern to follow:

- Import shared chrome from `"#blog-art"` (resolves to
  `scripts/lib/blog-art.mjs`): `CANVAS_WIDTH` (1200), `CANVAS_HEIGHT` (630),
  `CONTENT_SAFE_TOP` (150 — keep diagram content below this so it doesn't
  collide with the logo in the top-left corner),
  `renderIllustrationBackground()`, `renderLogoMark()`, `layoutTitle()`,
  `renderTitleLines()`, `svgDocument()`, `escapeXml()`.
- Hand-lay-out nodes/edges as plain JS objects with explicit x/y/w/h — do
  not force-generate a layout algorithmically. The value of a bespoke
  diagram is that a human (or you, deliberately) chose the layout to match
  the post's own narrative.
- Color language (light canvas — see "Palette" below): rounded-rect nodes,
  solid-fill accent color for "origin" nodes, outlined white-fill boxes for
  downstream nodes, monospace font for code-identifier labels
  (`font-family: ui-monospace, SFMono-Regular, Menlo, monospace`), a
  contrasting "dead/negative" state (dashed border, muted text, red accent)
  when the post's example has one.
- `generateCoverSvg()`: background + diagram + logo. No title text.
- `generateSocialSvg()`: same diagram scaled/translated into the right
  portion of the canvas (see the `translate(420, 153) scale(0.66)` pattern),
  with `layoutTitle()`/`renderTitleLines()` placed in the clear left column
  — not overlapping the diagram, so no scrim/dimming is needed.
- Size everything for **display width, not native size**: the blog content
  column renders these at ~700-900px, well under the 1200px canvas. Err on
  the side of large text (20px+), thick strokes (2.5-3px), and few enough
  elements that it reads at a glance when scaled down. Verify by rendering
  at 720px display width, not just at native 1200px (see Step 2).
- **No kicker line above the diagram, no footer line below it.** Sandwiching
  the diagram between a thin caption strip at the top and another at the
  bottom was the default in early posts and reads badly: that text is
  necessarily smaller than the diagram's own labels, so it's the first thing
  that becomes illegible once the image is scaled down (a blog-index
  thumbnail, a social-card preview, a phone screen). If a fact needs stating,
  attach it directly to the diagram element it describes — a label beside a
  node, an annotation on a connector — at the same font size as the rest of
  the diagram's labels (15px+), not shrunk into a one-line caption. If nothing
  in the diagram needs an annotation, leave the space empty; the post's own
  prose carries the explanation.
- **Draw the mechanism the title names, not a static comparison.** A diagram
  captioned "merge" needs lines that visually converge into one point or one
  shape — the same visual grammar as a git graph or a river confluence — not
  two independent straight connectors that each land on a different side of
  a box. The same discipline applies to any post whose title is a verb:
  "retract" should show something detaching or graying out, "replay" should
  show a sequence re-entering, "split" should show one thing dividing into
  two. Before drawing, ask what specific visual movement the verb implies,
  then make sure every connector or transform in the diagram performs that
  movement — juxtaposing three boxes side by side is a comparison, not the
  action the title promises.

Run it from anywhere — it writes into `--out-dir`, not its own folder:

```bash
node src/content/docs/blog/<slug>/generate-images.mjs --out-dir /tmp/blog-images
```

## Step 1b: generic fallback (meta/announcement posts only)

`_template/generate-images.mjs` already calls the generic fallback by
default. Edit its `SLUG`/`TITLE` constants to match the new post, then:

```bash
node src/content/docs/blog/<slug>/generate-images.mjs --out-dir /tmp/blog-images
```

This deterministically seeds an abstract node graph from `SLUG` — same
visual language, no content-specific meaning. Produces `<slug>-cover.svg`
and `<slug>-social.svg` (same slug-prefixed naming as the bespoke path —
see Step 2). (The underlying generator,
`scripts/generate-blog-images.mjs` / `"#generic-blog-image"`, also runs
standalone with `--slug`/`--title`/`--out-dir` flags if you need it outside
a post's own wrapper.)

## Palette (light canvas)

The canvas background is light (`renderIllustrationBackground()` — pale
blue-white gradient), not dark. Do not reuse dark-background colors (light
text on navy) — they'll wash out. Use:

- Text: `#0f172a` (dark navy) primary, `#64748b` (slate) muted/secondary.
- Accent/live state: `#2563eb` blue family (`#1d4ed8`, `#3b82f6`, `#1e40af`
  for variety).
- Dead/negative/retracted state: `#dc2626` red, dashed strokes.
- Node fills: white (`#ffffff`) for outlined boxes, solid `#2563eb` for
  "origin"/source-style nodes with white text.

## Step 2: rasterize SVG → PNG with the `browse` skill

Navigating directly to a raw `file:///path.svg` **times out** — Chromium's
SVG document viewer doesn't behave like a normal page load. Wrap the SVG in
a sized container div inside a minimal HTML file first. Both generator
paths (Step 1a and Step 1b) write `<slug>-cover.svg`/`<slug>-social.svg`
into `--out-dir` — substitute your post's actual slug for `<slug>` below:

```bash
for f in <slug>-cover <slug>-social; do
  {
    echo '<div id="art" style="width:1200px;height:630px;line-height:0;">'
    cat "/tmp/blog-images/$f.svg"
    echo '</div>'
  } > "/tmp/blog-images/$f.html"
done
```

Then, using the `browse` skill:

```bash
$B viewport 1200x630 --scale 1
$B goto "file:///tmp/blog-images/<slug>-cover.html"
$B screenshot "/tmp/blog-images/<slug>-cover.png" --selector "#art"
# repeat for <slug>-social.html
```

Also render at display size to check legibility before finalizing — this is
the check that catches "looks fine at 1200px, unreadable in the actual blog
column":

```bash
cat > /tmp/blog-images/display-check.html <<'EOF'
<div style="width:720px;line-height:0;">
EOF
cat "/tmp/blog-images/<slug>-cover.svg" >> /tmp/blog-images/display-check.html
echo '</div>' >> /tmp/blog-images/display-check.html
$B viewport 760x420 --scale 2
$B goto "file:///tmp/blog-images/display-check.html"
$B screenshot /tmp/blog-images/display-check.png
```

Read the resulting PNGs (Read tool) before moving on — confirm labels are
legible, nothing clips off-canvas, and the logo isn't overlapping content.

## Step 3: install the images

```bash
cp /tmp/blog-images/<slug>-cover.png src/content/docs/blog/<slug>/cover.png
cp /tmp/blog-images/<slug>-social.png src/content/docs/blog/<slug>/social.png
```

The template's frontmatter already points at `./cover.png` / `./social.png`
— nothing to edit there unless you're changing the `alt` text:

```yaml
cover:
  alt: "Description of the illustration itself — not the post title"
  image: "./cover.png"
social:
  alt: "<Post Title>"
  image: "./social.png"
```

`cover.alt` describes what's drawn (e.g. "Diagram of X flowing into Y, with
Z retracted"), since it's decorative content, not a title restatement.
`social.alt` is the post title, since that's what the share card conveys.

## Step 4: verify

```bash
node scripts/check-blog-images.mjs   # must report all posts OK
pnpm typecheck
```

Then look at the actual rendered page (`pnpm dev`, visit `/blog` and the
post) before calling this done — confirm the cover shows once, the title
shows once (in the `<h1>`, not baked into the image), and nothing clips at
~900px content-column width.
