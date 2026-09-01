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

Requires Node 20 or newer (see `.nvmrc`).

---

## Environment variables

All three are required for the contact form. Without them the form returns a
clear "not configured yet" message instead of failing silently — the rest of
the site works regardless.

| Variable            | Description                                                              |
| ------------------- | ------------------------------------------------------------------------ |
| `RESEND_API_KEY`    | Resend API key. Server-side only — never exposed to the browser.          |
| `RESEND_FROM_EMAIL` | Address mail is sent **from**. Must be on a domain verified in Resend.    |
| `CONTACT_EMAIL`     | Address mail is delivered **to**. Any inbox you read.                     |

`.env*` is git-ignored. Never commit real keys.

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

`main` is the deployment branch. Railway watches it and redeploys on every push.

```bash
git add -A
git commit -m "…"
git push origin main
```

### Railway

1. **New Project → Deploy from GitHub repo** → pick this repository.
2. Railway detects Next.js via Nixpacks; `railway.json` pins the commands
   (`npm run build`, then `npm run start`).
3. **Variables** → add `RESEND_API_KEY`, `RESEND_FROM_EMAIL` and
   `CONTACT_EMAIL`.
4. Deploy. Do **not** set a `PORT` variable — Railway injects it and
   `next start` reads it automatically. Nothing in this repo hardcodes a port
   or a hostname.

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
app/
  layout.tsx            Root layout: fonts, metadata, header/footer, cursor
  page.tsx              Home
  work/page.tsx         Work index
  work/[slug]/page.tsx  Project detail
  contact/page.tsx      Contact
  api/contact/route.ts  Resend endpoint
  not-found.tsx         404
  robots.ts  sitemap.ts  manifest.ts
  globals.css           Reset + design tokens
  favicon.ico  opengraph-image.png
components/             Header, Footer, Cursor, ContactForm, ProjectList,
                        Reveal, SignatureMark
data/projects.ts        The only file to edit when adding work
lib/site.ts             Name, role, canonical URL, description
lib/contact.ts          Validation shared by the form and the API route
public/                 Icons served at the root
brand/                  Source logo artwork (not served)
```

### Design notes

- **Colour** is only `#000000` and `#ffffff`; every secondary tone is white at
  reduced opacity, defined as a token in `globals.css`. There are no greys.
- **Type** is [Jost](https://fonts.google.com/specimen/Jost), self-hosted at
  build time by `next/font` — no runtime request to Google. It was chosen to sit
  with the existing `YIDDI WELLER` wordmark, which is also a geometric sans.
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
