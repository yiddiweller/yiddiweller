# yiddiweller.com

Personal site for Yiddi Weller — Designer.

Next.js (App Router) · TypeScript · CSS Modules · Resend · deployed on Railway.

---

## Local development

```bash
npm install
cp .env.example .env.local   # then fill in the values
npm run dev
```

Open http://localhost:3000.

| Script              | Purpose                                     |
| ------------------- | ------------------------------------------- |
| `npm run dev`       | Development server                          |
| `npm run build`     | Production build                            |
| `npm run start`     | Serve the production build                  |
| `npm run lint`      | ESLint                                      |
| `npm run typecheck` | TypeScript, no emit                         |
| `npm test`          | Unit and database tests (`node:test`)       |
| `npm run db:generate` | Generate a migration from the schema      |
| `npm run db:migrate`  | Apply pending migrations                  |
| `npm run env:check`   | Report missing server variables by name   |
| `npm run studio:bootstrap-owner` | Create the first Studio Owner, once     |

Requires Node 22 or newer (see `.nvmrc`). Database setup is in
[`docs/database.md`](docs/database.md); the wider architecture, including the
Public / Client / Studio boundaries, is in
[`docs/architecture.md`](docs/architecture.md); Studio itself — routing,
authentication, roles and invitations — is in
[`docs/studio.md`](docs/studio.md).

Studio runs at http://localhost:3000/studio in development. It needs `APP_URL`
and `BETTER_AUTH_SECRET` set, the migrations applied, and one Owner:

```bash
STUDIO_OWNER_EMAIL=you@example.com STUDIO_OWNER_NAME="Your Name" \
  npm run studio:bootstrap-owner
```

There is no sign-up. Everyone after the first Owner arrives by invitation.

---

## Environment variables

Every variable below is server-only. None may be given a `NEXT_PUBLIC_` prefix,
which would publish it to the browser. `.env*` is git-ignored; never commit real
values. Start from `.env.example`.

| Variable            | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `DATABASE_URL`      | PostgreSQL connection string. Inquiries are persisted here.               |
| `RESEND_API_KEY`    | Resend API key. Server-side only — never exposed to the browser.          |
| `RESEND_FROM_EMAIL` | Address mail is sent **from**. Must be on a domain verified in Resend.    |
| `CONTACT_EMAIL`     | Address mail is delivered **to**. Any inbox you read.                     |
| `APP_URL`           | Absolute origin of this deployment. Studio links are built from it.       |
| `BETTER_AUTH_SECRET`| Signs Studio sessions and sign-in links. Different in every environment.  |
| `STUDIO_HOST`       | The host Studio answers on at its root. `studio.yiddiweller.com` in production; unset on beta and locally. |
| `SITE_ENV`          | Set to `preview` on the beta service only. Blocks all search indexing.    |

An inquiry needs somewhere to go: a database that keeps it, or an inbox that
receives it. With either configured the form works; only when **neither** is
present does it return a clear "not configured yet" message. The rest of the
site works regardless.

Run `npm run env:check` against a service to list anything missing. It reports
names only and never prints a value.

---

## Resend setup

1. Create an account at [resend.com](https://resend.com).
2. **Domains → Add Domain** → `yiddiweller.com`.
3. Add the DNS records Resend gives you (an MX and two TXT records for SPF and
   DKIM) at your DNS provider, then wait for the domain to verify.
4. **API Keys → Create API Key** with *Sending access*. Copy it once — it is
   not shown again.
5. Set `RESEND_FROM_EMAIL` to an address on the verified domain, for example
   `website@yiddiweller.com`. The mailbox does not need to exist; it only has
   to be on a domain you have verified.
6. Set `CONTACT_EMAIL` to wherever you want to read the messages.

Each submission arrives with `Name`, `Email` and `Message`, and the sender's
address in `Reply-To`, so replying in your mail client goes straight to them.

**Spam handling.** A hidden honeypot field is silently accepted and discarded,
and the endpoint is rate-limited to 5 submissions per IP per minute. No CAPTCHA.
The rate limiter is in-process, so it resets on deploy and counts per instance —
fine for one Railway instance. If you ever scale to several, move it to a shared
store.

---

## Deploying

### GitHub

Two branches, each with its own Railway service.

| Branch | Watched by             | Reached at                        |
| ------ | ---------------------- | --------------------------------- |
| `main` | the production service | `yiddiweller.com`                 |
| `beta` | the preview service    | `yiddiweller-beta.up.railway.app` |

Work lands on `beta` first, is reviewed on the preview service, then merges into
`main` to go live. Beta keeps the hostname Railway generated; it has no custom
domain, which is why nothing in the application may depend on what it is called.
The preview service is identified by `SITE_ENV=preview`, never by its address.

```bash
git push origin beta          # publishes to the preview service

git checkout main             # once the preview is approved
git merge --ff-only beta
git push origin main          # publishes to yiddiweller.com
```

Reset `beta` from `main` before starting new work, so the two never drift:

```bash
git fetch origin main && git checkout -B beta origin/main
```

The preview service must set `SITE_ENV=preview` in its Railway variables. That
single variable is what tells `robots.ts` to block all crawlers, so the preview
can never compete with the live site in search results.

### Railway

One Railway service per branch. Both are created the same way.

1. **New Project → Deploy from GitHub repo** → pick this repository.
2. **Settings → Source → Branch.** Set this before the first deploy. The
   production service watches `main`; the preview service watches `beta`.
3. The image is built from the repository `Dockerfile`, pinned in
   `railway.json` as `"builder": "DOCKERFILE"`. Nixpacks is deliberately not
   used: it declares every service variable as `ARG` and then `ENV`, which
   writes secrets into the image configuration where `docker inspect` can read
   them, and leaves them there after a key is rotated. The Dockerfile declares
   no secret at all. `SITE_ENV` is its single build argument, because the
   preview guard is prerendered; see the comments in the file.
4. **Variables** → add `RESEND_API_KEY`, `RESEND_FROM_EMAIL` and
   `CONTACT_EMAIL`. On the preview service add `SITE_ENV=preview` as well.
5. Deploy. Do **not** set a `PORT` variable — Railway injects it and
   `next start` reads it automatically. Nothing in this repo hardcodes a port
   or a hostname.

> **Step 2 is the one that bites.** A Railway service's branch is a copy of the
> repository's default branch taken when the service was created, not a live
> link to it. The two then drift apart silently. Changing the default branch on
> GitHub does **not** move an existing service, and a service left on its
> inherited default will keep serving stale code while pushes to the branch you
> believe is deploying do nothing at all. A mismatch here stays invisible for as
> long as the two branches happen to point at the same commit, and only surfaces
> the first time they diverge, which is the worst moment to discover it.
>
> So: read **Settings → Source** on every service after creating it, and again
> after any change to the default branch. Confirm the production service says
> `main` and the preview service says `beta`. If a preview service is left on
> `main`, the preview service mirrors production instead of previewing
> anything, which looks like it is working and is not.

### Custom domain — yiddiweller.com

1. Railway → your service → **Settings → Networking → Custom Domain**.
2. Add `yiddiweller.com` and `www.yiddiweller.com`. Railway shows a target
   hostname for each.
3. At your DNS provider:
   - `www` → **CNAME** → the Railway target.
   - Root `@` → **ALIAS/ANAME** → the Railway target. If your provider does not
     support ALIAS at the apex, register `www` with Railway and redirect the
     apex to it at the DNS/registrar level.
4. Wait for DNS to propagate; Railway issues the TLS certificate automatically.
5. The canonical URL is set to `https://yiddiweller.com` in `lib/site.ts`. If
   you decide to serve `www` as canonical instead, change it there — metadata,
   the sitemap and robots.txt all read from that one value.

---

## Adding portfolio projects

Everything is driven by one array: **`data/projects.ts`**. Add an entry and the
index row, the detail page at `/work/<slug>`, the static params and the sitemap
all follow. No other file needs editing.

```ts
export const projects: Project[] = [
  {
    slug: "atwe",
    title: "Atwe",
    year: "2025",
    category: "Identity",
    description: "One or two sentences.",
    client: "Optional",
    location: "Optional",
    cover: {
      src: "/work/atwe/cover.jpg",
      alt: "Describe the image.",
      width: 2400,
      height: 1600,
    },
    gallery: [
      { src: "/work/atwe/01.jpg", alt: "…", width: 2400, height: 1600 },
    ],
  },
];
```

Put images under `public/work/<slug>/`. `width` and `height` must be the real
pixel dimensions — `next/image` uses them to reserve space and avoid layout
shift.

The work index switches from the "coming soon" state to the editorial row list
(title · discipline · year) as soon as the array is non-empty.

---

## Structure

```
middleware.ts           Host routing: which world a request belongs to
app/
  layout.tsx            The document: metadata, tokens. No chrome.
  (public)/             The public site, with its header, footer and cursor
    page.tsx            Home
    work/page.tsx       Work index
    work/[slug]/page.tsx  Project detail
    contact/page.tsx    Contact
  studio/               Studio: sign in, accept invitation, and the signed-in shell
  not-found.tsx         404
  api/contact/route.ts  Resend endpoint
  api/auth/[...all]/    Better Auth endpoints
  robots.ts  sitemap.ts  manifest.ts
  globals.css           Reset + design tokens
  favicon.ico  opengraph-image.png
components/             Header, Footer, Cursor, ContactForm, ProjectList,
                        Reveal, SignatureMark, PublicFrame
components/studio/      Studio's own components. Nothing is shared but tokens.
data/projects.ts        The only file to edit when adding work
lib/site.ts             Name, role, canonical URL, description
lib/contact.ts          Validation shared by the form and the API route
lib/hosts.ts            Public, Studio or internal, decided by Host
lib/auth/               Access rule, route guards, Better Auth configuration
lib/db/                 Server-only data layer: connection, schema, domains
lib/env.ts  lib/log.ts  Validated server config; structured JSON logging
drizzle/                Committed SQL migrations
scripts/                migrate.mjs (runs on deploy), check-env.mjs,
                        bootstrap-owner.mjs
tests/                  node:test — no test framework dependency
docs/                   Architecture, database and Studio documentation
public/                 Icons served at the root
brand/                  Source logo artwork (not served)
```

### Design notes

- **Colour** is only `#000000` and `#ffffff`; every secondary tone is white at
  reduced opacity, defined as a token in `globals.css`. There are no greys.
  The opacities are set by contrast rather than by the token names, which are
  historical: each is used for text at 11px or above, so each must clear WCAG
  AA's 4.5:1 against black. Measured: `--w-72` 10.54:1, `--w-45` 4.92:1,
  `--w-30` 4.58:1. The minimum opacity reaching 4.5:1 is 0.4553, so none of
  them may be lowered.
- **Type** is the reader's own system typeface, set once as `--font-sans` in
  `globals.css`: SF Pro on macOS and iOS, Segoe UI on Windows, Roboto on
  Android. Nothing is downloaded, so text paints on the first frame, never
  reflows, and the site reads as native on whatever device it is opened on.
  Weight 300 exists in all three families, so the light display setting holds
  everywhere.
- **Spacing** comes from two tokens, `--page-x` and `--page-y`, used by every
  page, so the gutter is identical everywhere.
- **The cursor** replaces the pointer only where `(hover: hover) and
  (pointer: fine)` matches, and gives the native cursor straight back on touch
  devices. The native cursor is hidden only after the custom one has mounted,
  so a script failure can never leave you without a pointer.
- **Motion** is opacity and a 14px rise, nothing else, and is disabled entirely
  under `prefers-reduced-motion`. Content stays visible with JavaScript off.

### Brand assets

`brand/` holds the source artwork: the signature mark (grey and white) and the
`YIDDI WELLER` wordmark, plus a vector trace of each. The site icons in
`public/` are generated from the grey signature; the Open Graph card uses the
wordmark. These are kept in the repo so the originals are never lost.
