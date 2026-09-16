# Blueprint — locked product and domain architecture

Source of truth for every phase from Phase 2 onward. Locked 2026-09-15.
Build numbering is in [`releases.md`](./releases.md).

This records decisions, not plans. Where an implementation choice would
contradict something here, the blueprint wins and the question comes back to
Yiddi Weller rather than being decided in code. Anything marked **locked**
changes only by explicit revision.

---

## The company

**Yiddi Weller**, publicly. **YIDDI WELLER LLC**, legally. A multidisciplinary
design studio: branding, identity, websites, software, product, UI/UX, physical
products, interiors, spatial work, marketing, packaging, and other design
disciplines. The common denominator is design, and the platform should never
imply a narrower specialism than that.

---

## Product principle

> **Quiet outside. Powerful inside. Personal everywhere.**

The system underneath may become very sophisticated. That sophistication must
never force the public site to become visually busy. The deeper someone goes
into the ecosystem, the more functionality they discover.

---

## Domain architecture — locked

Two worlds. Not a collection of technical-looking subdomains.

| World | Domain | Who |
| --- | --- | --- |
| Public and client | `yiddiweller.com` | Visitors and clients |
| Private and team | `studio.yiddiweller.com` | Yiddi, employees, authorised workers |

Everything a visitor or a client ever sees lives under `yiddiweller.com`,
including workrooms, payments, invoices, files and approvals. A client should
feel they are simply inside Yiddi Weller, never that they were transferred into
generic business software.

The internal product is called **Studio**. Not Dashboard, not Admin, not Portal.

### Subdomains that must not be created

```
admin.  dashboard.  app.  portal.  client.  clients.
pay.  files.  auth.  login.  api.
```

Creating any of these requires an explicit revision of this document. A
technical requirement strong enough to justify one should be written down here
before the DNS record exists.

---

## Client URL namespaces

Client-facing routes live under `yiddiweller.com`, on **one prefixed
namespace**:

```
/workrooms/{opaque id}                       a client workroom
/workrooms/{opaque id}/files                 its files
/workrooms/{opaque id}/files/{id}/download   one file
/workrooms/{opaque id}/presentations/{id}    a presentation, review, approval
```

**Revised 2026-09-16, and this replaces an earlier locked design.** This
document previously specified a workroom at a bare slug — `/avio` — with
`/pay/...`, `/invoice/...`, `/files/...` and `/approve/...` reserved as
sibling namespaces at the root, defended by a reserved-slug table.

Build 004 shipped `/workrooms/{26-char opaque id}` instead, which is the option
[`architecture.md`](./architecture.md) described as *"The alternative,
honestly."* The blueprint was not revised at the time, so a locked document and
production disagreed for an entire build. Build 005 settles it in favour of what
production does, because three technical reasons had already accumulated behind
it:

- `middleware.ts` scopes `Cache-Control: private, no-store` and
  `Referrer-Policy: same-origin` to `/workrooms/:path*`. A sibling root
  namespace falls outside that silently — private bytes, no cache header, and
  nothing failing loudly.
- `robots.txt` disallows `/workrooms`. A second private namespace needs its own
  line, and that line was wrong for two builds before it was caught.
- Every authorization guard would need a second entry point. Two doors into one
  room is how the second door gets forgotten.

**Consequences, all locked:**

- **Delivery objects are reached beneath the Workroom that authorizes them.**
  There are no root `/files/...` or `/approve/...` routes, and Build 005 does
  not build any. `/pay/...` and `/invoice/...` are re-decided when Build 006
  plans them; the presumption is now that they are prefixed too.
- **The reserved-slug table is not built and is not needed.** It existed to
  protect a bare-slug address. The prefix removes the collision risk entirely,
  which was the original argument for the alternative.
- **The opaque identifier stays.** No project name, client name or timestamp in
  a client-facing URL, and the identifier is never authorization. See
  [`workrooms.md`](./workrooms.md).
- **Still no new subdomain, for any of it.** The forbidden list below is
  unchanged and `files.` is on it.

### Access levels

| Level | Mechanism | Identity strength |
| --- | --- | --- |
| 1 | Unique private link | None. Possession of a URL. |
| 2 | PIN protected | Resource-level. Proves someone has the PIN. |
| 3 | Authenticated client account | Person-level. |

**A shared PIN is never equivalent to verified identity.** Activity from a PIN
session is attributed to the workroom, never to a named person. The data model
must make overclaiming impossible rather than merely discouraged.

**Levels 1 and 2 are roads not taken.** Build 004 went straight to Level 3:
every client reaches a Workroom through a named, authenticated client identity,
invite-only, with per-person membership checked on every request. There is no
unique-link mode and no PIN mode anywhere in the product, and Build 005 does not
add one — a delivery object is reached by a person, not by whoever holds a URL.
References to PIN sessions elsewhere (`architecture.md`'s `workroom.pin_failed`
example, the attribution rule above) describe a mechanism that was designed for
and never built. They are kept because the *attribution* rule they exist to
state is still correct and still enforced: `audit_events.actor_type` is one of
`team_user`, `client_user` or `anonymous_session`, and a CHECK constraint refuses
a row claiming more than is known.

---

## Information density — locked

| Surface | Density | Keeps |
| --- | --- | --- |
| Public | Extremely minimal | Fold hero, fading header, custom cursor |
| Client | Minimal and functional | The restraint and the typography |
| Studio | Powerful, efficient, structured | Design tokens only |

Studio must be beautifully designed but is real working software: never
decorative at the expense of usability, and never a generic admin template
dropped in without deep adaptation to the Yiddi Weller language.

Public navigation must not advertise internal capability. No Client Portal, no
Dashboard, no Payments, no Files, no Billing, no Login, unless a specific client
flow later needs a deliberately subtle entry point.

---

## What Yiddi Weller owns, and what it does not

| Owned here | Delegated to a provider |
| --- | --- |
| Brand and UI | Card infrastructure (Stripe) |
| Workflow and studio logic | Email transport |
| Client experience | Object storage |
| Data relationships | Other commodity infrastructure |
| Permissions and project structure | |
| Workroom behaviour and portfolio publishing | |

Use an external system only where it materially improves reliability, security
or maintainability. Avoid vendor sprawl. Studio must not attempt to replace
accounting software, banking, payroll or tax systems.

Raw card details are never stored.

---

## Data philosophy

One coherent relational source of truth. No duplicated data, no disconnected
mini-systems, and no requirement to recreate the same client in two places.

The continuous relationship the platform exists to support:

```
visitor → inquiry → lead → client → project → workroom →
presentation → feedback → approval → invoice → payment →
delivery → selected public portfolio → relationship retained in Studio
```

Domains are added deliberately, phase by phase. **No speculative tables.**

---

## Conventions that outlive any single phase

- **Activity and audit stay separate.** Activity is for humans and can be
  filtered or hidden. The audit log is for accountability, is never edited, and
  is not a UI surface. They must never be merged into one ambiguous log.
- **Authorization is enforced server-side.** Hiding a button is not security.
- **Security never depends on obscurity.** A private file is protected by an
  access check, not by an unguessable URL.
- **Notifications are not all email.** Immediate, in-app and digest are distinct
  and the distinction is made before the first notification is sent.
- **Business events, not scattered side effects.** Prefer clear event-driven
  behaviour, but do not build an automation engine prematurely.
- **Privacy is not a later concern.** No hidden visitor profiles, no
  fingerprinting, no unnecessary personal data. Public analytics stay
  privacy-conscious.

---

## Public chat

If the public site gains messaging it must be understated and specific to Yiddi
Weller. Never a generic support widget. No fake urgency, no invented chatbot
personality, no clutter. A restrained label such as **Talk**.

---

## Architecture direction

**One Next.js application.** Do not convert to a monorepo merely because the
platform grows, and do not split simply because Studio exists. Use clear
internal boundaries instead.

Reconsider only on a real operational trigger: independent deployment
requirements, materially different scaling patterns, problematic build times,
team ownership boundaries, security isolation requirements, or major
release-cycle differences.

Infrastructure stays on GitHub, Railway and PostgreSQL, with established
providers where they earn their place.

---

## Build roadmap — locked

Where the platform is going, as builds rather than phases. A build is what ships
and what people refer to; the phase numbering below is the older engineering
sequence and is kept because it is what earlier documents cite.

| Build | Scope | State |
| --- | --- | --- |
| 001 | Core foundation, inquiry persistence | **In production** |
| 002 | Studio foundation, authentication, and the permanent Studio design system | **In production, verified** |
| 003 | Business core: clients, contacts, leads, projects | **In production, verified** |
| 004 | Client workrooms: private client collaboration and controlled access | **In production, verified** |
| 005 | Files, presentations, reviews and approvals | **Architecture locked**, not begun — [`delivery.md`](./delivery.md) |
| 006 | Money: estimates, invoices, payment requests, the public pay flow | |
| 007 | Communications: conversation, Studio inbox, notifications | |
| 008 | Reports, analytics and useful automation | |

Later builds may extend permissions, audit history, portfolio and content
integration, advanced client experiences and operational intelligence. None of
that is built early.

**One system.** Each build adds to the same application, the same database and
the same Studio shell. Nothing on this list justifies a second product, a second
design language, or a rewrite of what is already working.

### Where this roadmap changed the older sequence, and why

The phase table below placed communications and the inbox (Phase 6) *before*
billing (Phase 7), and flagged the risk itself: inbound email is the hardest
problem on the list, billing is mechanically contained, and taking the hard one
first risks stalling the programme before it earns anything. The roadmap
resolves that deliberately — **Money is Build 006 and Communications is Build
007** — rather than leaving the question open.

The files dependency is now settled. **Build 004 delivered the complete
container and no file storage**, deliberately: a Workroom is useful without
files because it answers what the project is, where it has got to, who is
involved and what has happened — and an empty Files tab would have been worse
than no tab. Build 005 fills it, attaching to `workrooms.id` — the model is
[`delivery.md`](./delivery.md), and file bytes live in a private, S3-compatible
Railway Storage Bucket — never in PostgreSQL, never on a volume, and never in
the container filesystem.

### What Build 003 locked for everything after it

These are settled by running code holding real data, not by preference. Build
004 builds on them rather than around them.

- **Workrooms attach to `projects.id` and `clients.id`**, both stable UUIDv7
  primary keys that exist in production. There is no identifier to invent and
  no migration to untangle first.
- **The client-facing world lives under `yiddiweller.com`**, never a new
  subdomain. Build 004 is the first build a client signs into, and that is the
  constraint most easily broken by accident.
- **Client access is a separate system from staff access.** Better Auth with
  `disableSignUp` is Studio's, invite-only, `owner | member`. A client is not a
  `user` row and must not become one.
- **Audit already exists and is append-only.** Build 004's access events are
  audit; the client-facing timeline is Activity, which Build 004 went on to
  build as `workroom_activity`. They stay two tables. `audit_events.entity_type` gains its values by migration, and
  `actor_type` — `team_user | client_user | anonymous_session` — is the
  attribution rule already recorded in `architecture.md`.
- **Every new editable table carries `version` and the `bump_version` trigger**,
  and every new relationship table enforces its own invariants in PostgreSQL.
  Optimistic concurrency is not optional and never compares `updated_at`.
- **Archive, never delete**, with the refusal naming what blocks it.
- **Authorization is called inside the component that reads, before it reads**,
  a `generateMetadata` that reads a record checks the caller too, and no
  `loading.tsx` goes above a guarded page.
- **The Studio interface system is fixed.** New screens compose
  `studio.module.css`; they do not add a layout.

---

## Phase sequence

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Audit and architecture | Complete |
| 1 | Core foundation, inquiry persistence | **Complete — production verified**, released as **Build 001** |
| 2 | Studio foundation, authentication, Studio design system | **Complete — production verified**, released as **Build 002** |
| 3 | Clients, contacts, leads, projects | **Complete — production verified**, released as **Build 003** |
| 4 | Workrooms and private client access | **Complete — production verified**, released as **Build 004** |
| 5 | Files, presentations, reviews and approvals | **Architecture locked**, not begun — [`delivery.md`](./delivery.md) |
| 6 | Conversation hub, Studio inbox, email | |
| 7 | Invoices and payments | |
| 8 | Activity, notifications, automation | |
| 9 | Portfolio CMS, publish to Work | |
| 10 | Reports and studio intelligence | |
| 11 | Public-site refinement and rebrand | |
| 12 | Security, accessibility, performance hardening | |

The sequence may evolve on real engineering dependencies; phase numbering is
not more important than technical correctness. Two dependency questions are
already open and should be settled when Phase 4 is planned rather than now:

- **Files sit inside workrooms.** Phase 4 delivers workrooms and Phase 5
  delivers files, so Phase 4 may produce a container with nothing to put in it.
  Either move file storage earlier or accept that Phase 4 ships incomplete.
- **Inbound email is the hardest item on the list.** Phase 6 places it before
  billing. Billing is more mechanically contained and unlocks revenue, so the
  programme risks stalling on its most difficult problem first.

---

## Scope rule

This document says **where we are going**. It does not say **build everything
now**. Each phase builds what that phase needs, prepares cleanly for the next,
implements nothing distant or speculative, and preserves the public experience.
