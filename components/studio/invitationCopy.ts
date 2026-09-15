import type { InvitationFailure } from "@/lib/db/staff";

/**
 * One wording for each way an invitation can fail, shared by the page that
 * checks the link on arrival and the form that checks it again on submit, so
 * the same situation never reads two different ways.
 *
 * None of these name a person or say whether an address is known. An expired
 * link is the only one that admits the invitation existed, which its holder
 * already knows.
 */
export const INVITATION_FAILURE: Record<InvitationFailure, { title: string; note: string }> = {
  invalid: {
    title: "This link is not valid.",
    note: "It may have been withdrawn, or the address may have been copied incompletely. Ask whoever invited you to send a new one.",
  },
  expired: {
    title: "This invitation has expired.",
    note: "Invitations last seven days. Ask whoever invited you to send a new one.",
  },
  already_used: {
    title: "This invitation has already been used.",
    note: "If that was you, sign in instead.",
  },
  already_staff: {
    title: "You already have Studio access.",
    note: "Sign in with your email address.",
  },
};
