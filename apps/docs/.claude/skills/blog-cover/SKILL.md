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
enforces this at build time, along with the mechanical rules in
"What the linter enforces" below.

## The one rule this system exists to enforce

**A cover shows a subject acting on a field. It is never an arrangement of
labelled boxes at rest.**

Everything below is a consequence of that sentence. It comes from a review
of all fifteen published covers (2026-08) in which eleven were rejected —
including several that drew their post's mechanism correctly and were still
judged furniture. Drawing the mechanism is necessary and **not sufficient**.
The four covers that survived all share one property: something in the
picture is happening *to* something else, and the canvas holds enough
material for that action to be visible.

Two tests, both cheap, both mandatory before you rasterize:

1. **The field test.** Is there something for the subject to act *on* — a
   population, a sequence, a spread of peers? A diagram whose entire content
   is three to five boxes has no field, and no arrangement of those boxes
   will fix it.
2. **The label-deletion test.** Delete every text label. Can a reader still
   name what is happening? `runtime-schema-evolution` fails this exactly:
   three identical boxes labelled STAGE 1 / STAGE 2 / STAGE 3. The word
   "evolution" appears; nothing in the picture evolves.

Do not try to satisfy this with a number. It was tested: ink coverage,
drawn-element count, and text count were each measured across all fifteen
covers against the human verdict, and **none of them separated the kept
covers from the rejected ones** — the densest cover in the corpus was a
reject, and kept covers ranged from 18 to 107 drawn shapes. This is a
composition judgment. Make it by looking at the picture.

## Step 0: choose a pattern by name

Pick one of the six patterns below and write its name in a comment at the
top of your `generate-images.mjs`. If the post's content does not fit any of
them, that is a signal worth pausing on: either the post has a subject you
have not identified yet, or you are about to invent a seventh pattern, which
is allowed but should be deliberate and added to this list afterwards.

Check the pattern is not already used by an adjacent post. Two covers built
on the same pattern read as duplicates — `graph-merge` and
`operational-identity` are near-identical compositions, and that similarity
was one of the review's complaints.

### 1. Field with a lit path — `graph-algorithms`

A dense field of muted peers; one route through it drawn in the accent
colour with a soft halo. The field is the point: the route only means
something because of everything it passed over.

Use for: selection, routing, search, ranking, shortest/cheapest path,
"the one that wins".

### 2. Fan — `infinite-graph-databases`

One subject at the left, opening through a widening wedge into many
instances at the right, most of them muted and a few picked out in accent.

Use for: provisioning, multiplicity, tenancy, scale, one-becomes-many.

### 3. Streams converging on a record — `materializing-event-streams`

Two or more long horizontal sequences, each carrying many tick marks,
sweeping through S-curves into a single solid node. Length matters: the
sequences should cross most of the canvas so the convergence has travel.

Use for: ingestion, materialization, reconciliation, merge, fusion.

**Beware the short version.** `graph-merge` is this pattern with the
sequences amputated down to two boxes each, and it was rejected as static.
Convergence with no travel is not convergence; it is four boxes and a curve.

### 4. Cascade with a dead branch — `truth-maintenance-for-agent-memory`

A propagation tree where one arm is alive in accent and a parallel arm is
dashed, greyed and struck through — the same structure shown in two states
at once.

Use for: retraction, invalidation, blocking, propagation, cache/index
teardown, anything where a change travels and something downstream dies.

### 5. Containment inversion — `portable-stores`

Two nested-ring diagrams where the inner and outer layers swap, with the
change drawn twice over: the sizes are exaggerated (a small core becomes the
whole outer ring; the ring collapses to a dot), and two arcs cross in the
gap between them, one running outside-to-centre and the other
centre-to-outside. The crossing IS the inversion.

Use for: dependency inversion, a public type surface changing, something
that was unavoidable becoming an internal detail, encapsulation moving.

This pattern is the standing exception to the field test. Two circles are
not a field, and an earlier pass through this list wrongly proposed redrawing
`portable-stores` for that reason. Containment is a real mechanism and
concentric rings are its natural notation — when the post's subject *is* a
nesting relationship changing, draw the nesting. What that cover did need
was the removal of the two explanatory captions under each circle: they
restated in words what the geometry already said, and were the first thing
to become illegible when the cover was scaled down.

### 6. Measured comparison — a real chart

For posts whose payload is *measurements* rather than a mechanism. Plot the
data: paired before/after bars, a scaling curve, a latency distribution.
Use `renderBarComparison()` from `#blog-art` (see
`src/content/docs/blog/_reference/chart-cover.mjs` for a worked example).

**This pattern exists to kill the stat grid.** Before it, numeric posts had
no sanctioned option and both `typegraph-0-35-performance` and
`serverless-write-fusion` degraded into grids of cards containing
before/after numerals — the "text in boxes" failure that prompted this
rewrite. A number set in a rounded rectangle is not a visualization of that
number. If you are drawing a card with a figure in it, stop and plot it.

## Named failure modes

Each of these is a real rejected cover. If your draft resembles one, you
have the wrong pattern, not a fixable draft.

| Failure | Cover | What it looks like |
| --- | --- | --- |
| The box chain | `runtime-schema-evolution` | N equal boxes at the same y, joined by arrows. Fails the label-deletion test. |
| The stat grid | `typegraph-0-35-performance`, `serverless-write-fusion` | Cards containing numerals. A slide, not a picture. |
| The icon row | `type-safety-sweep` | Three unrelated glyphs, captions underneath, canvas two-thirds empty. |
| The stacked pair | `operational-identity` | Two unrelated diagrams sharing one frame, reading as a split screen. |
| The seeded scatter | `introducing-typegraph` | Abstract generated graph that means nothing. |
| The short convergence | `graph-merge` | Correct mechanism, no travel, reads as furniture. |

## The generic fallback is retired

`#generic-blog-image` (`scripts/generate-blog-images.mjs`) deterministically
seeds an abstract node graph from the slug. **Do not use it for a new post.**
It produces the seeded-scatter failure above by construction — it cannot
know anything about the post, so it can never show a subject acting on a
field. It remains in the tree only because `introducing-typegraph` still
depends on it pending that cover's rework.

A meta or announcement post with "no mechanism to draw" is nearly always a
post whose subject has not been identified yet. An announcement is about a
*change*: something that was one way and is now another, or something that
did not exist and now does. That is a fan, a cascade, or a before/after —
not an excuse for abstract art.

## Palette (light canvas)

The canvas background is light (`renderIllustrationBackground()` — pale
blue-white gradient), not dark. Do not reuse dark-background colors (light
text on navy) — they'll wash out.

- Text: `#0f172a` (dark navy) primary, `#64748b` (slate) muted/secondary.
- Accent/live state: `#2563eb` blue family (`#1d4ed8`, `#3b82f6`, `#1e40af`).
- Dead/negative/retracted: `#dc2626` red, dashed strokes.
- Node fills: white (`#ffffff`) outlined boxes, solid `#2563eb` for
  "origin"/source nodes with white text.
- **Field elements**: muted grey (`#cbd5e1`, `#e2e8f0`) or accent at low
  opacity. Every pattern above depends on a legible gap between the subject
  and its field — if the field is as loud as the subject, there is no
  subject.

## Building the generator

Copy the reference generator for your chosen pattern out of
`src/content/docs/blog/<its cover's slug>/generate-images.mjs`. Read it
before editing it. Then:

- Import shared chrome from `"#blog-art"` (`scripts/lib/blog-art.mjs`):
  `CANVAS_WIDTH` (1200), `CANVAS_HEIGHT` (630), `CONTENT_SAFE_TOP` (150 —
  keep diagram content below this so it clears the logo),
  `renderIllustrationBackground()`, `renderLogoMark()`, `layoutTitle()`,
  `renderTitleLines()`, `svgDocument()`, `escapeXml()`, `renderConnector()`,
  `leftAnchor()`, `rightAnchor()`, `renderBarComparison()`.
  These resolve from any folder depth — never write a relative
  `../../../lib/...` path.
- Hand-lay-out nodes/edges as plain JS objects with explicit x/y/w/h. Do not
  force-generate a layout algorithmically; the value of a bespoke diagram is
  that the layout was chosen to match the post's narrative. (A *field* of
  peers may be generated — that is background, not subject.)
- Monospace for code identifiers:
  `ui-monospace, SFMono-Regular, Menlo, monospace`.
- `generateCoverSvg()`: background + diagram + logo. **No title text** — it
  would duplicate the `<h1>` that renders directly below it.
- `generateSocialSvg()`: the same diagram scaled and translated into the
  right portion of the canvas (the `translate(420, 153) scale(0.66)`
  pattern), with `layoutTitle()`/`renderTitleLines()` in the clear left
  column, so no scrim is needed.

Run it from anywhere — it writes into `--out-dir`, not its own folder:

```bash
node src/content/docs/blog/<slug>/generate-images.mjs --out-dir /tmp/blog-images
```

## What the linter enforces

`scripts/lib/cover-lint.mjs` runs on every published post at
`pretypecheck`/`prebuild`. It renders your generator and checks:

- **Canvas is exactly 1200x630.** No 2x variants — `type-safety-sweep`
  shipped at 2400x1260 and nothing caught it.
- **No label below 15px.** The 1200px canvas renders in a ~760px blog
  column, so a 13px label lands at roughly 8px. Five covers shipped with
  12–13px text that is unreadable in place.
- **No text in the kicker band** (y 120–190) **or the footer band**
  (y > 555). Sandwiching the diagram between thin caption strips puts the
  smallest text in the image at the top and bottom, where it is the first
  thing to become illegible when scaled down. If a fact needs stating,
  attach it to the element it describes at the same size as the diagram's
  other labels.

Covers that already broke these rules are listed in `LINT_BACKLOG` in
`check-blog-images.mjs` and report without failing the build. The list is a
ratchet: remove a slug when you fix its cover — if a listed cover starts
passing, the check fails until it is removed, so the list cannot go stale.

The linter deliberately does **not** check composition. It cannot; see the
measurement note under "The one rule". The patterns above are yours to
apply, and the two tests are yours to run.

## Rasterize SVG to PNG with the `browse` skill

Navigating directly to a raw `file:///path.svg` **times out** — Chromium's
SVG viewer doesn't behave like a normal page load. Wrap the SVG in a sized
container div in a minimal HTML file first:

```bash
for f in <slug>-cover <slug>-social; do
  {
    echo '<div id="art" style="width:1200px;height:630px;line-height:0;">'
    cat "/tmp/blog-images/$f.svg"
    echo '</div>'
  } > "/tmp/blog-images/$f.html"
done
```

Then:

```bash
$B viewport 1200x630 --scale 1
$B goto "file:///tmp/blog-images/<slug>-cover.html"
$B screenshot "/tmp/blog-images/<slug>-cover.png" --selector "#art"
# repeat for <slug>-social.html
```

## Look at it at the size readers see

This is the check that has historically been skipped, and skipping it is why
five covers shipped with 8px effective text. Reviewing a cover at native
1200px tells you almost nothing.

**The `svg{width:100%;height:auto}` rule below is load-bearing.** Earlier
versions of this file wrapped the SVG in a `width:760px` div and nothing
else — which scales nothing, because the generated SVG carries a literal
`width="1200" height="630"` that wins over its container. That recipe
rendered at full size while appearing to test the small one, and is the
most likely reason unreadable labels kept shipping past this step.

```bash
cat > /tmp/blog-images/display-check.html <<'EOF'
<style>svg{display:block;width:100%;height:auto}body{margin:0;font:12px system-ui}</style>
<p>760px (blog column)</p><div style="width:760px">
EOF
cat "/tmp/blog-images/<slug>-cover.svg" >> /tmp/blog-images/display-check.html
echo '</div><p>300px (index thumbnail)</p><div style="width:300px">' >> /tmp/blog-images/display-check.html
cat "/tmp/blog-images/<slug>-cover.svg" >> /tmp/blog-images/display-check.html
echo '</div>' >> /tmp/blog-images/display-check.html
$B viewport 800x640 --scale 2
$B goto "file:///tmp/blog-images/display-check.html"
$B screenshot /tmp/blog-images/display-check.png
```

Read the PNG (Read tool) and confirm: every label legible at 760px, nothing
clipped, logo clear of content, and — the one that matters — **the picture
still reads as something happening**, not as boxes.

The 300px pane is the sterner test, and it is about shape, not text. Labels
are expected to go small there; what must survive is the composition. A
cover that becomes an indistinct smudge is too dense. One that becomes three
grey rectangles is furniture, and no amount of relabelling will save it —
go back to Step 0 and pick a different pattern.

## Install and verify

```bash
cp /tmp/blog-images/<slug>-cover.png src/content/docs/blog/<slug>/cover.png
cp /tmp/blog-images/<slug>-social.png src/content/docs/blog/<slug>/social.png
node scripts/check-blog-images.mjs   # must report OK
pnpm typecheck
```

The template's frontmatter already points at `./cover.png` / `./social.png`:

```yaml
cover:
  alt: "Description of the illustration itself — not the post title"
  image: "./cover.png"
social:
  alt: "<Post Title>"
  image: "./social.png"
```

`cover.alt` describes what is drawn ("A lit path crossing a field of muted
citation nodes"), since it is illustrative content, not a title restatement.
`social.alt` is the post title, since that is what the share card conveys.

Finally, look at the rendered page (`pnpm dev`, visit `/blog` and the post):
the cover shows once, the title shows once in the `<h1>` and not in the
image, and nothing clips at the content column's width.
