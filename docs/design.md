# Venstock design

The visual system for the vendor app (`public/`), the staff admin page, and the public site (`site/`). The
direction is still to be chosen (see "Directions" below). Once it is, this file records the final tokens, and
`public/tokens.css` is the only place they are defined.

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

`tests/contrast.unit.test.mjs` checks every pair declared in `public/tokens.css`. That test arrives with the
tokens file, in the first apply stage.

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
- **Tap targets are at least 48px.** The sale total and Complete sale are the largest things on the register.
- **Color is never the only signal:** errors, sold out and failed sales always carry words.
- **Motion:** none beyond what the app needs (the toast and the cart sheet), and none at all under
  `prefers-reduced-motion`.
- **No emoji as icons.** The theme toggle reads "Dark" / "Light".

## Directions (choose one)
Both previews show login, the sale register and the items list, in light and dark. Serve the repo root locally
and open them (browsers block fonts from `file://`):

```bash
python3 -m http.server 8000 --bind 127.0.0.1
# http://127.0.0.1:8000/design/preview/a.html   (add #dark for dark mode, or use the button)
# http://127.0.0.1:8000/design/preview/b.html
```

- **A: Field.** The screen is built from flat color fields: a sky header band, a cream catalog, a deep-blue
  order panel with a huge cream total, and orange for Complete sale. Items are tiles separated by sage gaps,
  and a selected item fills sky blue. Mustard marks the active category and deals. Login is a 5/7 split with a
  deep-blue field holding the stacked wordmark.
  Pros: very legible at arm's length in sun; quick to scan by color; tiles suit fast tapping.
  Cons: louder; more color to keep balanced on the busier screens.
- **B: Ledger.** Cream paper, ink, and thick rules instead of boxes. Categories sit in a left rail, items are
  ruled rows, and the order panel is separated by a 6px rule. Color appears only where the money is: a
  deep-blue block for the total, orange for the action. Login sets the lowercase wordmark huge along the
  bottom, with the form in a narrow ruled column.
  Pros: calmer and more distinctive; rows fit long item names and more items per screen.
  Cons: rows are a smaller target than tiles for fast tapping; relies more on type than on color.

Not yet decided: A, B, or a mix (for example B's register rows with A's header band).
