import type { MetadataRoute } from "next";

import { site } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    { url: site.url, lastModified, changeFrequency: "yearly", priority: 1 },
    { url: `${site.url}/contact`, lastModified, changeFrequency: "yearly", priority: 0.5 },
  ];
}
