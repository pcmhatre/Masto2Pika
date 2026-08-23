import type { MastodonStatus } from "./mastodon.js";
import type { PikaPhoto } from "./pika.js";

// A root toot that was too short to post on its own, held in case a
// self-reply within PENDING_WINDOW_MS extends it past minContentLength.
export interface PendingThread {
  createdAt: string; // original root toot's created_at — used as `published` if it's later posted
  statusIds: string[]; // toot ids folded in so far, oldest (root) first
  contentParts: string[]; // buildContentMarkdown() output per status, same order as statusIds
  photos: PikaPhoto[]; // media collected across all parts, in order
  hashtags: string[]; // hashtags collected across all parts (may contain duplicates)
  plainLength: number; // combined plain-text length, compared against minContentLength
}

export interface ThreadState {
  lastProcessedId: string | null;
  threads: Record<string, string>; // mastodon status id -> pika post url
  pending: Record<string, string>; // any status id in an unpublished chain -> that chain's root id
  pendingThreads: Record<string, PendingThread>; // root status id -> accumulated thread data
}

export const PENDING_WINDOW_MS = 24 * 60 * 60 * 1000;

export type ThreadDecision =
  | { kind: "new-root" }
  | { kind: "continuation"; pikaUrl: string }
  | { kind: "pending-start" }
  | { kind: "pending-continue"; rootId: string; publishNow: boolean }
  | { kind: "skip"; reason: string };

/**
 * Decides whether a status should become a new Pika post, be appended to an
 * existing thread's Pika post, or be skipped entirely.
 *
 * Boosts are always skipped. Replies to other accounts are always skipped.
 * A reply to the account's own toot is a thread continuation only if that
 * parent toot is already known (i.e. this tool has processed it before) —
 * threads that started before the tool went live can't be stitched.
 *
 * `excludedContent` is a caller-supplied list of substrings (e.g. specific
 * domains or emoji) — content matching any of them is never crossposted,
 * regardless of whether it would otherwise be a new post or a continuation.
 * Kept out of source so the specific list can live in a secret rather than
 * be publicly visible in this repo.
 *
 * Statuses that visually start with a mention (`@user ...`) but aren't
 * actually flagged as a reply (in_reply_to_id is null — e.g. typed manually
 * rather than via the reply button) are always skipped. A root toot that's
 * shorter than `minContentLength` visible characters isn't skipped outright
 * though — it's held as "pending" (see PendingThread) for up to
 * PENDING_WINDOW_MS in case a self-reply extends it past the threshold, in
 * which case the whole chain is posted as one combined post. Both checks
 * are scoped to the not-a-reply case only, so neither can interfere with
 * genuine self-reply thread continuations to an already-published post — a
 * short reply extending a published thread is still worth appending even if
 * a fresh short toot wouldn't be worth a new post on its own.
 *
 * The length check only measures `status.content` (the toot's own text),
 * which for a native quote-post is just the quoter's own commentary — the
 * quoted content lives separately in `status.quote` and isn't counted here.
 * Quote-posts are exempt from the length check entirely, since even brief
 * commentary produces a substantial crossposted result once the quoted
 * post is rendered alongside it. Toots containing a YouTube link, or any
 * media attachment (image, video, etc.), are exempt too, for the same
 * reason (the media is the substance, not the caption) — these are
 * structural rules, not private preferences, so they're hardcoded rather
 * than going through `excludedContent`.
 */
function startsWithMention(html: string): boolean {
  return html.replace(/<[^>]+>/g, "").trimStart().startsWith("@");
}

export function plainTextLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").trim().length;
}

function containsYouTubeLink(html: string): boolean {
  return /youtube\.com|youtu\.be/i.test(html);
}

export function classify(
  status: MastodonStatus,
  ownAccountId: string,
  threads: Record<string, string>,
  pending: Record<string, string>,
  pendingThreads: Record<string, PendingThread>,
  excludedContent: string[],
  minContentLength: number,
): ThreadDecision {
  if (status.reblog) return { kind: "skip", reason: "boost" };

  if (excludedContent.some((needle) => status.content.includes(needle))) {
    return { kind: "skip", reason: "excluded content" };
  }

  if (!status.in_reply_to_id) {
    if (startsWithMention(status.content)) {
      return { kind: "skip", reason: "starts with a mention but isn't marked as a reply" };
    }
    const exemptFromLengthCheck =
      Boolean(status.quote) || containsYouTubeLink(status.content) || status.media_attachments.length > 0;
    if (!exemptFromLengthCheck && minContentLength > 0 && plainTextLength(status.content) <= minContentLength) {
      return { kind: "pending-start" };
    }
    return { kind: "new-root" };
  }

  if (status.in_reply_to_account_id !== ownAccountId) {
    return { kind: "skip", reason: "reply to another account" };
  }

  const pikaUrl = threads[status.in_reply_to_id];
  if (pikaUrl) return { kind: "continuation", pikaUrl };

  const rootId = pending[status.in_reply_to_id];
  if (rootId) {
    // Invariant: every id in `pending` has a corresponding entry in `pendingThreads`.
    const pendingThread = pendingThreads[rootId]!;
    const combinedLength = pendingThread.plainLength + plainTextLength(status.content);
    return { kind: "pending-continue", rootId, publishNow: combinedLength > minContentLength };
  }

  return {
    kind: "skip",
    reason:
      "self-reply to an untracked parent (predates this tool, was itself skipped, or its pending window expired)",
  };
}

/**
 * Drops any pending thread whose root toot is older than PENDING_WINDOW_MS
 * without having crossed minContentLength — it's given up on and never
 * crossposted. Returns new copies; call once per run before classifying any
 * newly fetched statuses so pending-continue lookups only ever match
 * still-live pending threads.
 */
export function sweepExpiredPending(
  pending: Record<string, string>,
  pendingThreads: Record<string, PendingThread>,
  now: number = Date.now(),
): { pending: Record<string, string>; pendingThreads: Record<string, PendingThread>; expired: string[] } {
  const nextPending = { ...pending };
  const nextPendingThreads = { ...pendingThreads };
  const expired: string[] = [];

  for (const [rootId, thread] of Object.entries(pendingThreads)) {
    if (now - Date.parse(thread.createdAt) > PENDING_WINDOW_MS) {
      expired.push(rootId);
      delete nextPendingThreads[rootId];
      for (const id of thread.statusIds) delete nextPending[id];
    }
  }

  return { pending: nextPending, pendingThreads: nextPendingThreads, expired };
}
