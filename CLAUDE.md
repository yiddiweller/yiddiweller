# yiddiweller.com

Personal site for Yiddi Weller. Next.js App Router, TypeScript, CSS Modules,
Resend, deployed on Railway. Full setup documentation is in `README.md`.

## Branches: always update both

| Branch | Public at              | Railway variable   |
| ------ | ---------------------- | ------------------ |
| `main` | `yiddiweller.com`      | none               |
| `beta` | `beta.yiddiweller.com` | `SITE_ENV=preview` |

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
