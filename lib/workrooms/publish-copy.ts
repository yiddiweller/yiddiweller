/**
 * What the publish confirmation says.
 *
 * **The consequences, before the button, and only the true ones.** Publishing
 * does up to three things somebody should know about before they press it: it
 * replaces the version the client is reading, it shares the files it
 * references, and — when the version it replaces has an open round of
 * feedback — it ends that round for good. Beta found the third one missing: a
 * member of staff about to close a conversation with a client was told only
 * that the client would see something new.
 *
 * A pure function of four facts, so every combination is testable without
 * rendering a page, and so the words are decided in one place rather than in a
 * ternary inside JSX that nobody reads twice.
 *
 * **It warns about exactly what `supersedeReviewOnPublish` does, and nothing
 * else.** That function ends a round only when it is `open` on the Revision
 * being replaced; a round the studio closed keeps its reason, a withdrawn one
 * stays withdrawn, and no round means nothing to end. So `closesFeedback` is
 * true for an open round and false for every other state — saying "feedback
 * will close" about a round already closed would be a consequence that does not
 * happen, and mentioning a withdrawn one would surface administration the
 * studio chose to take back.
 */

export type PublishFacts = {
  /** Nothing has been published yet. */
  firstPublish: boolean;
  /** How many internal files publishing will share with the client. */
  sharing: number;
  /** The number of the version being replaced, when there is one. Never an id. */
  replacing: number | null;
  /** The version being replaced has an open round of feedback. */
  closesFeedback: boolean;
};

export type PublishConfirmation = { title: string; message: string };

export function publishConfirmation(facts: PublishFacts): PublishConfirmation {
  if (facts.firstPublish) {
    return {
      title: "Publish presentation?",
      message:
        facts.sharing > 0
          ? `${files(facts.sharing)} will also be shared with the client.`
          : "The client can open it from that moment.",
    };
  }

  const version = facts.replacing === null ? null : `Version ${facts.replacing}`;

  // The files sentence stands in for the replacement one when there is
  // something to share, exactly as it always has — the count is the part a
  // person needs to read. The feedback sentence is added, never substituted:
  // it is a different consequence and neither of the others implies it.
  const sentences = [
    facts.sharing > 0
      ? `${files(facts.sharing)} will also be shared with the client.`
      : `The client will see this instead of ${version ?? "the current version"}.`,
  ];

  if (facts.closesFeedback) {
    sentences.push(
      `Feedback on ${version ?? "the current version"} will close and remain available as read-only history.`,
    );
  }

  return { title: "Publish a new version?", message: sentences.join(" ") };
}

function files(count: number): string {
  return count === 1 ? "One file" : `${count} files`;
}
