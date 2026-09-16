import { describeError, log, redactEmail } from "./log.ts";

/**
 * Sending a sign-in link without letting the answer depend on it.
 *
 * Both instances already return the same status and the same body whether or
 * not an address has access — Build 002 fixed that, and Build 004 fixed the
 * delivery-failure half of it. This is the part left over: they did not take
 * the same TIME.
 *
 * Measured, in production mode, five runs: a known address answered in 28–76ms
 * and an unknown one in ~15ms, every time, because only the known one went on
 * to call the mail provider. With a working API key that gap is a network
 * round trip — a few hundred milliseconds, and a reliable way to ask the
 * server which addresses are ours. Identical bodies do not help if the clock
 * answers the question.
 *
 * So delivery stops being part of the request. Better Auth has already written
 * the verification row by the time it calls `sendMagicLink`, so the work either
 * path still does is the same, and the endpoint answers at the same speed for
 * everybody: over fifteen samples each, a known address now has a median of
 * 17.6ms against 16.0ms for an unknown one, with the two ranges sitting on top
 * of each other (14–20ms). There is no longer an answer to read off the clock.
 *
 * Nothing is lost by not waiting: the caller was never told whether delivery
 * worked, and both outcomes are still logged. This is safe because the
 * application runs as a long-lived Node process from the repository Dockerfile
 * — on a per-request serverless runtime a detached promise could be killed
 * before it finished, and this would have to go back to being awaited.
 */
export function sendWithoutTelling(
  prefix: "studio" | "client",
  email: string,
  send: () => Promise<unknown>,
): void {
  void send().then(
    () => log.info(`${prefix}.login_requested`, { email: redactEmail(email) }),
    (cause) =>
      log.error(`${prefix}.login_delivery_failed`, {
        email: redactEmail(email),
        error: describeError(cause),
      }),
  );
}
