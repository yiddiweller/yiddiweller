import type { Metadata } from "next";

import ContactForm from "@/components/ContactForm";

import styles from "./contact.module.css";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with Yiddi Weller.",
  alternates: { canonical: "/contact" },
};

export default function Contact() {
  return (
    <section className={`page ${styles.section}`}>
      <h1 className={styles.heading}>Contact</h1>
      <p className={styles.lead}>Have something in mind?</p>
      <ContactForm />
    </section>
  );
}
