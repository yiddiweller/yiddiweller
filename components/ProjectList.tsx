import Link from "next/link";

import type { Project } from "@/data/projects";

import styles from "./ProjectList.module.css";

/**
 * The work index: one editorial row per project — title, discipline, year.
 */
export default function ProjectList({ projects }: { projects: Project[] }) {
  return (
    <ul className={styles.list}>
      {projects.map((project) => (
        <li key={project.slug}>
          <Link href={`/work/${project.slug}`} className={styles.row}>
            <span className={styles.title}>{project.title}</span>
            <span className={styles.category}>{project.category}</span>
            <span className={styles.year}>{project.year}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
