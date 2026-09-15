# yiddiweller.com

The public site of Yiddi Weller, and the foundation of the YIDDI WELLER LLC
platform. Next.js App Router, TypeScript, CSS Modules, PostgreSQL via Drizzle,
Resend, built from the repository Dockerfile and deployed on Railway. Setup is
in `README.md`; architecture in `docs/`.

## Branches: always update both

| Branch | Reached at                        | Railway variable   |
| ------ | --------------------------------- | ------------------ |
| `main` | `yiddiweller.com`                 | none               |
| `beta` | `yiddiweller-beta.up.railway.app` | `SITE_ENV=preview` |

Beta uses the hostname Railway generated. It has no custom subdomain and is not
getting one: a preview nobody links to does not need a pretty address, and
`beta.yiddiweller.com` would be one more DNS record to keep correct.

**Every change lands on both branches.** The preview must never fall behind the
live site. Work on `beta`, push it for review, then fast-forward `main` onto the
same commit once it is approved:

```bash
git push origin beta
git checkout main && git merge --ff-only beta && git push origin main
git checkout beta
```

Both branches then sit on the identical commit. Never ship to `main` something
that has not been on `beta` first, and never leave `beta` behind `main`.

## Platform state — settled, do not re-litigate

**Phase 1 is complete and verified in production.** Released as **Build 001**.
These are facts about the running system, not proposals. Changing any of them
is a deliberate decision, not a cleanup.

- **PostgreSQL is the system of record for contact inquiries.** Email is a
  notification, not the record. An inquiry is persisted before it is emailed.
- **Railway runs two isolated environments**, `production` from `main` and
  `beta` from `beta`, **each with its own PostgreSQL service.** Beta never
  touches production data.
- **The repository `Dockerfile` is the official build system.** Nixpacks was
  removed deliberately: it declared every service variable as `ARG` then `ENV`,
  which wrote secrets into image metadata. Do not reintroduce it.
- **Node 22 is the supported runtime**, pinned by `node:22-slim`, `.nvmrc` and
  `engines`, which must continue to agree.
- **Application secrets are runtime-only and must never become Docker build
  arguments.** `RESEND_API_KEY`, `DATABASE_URL`, `CONTACT_EMAIL` and
  `RESEND_FROM_EMAIL` are supplied to the running container by Railway. If a
  build ever appears to need one, that is a design fault to fix, not an `ARG`
  to add. `SITE_ENV` is the single permitted build argument and is not a secret.
- **`SITE_ENV=preview` belongs to beta alone.** Production must never receive
  it. Both layers of the guard are prerendered, so this is decided at build
  time: beta must stay non-indexable (`Disallow: /` plus
  `noindex, nofollow, nocache`) and production must stay indexable.
- **Production PostgreSQL has Point-in-Time Recovery plus weekly and monthly
  backups, and a restore was rehearsed successfully on 2026-09-15** — PITR into
  a separate temporary service, production untouched, real inquiry data verified
  in the restored copy. **No duration was measured, so there is no recovery time
  objective yet.** Procedure and full record: `docs/restore-rehearsal.md`.

Builds are numbered in `docs/releases.md`: one sequential human-readable
sequence, `Build 001` upward, shared by beta and production. A build keeps its
number as it moves between them, so beta temporarily running a higher number
than production just means something is being verified. There is no separate
beta track and no semantic versioning.

## Platform direction

[`docs/blueprint.md`](docs/blueprint.md) is the locked source of truth for the
platform. Read it before any architectural decision. The constraints most easily
broken by accident:

- **Two domains, and only two.** `yiddiweller.com` is the public and client
  world; `studio.yiddiweller.com` is the private team world. Do **not** create
  `admin.`, `dashboard.`, `app.`, `portal.`, `client.`, `clients.`, `pay.`,
  `files.`, `auth.`, `login.` or `api.` subdomains. Client payments, invoices,
  files and approvals all live under `yiddiweller.com`.
- **The internal product is called Studio.** Never Dashboard, Admin or Portal.
  Its interface system — shell, page architecture, tokens, components — is
  locked in [`docs/studio-design.md`](docs/studio-design.md). Build Studio
  screens from it rather than inventing a layout per phase.
- **Quiet outside, powerful inside.** New capability underneath must never make
  the public site busier. No Login, Portal, Billing or Dashboard links in public
  navigation.
- **Build the current phase only.** No speculative tables, no distant features.

## Design rules

- **Colour** is `#000000` and `#ffffff` only. Every secondary tone is white at
  reduced opacity, defined as a token in `app/globals.css`. Never introduce a
  grey value or an accent colour unless asked.
- **Type** is the reader's own system font, set once as `--font-sans`. Never add
  a downloaded or hosted webfont, `next/font` included. SF Pro on Apple devices,
  Segoe UI on Windows, Roboto on Android.
- **Keep it minimal.** Do not add homepage sections, marketing copy, or
  decoration unless asked. The voice stays clean, classy and understated.
- **Motion** is opacity and a small rise, nothing else, and is disabled entirely
  under `prefers-reduced-motion`.
- **Spacing** comes from `--page-x` and `--page-y`, so the gutter matches on
  every page.

## Before every push

All three must pass:

```bash
npm run typecheck && npm run lint && npm run build
```

The preview must keep search engines out. Verify that too:

```bash
SITE_ENV=preview npm run build && cat .next/server/app/robots.txt.body
# expect: User-Agent: *  /  Disallow: /
```
