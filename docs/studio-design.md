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

**Every timestamp goes through `components/studio/Moment.tsx`**, and reads
the way the whole product writes time: New York, 12-hour, month first —
*September 24, 2026 · 12:05 AM*, or *Sep 24, 2026 · 12:05 AM* in a dense list
row — the same in the client world. A module must not call
`Intl.DateTimeFormat` itself; the one formatter is `lib/studio-format.ts`. The
reasoning is in [`studio.md`](./studio.md).

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
| Form dialog | A form only occasionally wanted, behind the button that wants it. Native `<dialog>` with `showModal()`, closing as part of the submission that succeeded. |
| Record action | One button that changes one record, carrying the `version` the page was rendered with and showing a refusal where the button is. |
| Confirmation | `ConfirmDialog`. A title naming the action, one sentence on the consequence, Cancel and a button repeating the verb. Never the browser's own. |
| Skeleton | The shape of the content that is loading, at low contrast. See the rule below before adding one. |
| Filter bar | A plain `GET` form above a list: search, one or two selects, a submit. A filtered list is a URL. |
| Chip | A filter or a view, as a link. Active is full contrast with a full-contrast border. |
| Board column | The pipeline. Columns scroll sideways on a narrow screen rather than collapsing into a list, because the shape of the pipeline is the view. |
| Card | One record on a board. The whole card is the link, not a word inside it. |
| Pager | Page *n* of *m* and the two ways out, as links. Absent when everything fits on one page. |
| Prose | Free text somebody wrote, shown as they wrote it. `white-space: pre-wrap`, capped at 68ch. |
| Checkbox | The one control that keeps the browser's own drawing, because nothing we would replace it with says "checkbox" better. It gets a real target and a label beside it. |
| Back link | Uppercase, stepped down, above the page header. A record is reached from a list, and the list is where the rest of the answer is. |

### Confirmations are ours

**Studio never uses `window.confirm`, `alert` or `prompt`.** A browser's own
dialog can offer one line and two anonymous buttons, in the operating system's
typeface, above whatever chrome the browser feels like. It says nothing about
what is about to happen and it looks like a different product.

One component, `ConfirmDialog`, on the same native `<dialog>` and `showModal()`
as every other dialog here — so the focus trap, Escape, the inert background and
returning focus to the trigger are the platform's rather than a reimplementation
that quietly stops working.

**It is the platform's now, not Studio's.** Build 005 gave clients things worth
confirming — taking a comment back, saying a point is dealt with — and
"confirmations are ours" is a rule about the whole product, so there is one
dialog rather than one per world. A modal renders in the browser's **top
layer**, outside whichever `.tokens` root the page has, so `.dialog` composes
that token block onto itself instead of inheriting it. One line of CSS, no
second component, and no copy of the values to drift; inside Studio it is a
no-op, the same values declared one level nearer. Measured in a real browser
inside a Workroom: 32px padding, a 1px rule at `rgba(255,255,255,.18)`, a black
ground, a 38px button, Cancel holding the focus, and Escape mutating nothing.

Three parts, and none of them generic:

```
Publish presentation?
Three files will also be shared with the client.
                                    [Cancel]  [Publish]
```

**A title naming the action, one sentence on the consequence, and a button that
repeats the verb.** Never *Are you sure?*, never *OK*. The last thing somebody
reads before committing is the thing they are about to do.

**Destructive is emphasis, not colour.** The palette is black and white, so a
destructive confirmation gets the outlined button where a constructive one gets
the solid one — less inviting, and legible to somebody who could not have seen
red as red anyway.

**Cancel holds the focus**, so the keyboard's first Enter is the safe one. The
dialog stays open while the action runs, with both buttons locked, and closes
when it returns — so there is no window in which a second press can land.

**Confirmation is for consequence, not for every edit.** Destructive, hard to
undo, access-changing, visibility-changing, publishing or sharing. Sharing a
file asks nothing: it is the everyday action its page exists for, its result is
visible in the row, and *un*-sharing is the direction that now needs a
conversation.

**Verified on beta, and it was found by using the product rather than reading
it.** Manual Stage B acceptance ran into a browser's own dialog on a real
deployment; every occurrence was then classified — needs confirming, belongs
inline as status, or should never have asked — and the ones that stayed were
rebuilt on this component. Retested by hand, publishing a Presentation on beta
now reads:

```
Publish presentation?
One file will also be shared with the client.
                                    [Cancel]  [Publish]
```

No browser chrome, no *Are you sure?*, and the sentence counts the files it is
about to hand over. `tests/dialogs.test.ts` scans `app`, `components` and `lib`
for `confirm(`, `alert(` and `prompt(` so a native one cannot return quietly.

**Adding a screen means composing these.** Build 003 added seven pages and
needed nine new classes, all of them here — no page-local CSS, no inline style,
no one-off spacing value off the 4px scale.

### The shell shrinks

The shell's content column is `minmax(0, 1fr)`, not `1fr`. A bare `1fr` track
refuses to shrink below its content, so the first genuinely wide element inside
it — the pipeline board — stretched the whole page and made every screen scroll
sideways on a phone. It is written that way in both the base rule and the
desktop one, and it is the sort of thing to check whenever a wide component is
added.

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
