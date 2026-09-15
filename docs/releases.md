# Releases

Human-readable names for builds people need to talk about. The commit SHA
remains the technical source of truth underneath; these names exist so a
conversation can say "Beta 004" instead of reading out a hash.

There is no version database and no tooling. A Git tag and this file are the
whole system.

---

## The two tracks

| Track | Name | Where | Marked by |
| --- | --- | --- | --- |
| Beta | `Beta 001`, `Beta 002`, … | `beta` branch, Railway `beta` | This file |
| Production | `v1.0.0`, `v1.1.0`, … | `main` branch, Railway `production` | An annotated Git tag |

Beta numbers count **meaningful** builds worth discussing, not every push. A
typo fix redeployed twice is still one Beta number, or none at all. Production
versions follow semantic versioning.

Railway and GitHub go on showing commit identifiers. Nothing here replaces
them.

---

## What each production increment means

| Increment | When | Examples |
| --- | --- | --- |
| **PATCH** `v1.0.1` | A fix or a small correction. No new capability. | A contrast correction, a copy fix, a dependency bump, a logging improvement. |
| **MINOR** `v1.1.0` | A meaningful feature that does not break what came before. | Portfolio projects appear on Work. A new public page. A Studio screen. Stripe payments added. |
| **MAJOR** `v2.0.0` | A platform or product generation change. | The public rebrand ships. A client workroom is publicly reachable for the first time. An architectural change that alters how the platform is operated. |

Two rules that keep the numbers honest:

- **Documentation-only changes do not earn a version.** They ride along with the
  next release that contains actual change.
- **A version is cut when the commit is verified in production**, not when the
  work is merged. A tag says "this ran and was checked", which is the only
  reason to trust it later.

---

## Release log

### `v1.0.0` — Phase 1 production foundation

Commit `681fc8e`. Tagged after full production verification.

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

---

## Beta numbering

Numbering starts at **`Beta 001`** for the next meaningful beta build after
`v1.0.0`. Everything before this point is unnumbered; it predates the
convention and renaming it retrospectively would invent history.

A beta number is recorded in this file when the build is worth referring to
again. It is for release notes, team conversation, a future Studio About
screen, and changelogs. **No interface displays it yet, and none should be
built for it until a phase asks for one.**

---

## Cutting a release

```bash
# 1. The commit is already verified in production.
git checkout main && git pull

# 2. Tag it, annotated, so the message travels with the tag.
git tag -a v1.1.0 -m "Yiddi Weller Platform — <what this release is>"
git push origin v1.1.0

# 3. Add the entry to the release log above, in the next change.
```

Tags are never moved once pushed. A mistake is corrected by a new version, not
by retagging, because anyone who already fetched the old tag would otherwise
hold a different commit under the same name.
