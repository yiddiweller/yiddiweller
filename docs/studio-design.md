# Studio design system

The permanent shape of the private product. Locked with Build 002, before the
modules that will live inside it are built, so that no future phase has to
redesign the application to add a screen.

The public site's system is in `app/globals.css` and is not changed by this.
Studio inherits its **tokens** — the black, the white-at-opacity secondaries,
the system typeface — and none of its **layout**. That separation is the whole
idea: one company, two interfaces.

> **Quiet outside. Powerful inside. Personal everywhere.**

---

## What Studio is not

Written down because these are the failure modes a private product drifts into
when nobody names them:

- a generic admin panel or a purchased dashboard template
- a wall of cards, one per record
- a colourful SaaS interface with green, red and blue status pills
- a set of screens that each invented their own layout
- a developer prototype with navigation that grew by accident

Studio is an operating surface built for one company. It should look like it
was drawn on purpose, work quickly, and hold a great deal of information
without becoming loud.

---

## The shell — locked

**A left rail on desktop. A drawer on small screens. Nothing else.**

The top navigation Build 002 started with was a prototype: a horizontal strip
is fine for three items and fails at twelve, which is roughly where Studio is
heading. The rail was chosen before the modules exist rather than after,
because changing it later means changing every screen.

```
┌──────────────┬──────────────────────────────────┐
│ YIDDI WELLER │                                  │
│ STUDIO       │   page header                    │
│              │   ─────────────────────────      │
│ Home         │                                  │
│ Team         │   sections                       │
│ Settings     │                                  │
│              │                                  │
│ ───────────  │                                  │
│ Name         │                                  │
│ Owner        │                                  │
│ Sign out     │                                  │
└──────────────┴──────────────────────────────────┘
```

| Region | Holds | Why there |
| --- | --- | --- |
| Identity | Yiddi Weller / Studio | Says whose software this is, once, and never repeats it on a page. |
| Navigation | Only areas that exist | The middle of the rail is where the eye goes back to between tasks. |
| Account | Name, role, sign out | Bottom, out of the way, always reachable. Identity is not a task. |

The rail is 236px, quiet, and typographic: no icons, no boxes, no coloured
active state. The current area is marked by full-contrast text against a
faint surface, which is enough and stays true when the list grows.

**Navigation is grouped in its data, flat in its rendering.** `STUDIO_NAV` is a
list of groups; a group's label only renders when there is more than one. Today
that means three items and no headings. Build 003 adds a second group and the
headings appear on their own, with no layout work.

**Nothing unbuilt appears in navigation.** No greyed-out Clients, no "coming
soon". An area appears in the rail on the day it works.

### Small screens

Not a squeezed rail. Below 1040px the rail becomes a top bar carrying identity,
a menu control and the account, and navigation moves into a drawer that slides
from the left. The drawer is a native `<dialog>`, so the browser provides the
focus trap, the Escape key and the inert background rather than a hand-rolled
imitation of them. It closes on navigation.

Phones get the same information architecture as desktop, in the order a thumb
can reach. Sign in, read inquiries, manage access and sign out all work on a
phone; that is a requirement, not a courtesy.

---

## The page — one architecture

Every Studio page is built from the same three parts, and a new module must not
invent a fourth:

```
page header   eyebrow · title · description · primary action
sections      title · optional action · body
body          list, table, form, empty state, or notice
```

- **Page header.** Title left, one primary action right. The description is one
  line and is used only when the page needs explaining — most do not.
- **Section.** An uppercase label, not a heading that competes with the page
  title. Sections stack with one gap; they never nest.
- **Body.** A list or table by default. A card is for something singular, not
  for every row.

Content sits in a column capped at `--s-page-max`, so a 27-inch display reads
calmly instead of stretching a table to 2,000px. The gutter matches the rail's
padding, so the page and the rail share one vertical rhythm.

---

## Density

Studio will hold a lot of business information, so the default is a **list**,
not a card. Rows are one line tall, aligned on a grid, with the identifying
value at full contrast and everything else stepped down. Row height is a token
(`--s-row-h`) so density can be tuned in one place for the whole product.

Whitespace is used to separate ideas, not to fill space. A large screen should
feel composed, never abandoned.

---

## Colour

`#000000` and `#ffffff`, and white at reduced opacity for everything else. No
grey values, no accent, no brand colour. That constraint is inherited from the
public site and it is not a limitation here — it is what makes Studio look like
this company rather than like software.

**State is communicated by language, weight, contrast and position.** An Owner
is marked by a full-contrast tag with a visible edge; a Member by a quiet one.
An inactive person is labelled *Inactive* and their name steps down in
contrast. An expired invitation says *Expired*.

A colour will be introduced only when a state genuinely cannot be told apart
without one — a destructive confirmation, or a failure that must stop someone.
It has not been needed yet. Destructive actions are distinguished by their
words and by a confirmation step, not by being red.

Every foreground token clears WCAG AA against black; the minimum permitted
opacity is 0.4553, measured in `app/globals.css`.

---

## Typography

One typeface — the reader's own — and a fixed set of roles. Nothing in Studio
should need a size that is not on this list.

| Role | Token | Treatment |
| --- | --- | --- |
| Identity | `--s-fs-label` | Uppercase, 0.3em tracking. Rail only. |
| Page title | `--s-fs-title` | Weight 300, tight tracking. One per page. |
| Section label | `--s-fs-label` | Uppercase, 0.14em, stepped-down contrast. |
| Navigation | `--s-fs-ui` | Sentence case. |
| Row primary | `--s-fs-row` | The identifying value. Full contrast. |
| Row secondary | `--s-fs-ui` | Supporting detail. |
| Metadata | `--s-fs-label` | Dates, counts, tags. Tabular figures. |
| Field label | `--s-fs-label` | Uppercase, above the control. |
| Action | `--s-fs-ui` | Buttons and quiet actions. |

The small uppercase label is a signature of this brand and is kept for labels,
identity and metadata. It is **not** used for anything someone has to read at
length: names, addresses, messages and prose stay sentence case, because
tracked uppercase is slower to read and Studio is for working.

Numbers that line up in a column use `font-variant-numeric: tabular-nums`.

**Every timestamp goes through `components/studio/Moment.tsx`.** The server
renders UTC and labels it; the browser re-renders the same instant in the
viewer's own zone. A Studio module must not call `Intl.DateTimeFormat` itself —
the zone would silently become the server's, which on Railway is UTC and wrong
for whoever is reading. The reasoning is in [`studio.md`](./studio.md).

---

## Spacing and shape

A single 4px-based scale, `--s-1` through `--s-8`, and no arbitrary values.

| Token | Value | Used for |
| --- | --- | --- |
| `--s-rail-w` | 236px | The rail, desktop only. |
| `--s-gutter` | `clamp(20px, 3vw, 40px)` | Page and rail padding. One gutter. |
| `--s-page-max` | 1120px | Content column. |
| `--s-row-h` | 52px | List and table rows. |
| `--s-control-h` | 38px | Buttons, inputs, selects. |
| `--s-hit` | 44px | Minimum touch target on coarse pointers. |

**Radius is zero, everywhere.** Square corners are the public site's language
and the cheapest way to avoid looking like every other dashboard. Elevation is
a hairline or a faint surface, never a shadow.

Surfaces: `--s-surface` (white at 0.03) for a raised panel, `--s-surface-hover`
(0.05) for a row under the pointer. Two, and no more.

---

## Components

Defined once in `app/studio/studio.module.css` and reused. Adding a screen
should mean composing these, not writing new CSS.

| Component | Rule |
| --- | --- |
| Primary button | White on black text. One per page header, at most. |
| Secondary button | Hairline border, transparent fill. |
| Quiet action | Text only, stepped-down until hover. Row-level actions. |
| Destructive action | Quiet, with a confirmation step. Not red. |
| Input, select | Full width of its field, underline only, no box. |
| Field | Label above, control, optional hint below. |
| List row | Grid. Primary, secondary, metadata, action. |
| Tag | Uppercase metadata. Strong or quiet, nothing else. |
| Dialog | Native `<dialog>`, hairline border, square. |
| Empty state | A sentence that says what will appear here, and why it has not. |
| Notice | One line, `role="status"`, with the failure written in words. |
| Skeleton | The shape of the content that is loading, at low contrast. See the rule below before adding one. |

### Loading, and where a skeleton may go

The skeleton component exists and no Studio screen uses one yet, deliberately.
A `loading.tsx` creates a Suspense boundary, the shell flushes before the page
runs, and after that the response status can no longer be set — which turns an
authorization refusal into a 200 carrying a "Not found." page. Studio's pages
answer in milliseconds, so the boundary bought little and cost the one thing
that has to stay exact.

When a screen is genuinely slow enough to need one, the boundary goes **below
every authorization guard**, never above one. The measurements behind that rule
are in [`studio.md`](./studio.md).

### Empty states and errors

Every list has an empty state and it is written, not generic. "No data" tells
someone nothing; "Nothing has come through the contact form yet — it will
appear here" tells them the system is working and what to expect.

Errors say what happened and what to do. No apologies, no error codes in the
interface, no dead ends: every failure screen offers the way forward.

---

## Motion

Opacity and 1–2px of movement, 160–240ms, and only where it explains something:
a dialog arriving, a row responding to the pointer, a control acknowledging a
press. No page transitions — they make software feel slower, and Studio is used
all day. All of it disabled under `prefers-reduced-motion`.

---

## Accessibility

Not a later pass. The rules that hold for every Studio screen:

- One `<h1>` per page, sections below it, headings in order.
- Landmarks: the rail is `<nav>`, the content is `<main>`, and a skip link
  reaches it.
- Every control has a label. Errors are tied to their field.
- Focus is always visible, and the drawer's focus is trapped by the platform.
- Contrast clears AA. Touch targets reach 44px on coarse pointers.
- Nothing is conveyed by colour alone — which is free here, there is no colour.

---

## Keeping domain logic out of the interface

Pages read from `lib/db/*` domain modules and render. They do not build queries,
and they do not hold business rules. Build 003 introduces clients, contacts,
leads and projects; those belong in their own modules beside `inquiries.ts` and
`staff.ts`, with the page staying a view.

Authorization is the same discipline: a page calls a guard, a server action
re-checks. Nothing about access is decided in a component.
