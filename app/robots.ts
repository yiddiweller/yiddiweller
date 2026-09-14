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
    rules: [{ userAgent: "*", allow: "/", disallow: "/api/" }],
    sitemap: `${site.url}/sitemap.xml`,
    host: site.url,
  };
}
