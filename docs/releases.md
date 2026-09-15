# Builds

One sequential build number for the whole platform. Not two tracks.

`Build 001`, `Build 002`, `Build 003`, and so on. Beta and production share the
same sequence: a build keeps its number as it moves from one to the other, so
two environments running the same number are running the same thing.

The commit SHA remains the technical source of truth underneath. This file is
the human-readable record, and it is the whole system. No version database, no
tooling, nothing to keep in sync.

---

## Current state

| Environment | Build | Commit |
| --- | --- | --- |
| Production | **Build 002** | `544e7bb` |
| Beta | **Build 003** | see the log below |

Beta is a number ahead while Build 003 is verified. That is the normal state
during testing, not a discrepancy.

---

## How a number moves

A build number is claimed once, when work is ready for beta, and does not
change afterwards.

```
work merged to beta   →  Build 002 claimed
                         beta = Build 002, production = Build 001
approved and promoted →  production = Build 002
                         both environments now Build 002
next meaningful work  →  Build 003 claimed
```

Beta running a higher number than production is the normal state during
testing, not a discrepancy. It means exactly one thing: a build is being
verified and has not been promoted yet.

**A number is never reused and never reassigned.** If a build is abandoned
rather than promoted, its number is retired with it and the next work takes the
following number. Renumbering would break the one property that makes this
useful, which is that a number always refers to the same code.

---

## What earns a number

A build number marks something worth referring to again in conversation, a
changelog, or a release note.

**Earns one:** a feature, a schema change, a security or infrastructure change,
an accessibility or performance fix people would notice, anything that changes
what the site or platform does.

**Does not:** documentation, comments, a typo corrected and redeployed, or
repeated deploys of the same code. If nothing about the running system is
different, nothing has been built.

When in doubt, do not claim a number. An unnumbered deploy costs nothing; a
number that refers to nothing in particular makes every other number less
trustworthy.

---

## Build log

### Build 003 — Business core

**On beta, awaiting verification.** Production stays on Build 002 until it is
approved.

Phase 3. The first build holding real business data: Clients, Contacts, Leads
and Projects, the two flows that connect them, and the audit foundation that
had to arrive with them rather than after them. Nothing about the public
experience changed.

- Four concepts, never blurred: a Contact is a person, a Client is the
  relationship, a Lead is an opportunity, a Project is work. One table never
  means two of them. The model is `docs/business-core.md`, written before the
  schema and reviewed against fourteen real situations before a migration was
  generated.
- People attach to clients and to projects through relationship tables, so the
  same person can act for two clients without being duplicated. At most one
  primary each, enforced by a partial unique index rather than by care.
- An inquiry becomes a Lead once, by a deliberate act, in one transaction. The
  inquiry itself is never edited: an unprocessed inquiry is one with no Lead
  pointing at it, so there is no second source of truth to disagree with.
- Converting a Lead writes the client, the project, the relationships and the
  Lead's own outcome together or not at all, and only ever once. A Lead can be
  won before there is a project to point at.
- Optimistic concurrency on every editable record, so a save composed against a
  row somebody else has since changed is refused rather than silently
  overwriting them. It compares an integer `version`, because a `timestamptz`
  cannot be compared honestly across the JavaScript boundary — the first design
  compared `updated_at` and would never have matched.
- Append-only audit, enforced by PostgreSQL against `UPDATE`, `DELETE` and
  `TRUNCATE`, written in the same transaction as the change it describes. It
  records that something changed and never what it now says.
- Archive and restore rather than delete, refused where it would leave the data
  nonsensical — a client with live work, a person who is somebody's only named
  contact, a project whose client is archived.
- One search across all four, four indexed queries in PostgreSQL, no search
  service.
- Home now answers "what needs attention" from conditions that are true of
  rows — an inquiry with no lead, a follow-up whose time has passed, live work
  past its target — never from a flag somebody has to remember to set.
- Navigation grew its second group, Business and Studio, and hides what a
  Member's role cannot reach.
- Fixed while building it: the Studio shell's grid track was a bare `1fr`,
  which refuses to shrink below its content, so the first wide element — the
  pipeline board — made every page scroll sideways on a phone.

### Build 002 — Studio foundation, authentication and design system

Commit `544e7bb`. **In production, verified.** Promoted 2026-09-15 by
fast-forward, so production and beta sit on the identical commit.

A build keeps one number while it is being finished: the authentication work
and the design system that completes it are both Build 002, and the refinement
commits between them claimed no number of their own.

Phase 2. The first build with a private side: Studio, the internal team world,
served by the same application and told apart by `Host`. Nothing about the
public experience changed.

- Magic-link authentication, invite only. No sign-up form, no password, no
  social provider. A user row is created by accepting an invitation or by the
  one-time owner bootstrap script, and by nothing else.
- Two roles, Owner and Member, and a separate active/inactive status.
  Deactivating deletes live sessions, so access ends immediately.
- Single-use invitations, stored as a digest and expiring in seven days.
- Host routing: Studio at the root of its own host once the subdomain is
  connected, `/studio` on beta and localhost, and 404 on the public host.
- Server-side authorization on every page, layout and action.
- Public routes moved into an `app/(public)/` route group so Studio stops
  inheriting the public header, footer and cursor. No URL changed.
- The runtime image no longer carries drizzle-kit, esbuild and tsx, which an
  optional peer dependency had pulled into it.
- The permanent Studio interface: a left rail on desktop and a drawer on small
  screens, one page architecture every future module plugs into, and a token
  set, component language and accessibility standard recorded in
  `docs/studio-design.md`. Locked before the modules exist so that no later
  build has to redesign the application to add a screen.
- Times render in the reader's own timezone, with the server sending labelled
  UTC so nothing is ever quietly wrong.
- Authorization is called inside the component that reads, before it reads.
  Measuring a guarded page showed that a guard in a parent layout does not stop
  its page running — an anonymous request came back with the protected data in
  the body — and that a `loading.tsx` above a guarded page turns a refusal into
  a 200. Both are now rules, and Studio has no loading boundary.

Requires `APP_URL` and `BETTER_AUTH_SECRET` in every environment that serves
it, and one migration, `0001_studio_staff.sql`, which the deploy applies itself.

**Promotion, 2026-09-15.** Two stages, as planned. The code went first with
`STUDIO_HOST` unset, so Studio was unreachable in production while the deploy
and the migration were verified: five Studio tables created, existing inquiry
data intact, the public site and the contact flow unaffected, and
`yiddiweller.com/studio` still answering 404. Then
`studio.yiddiweller.com` was connected through Railway and Namecheap, verified
by Railway, and `STUDIO_HOST` was set. The first Owner was bootstrapped,
magic-link sign-in was confirmed on the real domain, and Home, Team and Settings
were checked by hand.

`APP_URL` is `https://studio.yiddiweller.com` in production — the Studio origin,
not the public one, because Better Auth builds its links and scopes its cookie
from it. No code change was needed to connect the subdomain.

A production database restore had been rehearsed successfully before promotion;
see [`restore-rehearsal.md`](./restore-rehearsal.md) for what it established
and what it did not.

---

### Build 001 — Phase 1 production foundation

Commit `681fc8e`. In production, verified.

The first release with a real backend underneath the site. Nothing about the
public experience changed except two accessibility corrections.

- PostgreSQL becomes the system of record for contact inquiries. Before this,
  an inquiry's only copy was an email in one inbox.
- Drizzle ORM, committed SQL migrations, and a server-only data layer.
- The image is built from a repository Dockerfile instead of Nixpacks, so no
  application secret is written into image metadata.
- Node 22 pinned by the base image.
- Two WCAG AA contrast failures corrected at the smallest compliant adjustment.
- Separate Railway `production` and `beta` environments, each with its own
  PostgreSQL service.

Everything before Build 001 is unnumbered. It predates the convention, and
numbering it retrospectively would invent history.

---

## Recording a build

Add its entry to the log above when it reaches beta, with the commit and what
changed. Update the current state table when it is promoted. That is the whole
procedure.

Tagging is optional and adds nothing the log does not already carry. If you
want one for a particular build, keep the name in the same sequence:

```bash
git tag -a build-002 <commit> -m "Yiddi Weller — Build 002"
git push origin build-002
```

Railway and GitHub go on showing their own commit and deployment identifiers.
Nothing here changes or competes with them, and no interface displays the build
number yet. None should be built until a phase asks for one.

---

## Superseded

An earlier draft of this file proposed two parallel sequences: `Beta 001`
upward for beta, and semantic versions such as `v1.0.0` for production. That is
no longer the convention and should not be reintroduced. It required translating
between two names for the same code, and semantic versioning promises a
meaning about compatibility that a studio platform with one deployment target
does not need to make.

A `v1.0.0` tag was created locally during that draft and never reached GitHub.
It has been deleted. No published tag or reference carried the old scheme.
