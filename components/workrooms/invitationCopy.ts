import { type InvitationFailure } from "@/lib/db/workrooms";

/**
 * What a client is told when a link does not work.
 *
 * Every one of these says what happened and what to do next. None of them
 * names a project, a client or a person — somebody holding a dead link may not
 * be the person it was sent to.
 */
export const INVITATION_FAILURE: Record<InvitationFailure, { title: string; note: string }> = {
  invalid: {
    title: "This link does not work.",
    note: "It may have been copied incompletely. Try opening it again from the email, and if it still does not work, reply to whoever sent it.",
  },
  expired: {
    title: "This link has expired.",
    note: "Invitations last seven days. Reply to the email it came from and we will send a fresh one.",
  },
  revoked: {
    title: "This link is no longer active.",
    note: "It was withdrawn, which usually means a newer one was sent. Check for a more recent email, or reply to us.",
  },
  already_used: {
    title: "This link has already been used.",
    note: "You may already be signed in. If not, ask for a sign-in link instead.",
  },
  unavailable: {
    title: "This is not open yet.",
    note: "The space this link points at is not ready. Nothing is wrong at your end — reply to the email and we will let you know when it is.",
  },
  access_off: {
    title: "This access has been switched off.",
    note: "Somebody at the studio turned it off after this was sent. Reply to the email it came from and we will put it back.",
  },
  email_taken: {
    /**
     * Deliberately says nothing about the other record.
     *
     * An address can only belong to one person's access, and the reason this
     * one cannot be used is that it is already somebody's — which may be this
     * same human, held twice. Either way it is ours to untangle and not theirs
     * to be told about, and whoever is holding the link may not be the person
     * it was sent to.
     */
    title: "We cannot open this with that address.",
    note: "It is set up against a different record at our end, which is ours to fix rather than yours. Reply to the email it came from and we will sort it out.",
  },
};
