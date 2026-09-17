import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,

  /**
   * Private file previews are plain `<img>`, deliberately.
   *
   * `next/image` is not merely unnecessary here — it is wrong, for three
   * reasons that all point the same way:
   *
   *   It proxies bytes through this server. That is the single thing the
   *   Build 005 storage design forbids: uploads and downloads go browser ↔
   *   bucket and never through Railway.
   *
   *   It caches what it optimises to the container's filesystem. That would
   *   write one client's private work to ephemeral disk, outside every
   *   authorization check that put it behind a signed URL in the first place.
   *
   *   The source is one of our own routes that redirects to a URL expiring in
   *   sixty seconds, so an optimiser's cache is stale before it is useful.
   *
   * There is also nothing to optimise: the preview is generated in the Studio
   * browser, downscaled to 1280px and roughly 80 KB before it is ever stored.
   *
   * Scoped to the three surfaces that show one, so the rule keeps protecting
   * every other image in the codebase. The patterns avoid literal parentheses
   * on purpose: Next's route groups are `(room)` and `(app)`, and a glob reads
   * those as an alternation rather than as directory names.
   */
  {
    files: [
      "**/workrooms/**/files/page.tsx",
      "**/WorkroomOverview.tsx",
    ],
    rules: { "@next/next/no-img-element": "off" },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
