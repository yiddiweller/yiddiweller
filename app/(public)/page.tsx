import { site } from "@/lib/site";

import styles from "./page.module.css";

export default function Home() {
  return (
    <>
      <section className={`page ${styles.hero}`}>
        <h1 className={styles.title}>
          <span className={styles.name}>{site.name}</span>
        </h1>
      </section>

      <div className="page">
        <hr className="rule" />
      </div>
    </>
  );
}
