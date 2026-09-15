# Blueprint — locked product and domain architecture

Source of truth for every phase from Phase 2 onward. Locked 2026-09-15.
Release naming is in [`releases.md`](./releases.md).

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

Client-facing routes live at the root of `yiddiweller.com`:

```
/avio            a client workroom
/pay/...         a payment flow
/invoice/...     an invoice
/files/...       a file
/approve/...     an approval
```

A workroom at a bare slug is the point: it should feel like a private room built
for that client. The cost is a permanent reserved-slug discipline, because a
client slug must never be able to shadow a real application route. See
[`architecture.md`](./architecture.md) for the list and the two guards that
enforce it.

### Access levels

| Level | Mechanism | Identity strength |
| --- | --- | --- |
| 1 | Unique private link | None. Possession of a URL. |
| 2 | PIN protected | Resource-level. Proves someone has the PIN. |
| 3 | Authenticated client account | Person-level. |

**A shared PIN is never equivalent to verified identity.** Activity from a PIN
session is attributed to the workroom, never to a named person. The data model
must make overclaiming impossible rather than merely discouraged.

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

## Phase sequence

| Phase | Scope | State |
| --- | --- | --- |
| 0 | Audit and architecture | Complete |
| 1 | Core foundation, inquiry persistence | **Complete — production verified**, released as `v1.0.0` |
| 2 | Studio foundation and authentication | Not started |
| 3 | Clients, contacts, leads, projects | |
| 4 | Workrooms and private client access | |
| 5 | Files, presentations, approvals | |
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
