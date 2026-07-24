import type { MastodonStatus } from "./mastodon.js";

export interface ThreadState {
  lastProcessedId: string | null;
  threads: Record<string, string>; // mastodon status id -> pika post url
}

export type ThreadDecision =
  | { kind: "new-root" }
  | { kind: "continuation"; pikaUrl: string }
  | { kind: "skip"; reason: string };

// Content containing any of these is never crossposted, regardless of
// whether it would otherwise be a new post or a thread continuation.
const EXCLUDED_CONTENT = ["[REDACTED-EMOJI]", "https://REDACTED-DOMAIN.example/"];

/**
 * Decides whether a status should become a new Pika post, be appended to an
 * existing thread's Pika post, or be skipped entirely.
 *
 * Boosts are always skipped. Replies to other accounts are always skipped.
 * A reply to the account's own toot is a thread continuation only if that
 * parent toot is already known (i.e. this tool has processed it before) —
 * threads that started before the tool went live can't be stitched.
 */
export function classify(
  status: MastodonStatus,
  ownAccountId: string,
  threads: Record<string, string>,
): ThreadDecision {
  if (status.reblog) return { kind: "skip", reason: "boost" };

  if (EXCLUDED_CONTENT.some((needle) => status.content.includes(needle))) {
    return { kind: "skip", reason: "excluded content" };
  }

  if (!status.in_reply_to_id) return { kind: "new-root" };

  if (status.in_reply_to_account_id !== ownAccountId) {
    return { kind: "skip", reason: "reply to another account" };
  }

  const pikaUrl = threads[status.in_reply_to_id];
  if (!pikaUrl) {
    return {
      kind: "skip",
      reason: "self-reply to an untracked parent (predates this tool or was itself skipped)",
    };
  }

  return { kind: "continuation", pikaUrl };
}
