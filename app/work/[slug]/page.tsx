import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { notFound } from "next/navigation";

import { getProject, projects } from "@/data/projects";

import styles from "./project.module.css";

type Props = { params: Promise<{ slug: string }> };

export function generateStaticParams() {
  return projects.map((project) => ({ slug: project.slug }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const project = getProject(slug);

  if (!project) return {};

  return {
    title: project.title,
    description: project.description,
    alternates: { canonical: `/work/${project.slug}` },
    openGraph: {
      title: project.title,
      description: project.description,
      images: project.cover ? [{ url: project.cover.src }] : undefined,
    },
  };
}

export default async function ProjectPage({ params }: Props) {
  const { slug } = await params;
  const project = getProject(slug);

  if (!project) notFound();

  const meta = [
    { label: "Discipline", value: project.category },
    { label: "Year", value: project.year },
    { label: "Client", value: project.client },
    { label: "Location", value: project.location },
  ].filter((item): item is { label: string; value: string } => Boolean(item.value));

  return (
    <article className={`page ${styles.article}`}>
      <header className={styles.header}>
        <h1 className={styles.title}>{project.title}</h1>

        <dl className={styles.meta}>
          {meta.map((item) => (
            <div key={item.label} className={styles.metaItem}>
              <dt className={styles.metaLabel}>{item.label}</dt>
              <dd className={styles.metaValue}>{item.value}</dd>
            </div>
          ))}
        </dl>

        <p className={styles.description}>{project.description}</p>
      </header>

      {project.cover ? (
        <Image
          className={styles.image}
          src={project.cover.src}
          alt={project.cover.alt}
          width={project.cover.width}
          height={project.cover.height}
          sizes="100vw"
          priority
        />
      ) : null}

      {project.gallery?.map((image) => (
        <Image
          key={image.src}
          className={styles.image}
          src={image.src}
          alt={image.alt}
          width={image.width}
          height={image.height}
          sizes="100vw"
        />
      ))}

      <Link href="/work" className={styles.back}>
        <span aria-hidden="true">←</span> All work
      </Link>
    </article>
  );
}
