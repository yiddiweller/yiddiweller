import { site } from "@/lib/site";

import styles from "./Footer.module.css";

export default function Footer() {
  return (
    <footer className={`page ${styles.footer}`}>
      <small className={styles.line}>
        © {site.name} {new Date().getFullYear()}
      </small>
    </footer>
  );
}
