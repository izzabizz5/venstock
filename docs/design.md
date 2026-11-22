# Venstock design

The visual system for the vendor app (`public/`), the staff admin page, and the public site (`site/`). The chosen
direction is **A, "Field"** (see "Direction" below). `public/tokens.css` is the only place colours, type, space and
rule widths are defined; `site/public/tokens.css` is an exact copy (a test checks); every other stylesheet uses
`var()` only.

## The reference, and what we take from it
The mood board (`design/reference/mood.png`, gitignored: it is someone else's artwork) is a reference for mood
only. It shows:

- **Palette:** large flat fields with no gradients or texture on the UI itself. A sky-blue band, cream and
  mustard split down the middle, a deep-blue base. Mid blue is used for type on light fields. Orange appears
  exactly once, as a small accent. A pale sage grey forms a thin divider band.
- **Type personality:** a heavy, very wide display face; a soft, chunky serif with rounded terminals for the
  secondary headline; small, bold, widely tracked uppercase for navigation and footer links.
- **Composition:** full-bleed horizontal bands and one hard vertical split. A change of color stands in for a
  border, and text sits directly on the color field.

**What we take:** the palette relationships (cool blues against warm cream and mustard, orange used sparingly)
and the three-voice type personality.
**What we don't take:** its layout, logo, mascot, illustrations, sunburst and blob shapes, ticker strip,
headline copy, or anything else that identifies that brand. Venstock's screens are a point-of-sale tool and are
laid out for that job.

## Palette
Sampled from the board, plus three derived colors the board doesn't have but a readable UI needs.

| Token        | Hex       | From      | Used for |
|--------------|-----------|-----------|----------|
| sky          | `#8CB9CE` | board     | fields, selected items (ink text only) |
| cream        | `#F6F4D6` | board     | the page; text on deep blue and on dark |
| mustard      | `#C6B44E` | board     | small flags: deals, the active filter (ink text only) |
| deep blue    | `#17609B` | board     | the money block / order panel; cream text |
| mid blue     | `#4A87D6` | board     | large type and decoration only (3.3:1 on cream) |
| orange       | `#F2A24B` | board     | the one primary action per screen; ink text; ink edge on cream |
| sage         | `#D8DDD5` | board     | hairlines between rows |
| ink          | `#10263D` | derived   | body text, thick rules |
| muted ink    | `#4A5866` | derived   | secondary text |
| brick        | `#A3341C` | derived   | errors, sold out, failed sales (always with words) |
| dark ground  | `#0D1B2A` | derived   | dark mode page |
| dark surface | `#132B44` | derived   | dark mode bands and selection |
| dark line    | `#2C4A69` | derived   | dark mode hairlines (decorative only) |
| dark muted   | `#A9B8C6` | derived   | dark mode secondary text, input edges |
| dark brick   | `#F08A6C` | derived   | dark mode errors |

### Contrast, which decides who can carry text (WCAG: 4.5:1 body, 3:1 large text and UI edges)
| Pair | Ratio | Allowed for |
|------|-------|-------------|
| ink on cream | 13.8 | everything |
| ink on sky / mustard / orange | 7.3 | everything |
| ink on sage | 11.1 | everything |
| cream on deep blue | 5.9 | everything |
| muted ink on cream | 6.5 | body |
| brick on cream | 6.1 | body |
| deep blue on sky / mustard | 3.1 | large text only, so avoided |
| mid blue on cream | 3.3 | large text only |
| orange on cream | 1.9 | **never** for text; an orange button on cream gets an ink edge |
| cream on dark ground | 15.6 | everything |
| sky / mustard / orange on dark ground | 8.2–8.3 | everything |
| dark muted on dark ground | 8.6 | body |
| dark brick on dark ground | 7.1 | body |

`tests/contrast.unit.test.mjs` checks every `@pair` declared at the top of `public/tokens.css`, in light and dark,
and fails if a stylesheet uses a text colour that no pair declares. To add a colour pairing, declare it there first.

### Roles (what style.css actually uses)
Components never use a palette colour directly; they use a role, and each role has a light and a dark value.

| Role | Light | Dark | Used for |
|------|-------|------|----------|
| `--page`, `--text`, `--text-2` | cream, ink, muted ink | dark ground, cream, dark muted | the page and its text |
| `--surface` | cream | dark surface | popups, sheets |
| `--band`, `--on-band` | sky, ink | dark surface, cream | the header band |
| `--panel`, `--on-panel`, `--panel-hair` | deep blue, cream | same | the order panel, totals, the running show |
| `--tile`, `--tile-on`, `--hair` | cream, sky, sage | ground, dark surface, dark line | item tiles, selected tile, hairlines |
| `--stripe` | `#ECE9C6` | `#122438` | every other row in the items list |
| `--edge`, `--rule` | ink | dark muted, cream | control edges (2px), structural rules (6px) |
| `--mark`, `--on-mark` | mustard, ink | same | active filter, deals, notices, invites, support banner |
| `--action`, `--on-action`, `--action-edge` | orange, ink, ink | orange, ink, orange | the one main action |
| `--invert-bg`, `--invert-fg` | ink, cream | cream, ink | current tab, badges, toast, header warnings |
| `--danger`, `--alert-bg`, `--on-alert` | brick, brick, cream | dark brick, dark brick, ink | errors and failed sales |
| `--focus`, `--focus-on-panel` | ink, cream | cream, cream | the 3px square focus outline |

## Type scale, space and rules
| Token | Value | Use |
|-------|-------|-----|
| `--fs-label` | 12px | tracked uppercase labels and navigation |
| `--fs-s` | 14px | secondary text |
| `--fs-m` | 16px | body (inputs never go below 16px on phones, so they don't zoom) |
| `--fs-l` | 20px | small headings |
| `--fs-xl` | 28px | section and popup headings |
| `--fs-2xl` | 40px | page titles |
| `--fs-total` | 22px | the sale total: bold and wide, just above the 16px subtotal |
| `--s1`…`--s7` | 4, 8, 12, 16, 24, 32, 48px | the only spacing steps |
| `--tap` | 48px | minimum height and width of anything tappable |
| `--hair-w`, `--edge-w`, `--rule-w` | 2px, 2px, 6px | hairlines, control edges, structural rules |
| `--header-h`, `--panel-w`, `--banner-h` | 64px, 400px, 48px | header (56px on phones), order panel, support banner |

**Why:** a point of sale used outdoors needs big targets, big numbers and high contrast before anything else. A
few spacing steps and three rule weights give the hard-edged, ruled look without boxes or shadows.

## Type
Two families, both under the SIL Open Font License, self-hosted as subsetted Latin WOFF2 (71 KB together; the
budget is 150 KB). License texts sit next to the files in `public/fonts/`.

| Role | Face | Setting |
|------|------|---------|
| Display: shop name, totals, page titles | Archivo | `wght` 900, `wdth` 125, tight tracking |
| Labels, navigation, buttons | Archivo | `wght` 700, `wdth` 125, uppercase, tracking .14em, 12–15px |
| Body | Archivo | `wght` 400–600, `wdth` 100, 16px, word spacing .05em |
| Secondary headlines: screen titles, "This sale", empty states | Fraunces | SOFT 100, opsz 72, `wght` 700 |
| Prices and totals | Archivo | `font-variant-numeric: tabular-nums lining-nums` |

Fallbacks: `"Arial Black", Arial, sans-serif` and `Georgia, serif`. Never Inter, Roboto, Poppins, DM Sans,
Space Grotesk or system-ui as the visible face.

**Why these two:** Archivo's width axis gives both the heavy wide display voice and the wide-tracked label voice
from one file, and it stays plain and legible at body sizes. Fraunces' soft axis gives the chunky, rounded serif
without a third family.

**How the files were made** (fonttools 4.46, from github.com/google/fonts `ofl/archivo` and `ofl/fraunces`):
- Archivo: the variable font limited to `wdth` 100–125 and `wght` 400–900.
- Fraunces: instanced at SOFT 100, WONK 0, opsz 72, wght 700.
- Both subset to U+0020–007E, U+00A0–00FF, curly quotes, dashes, the ellipsis, €, ™, arrows and the minus sign.
- Layout features kept: kern, liga, tnum, lnum, pnum, case, ccmp, locl, mark, mkmk, calt. Hinting dropped, WOFF2.

## Rules (non-negotiable, enforced by tests where a test can)
- **No rounded corners:** `border-radius` is 0 on every element, including focus rings.
- **No soft shadows, gradients, glassmorphism or backdrop blur.** No hover "lift" or scale animations, and no
  skeleton shimmer.
- **Flat color fields and thick rules** (2px hairline, 3px field edge, 6px structural rule) instead of boxes.
- **Orange is the one primary action** on a screen (Complete sale, Log in, Add item). It is never used for
  decoration.
- **Tap targets are at least 48px**, with two exceptions chosen so more fits on screen: inside the phone order
  sheet they are 44px (Apple's minimum), and the Sell catalog is set about 30% smaller (search and Restock 36px,
  category filters 34px, item tiles 84–96px tall, item text 12–16px). Complete sale is the strongest thing on the register; the total is bold, just above the
  subtotal.
- **Color is never the only signal:** errors, sold out and failed sales always carry words.
- **Motion:** none beyond what the app needs (the toast and the cart sheet), and none at all under
  `prefers-reduced-motion`.
- **No emoji as icons.** The theme toggle reads "Dark" / "Light".

## Direction: A, "Field" (chosen 2026-11-22)
The screen is built from flat color fields; a change of color stands in for a border.
- **Header:** a sky band. The current tab is an ink block. On phones the tabs move to a bar along the bottom.
  The staff admin page uses an ink header instead, so it can never be mistaken for a vendor's shop.
- **Sell:** cream item tiles separated by sage gaps; an item in the order fills sky blue with a count in its
  corner. The order panel is the deep-blue "money field" with the total (bold and wide, just above the subtotal)
  and the orange Complete sale. On phones the order is a sheet opened from a deep-blue bar above the tabs.
- **Other screens:** ruled sections (a 6px rule and a serif heading) with hairline rows. Repeated per-row buttons
  are dark or outlined, so orange stays one main action per section. Deep blue marks money (show totals, the
  running show). Mustard marks deals, notices, invites, the support banner and the support-link countdown. Brick
  marks failed sales, always with words.
- **Login:** a deep-blue field with the stacked wordmark beside the form (above it on phones).
- **Public site:** the same tokens and fonts, one page per header link: Home (`/`: the opening with the
  product's own order panel drawn in HTML, then a ruled index of the other pages), What it is (`/what`), How it
  works (`/how`), Pricing (`/pricing`) and Join (`/join`, the one
  orange button). Every page title sits on the same ink band. Each page has one palette colour (What sky, How mid
  blue, Pricing mustard, Join orange) used only as small details: the stripe under its band, the underline of its
  header tab, the squares beside facts and its marker in the home index; the footer carries all four as a strip.
  `--accent-text` (deep blue; sky in dark) colours numerals and small labels. Type is set smaller than the app's
  (16px body) except the header. Each page ends with a full-width "Next" link. No images, no scripts, no third-party anything.

**B, "Ledger"** (cream, ink, ruled rows, a category rail) was the alternative. It was calmer, but its rows are
smaller targets than A's tiles for fast tapping at a busy table.

Both previews stay in `design/preview/` for reference. Serve the repo root to open them (browsers block fonts
from `file://`):

```bash
python3 -m http.server 8000 --bind 127.0.0.1
# http://127.0.0.1:8000/design/preview/a.html   (add #dark for dark mode, or use the button)
# http://127.0.0.1:8000/design/preview/b.html
```
