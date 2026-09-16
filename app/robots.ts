import type { MetadataRoute } from "next";

import { isPreview } from "@/lib/env";
import { site } from "@/lib/site";

export default function robots(): MetadataRoute.Robots {
  // The preview must never be crawled, or it would compete with the live site
  // for the same content and split its search ranking.
  if (isPreview) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    // Icons must stay crawlable for Google to pick up the favicon.
    // `/workrooms` is private by authorization, not by this line — a crawler
    // reaching one gets the sign-in page. It is here so the paths never appear
    // in an index at all, and every page beneath also states `noindex` itself,
    // for the crawlers that ignore this file.
    //
    // Without the trailing slash on purpose. A `Disallow` is a prefix match, so
    // `/workrooms/` covers everything beneath but not `/workrooms` itself —
    // which is the index of somebody's private spaces, and the one path a
    // crawler would find first.
    rules: [{ userAgent: "*", allow: "/", disallow: ["/api/", "/workrooms"] }],
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url,
  };
}
