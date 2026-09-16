import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `next dev` otherwise appends a block of its own guidance to CLAUDE.md on
   * every run. That file is this repository's instructions, written and kept by
   * hand, and a build tool editing it turns every dev session into an
   * uncommitted change nobody made.
   */
  agentRules: false,

  /**
   * Private responses must never be stored by anything between us and the
   * reader.
   *
   * Next already marks dynamic pages `no-cache, must-revalidate`, which stops a
   * cache *reusing* one — but not a shared cache, a proxy or a browser writing
   * it to disk in the first place. A Workroom page is one client's private
   * information, so it gets `private, no-store` explicitly, and so does every
   * client authentication response.
   *
   * Scoped to those two paths on purpose. The public site's static caching is
   * what makes it fast and is deliberately untouched.
   */
  async headers() {
    return [
      {
        source: "/workrooms/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
      {
        source: "/api/client-auth/:path*",
        headers: [
          { key: "Cache-Control", value: "private, no-store, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
