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
| Production | **Build 001** | `681fc8e` |
| Beta | **Build 002** | `15a5969` |

Beta is one build ahead while Build 002 is verified. That is the normal state
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

### Build 002 — Studio foundation, authentication and design system

Commit `15a5969`. On beta, verified. Not promoted.

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
it, and one migration, `0001_studio_staff.sql`.

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
