import type { MetadataRoute } from "next";

import { projects } from "@/data/projects";
import { site } from "@/lib/site";

export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();

  return [
    { url: site.url, lastModified, changeFrequency: "yearly", priority: 1 },
    { url: `${site.url}/work`, lastModified, changeFrequency: "monthly", priority: 0.8 },
    { url: `${site.url}/contact`, lastModified, changeFrequency: "yearly", priority: 0.5 },
    ...projects.map((project) => ({
      url: `${site.url}/work/${project.slug}`,
      lastModified,
      changeFrequency: "yearly" as const,
      priority: 0.7,
    })),
  ];
}
