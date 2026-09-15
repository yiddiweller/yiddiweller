import Link from "next/link";

import Reveal from "@/components/Reveal";
import { site } from "@/lib/site";

import styles from "./page.module.css";

export default function Home() {
  return (
    <>
      <section className={`page ${styles.hero}`}>
        <h1 className={styles.title}>
          <span className={styles.name}>{site.name}</span>
          <span className={styles.role}>{site.role}</span>
        </h1>
      </section>

      <div className="page">
        <hr className="rule" />
      </div>

      <section className={`page ${styles.statement}`}>
        <Reveal>
          <p className={styles.disciplines}>
            <span>Digital.</span>
            <span>Physical.</span>
            <span>Spatial.</span>
          </p>
        </Reveal>

        <Reveal delay={120}>
          <Link href="/work" className={styles.cta}>
            Work
            <span aria-hidden="true" className={styles.arrow}>
              →
            </span>
          </Link>
        </Reveal>
      </section>
    </>
  );
}
