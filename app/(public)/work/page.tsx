import type { Metadata } from "next";

import ProjectList from "@/components/ProjectList";
import { projects } from "@/data/projects";

import styles from "./work.module.css";

export const metadata: Metadata = {
  title: "Work",
  description: "Selected work by Yiddi Weller.",
  alternates: { canonical: "/work" },
};

export default function Work() {
  return (
    <section className={`page ${styles.section}`}>
      <h1 className={styles.heading}>Work</h1>

      {projects.length > 0 ? (
        <ProjectList projects={projects} />
      ) : (
        <p className={styles.empty}>Selected work, coming soon.</p>
      )}
    </section>
  );
}
