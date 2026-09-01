export type ProjectImage = {
  /** Path under /public, or a remote URL configured in next.config.ts. */
  src: string;
  alt: string;
  width: number;
  height: number;
};

export type Project = {
  slug: string;
  title: string;
  /** Free text so ranges such as "2024–2025" are allowed. */
  year: string;
  /** Discipline shown in the index row, e.g. "Identity", "Interior". */
  category: string;
  description: string;
  cover?: ProjectImage;
  gallery?: ProjectImage[];
  client?: string;
  location?: string;
};

/**
 * The work index and every /work/[slug] page are generated from this array.
 * Add an entry and the row, the detail page, the static params and the
 * sitemap all follow. Nothing else needs editing.
 */
export const projects: Project[] = [];

export function getProject(slug: string): Project | undefined {
  return projects.find((project) => project.slug === slug);
}
