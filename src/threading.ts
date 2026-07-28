import type { MastodonStatus } from "./mastodon.js";

export interface ThreadState {
  lastProcessedId: string | null;
  threads: Record<string, string>; // mastodon status id -> pika post url
}

export type ThreadDecision =
  | { kind: "new-root" }
  | { kind: "continuation"; pikaUrl: string }
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
 * rather than via the reply button) are also skipped, as are ones shorter
 * than `minContentLength` visible characters. Both checks are scoped to
 * that not-technically-a-reply case only, so neither can interfere with
 * genuine self-reply thread continuations — a short reply extending an
 * existing thread is still worth appending even if a fresh short toot
 * wouldn't be worth a new post on its own.
 *
 * The length check only measures `status.content` (the toot's own text),
 * which for a native quote-post is just the quoter's own commentary — the
 * quoted content lives separately in `status.quote` and isn't counted here.
 * Quote-posts are exempt from the length check entirely, since even brief
 * commentary produces a substantial crossposted result once the quoted
 * post is rendered alongside it. Toots containing a YouTube link are
 * exempt too, for the same reason (the embedded video is the substance,
 * not the caption) — this one's a structural rule, not a private
 * preference, so it's hardcoded rather than going through
 * `excludedContent`.
 */
function startsWithMention(html: string): boolean {
  return html.replace(/<[^>]+>/g, "").trimStart().startsWith("@");
}

function plainTextLength(html: string): number {
  return html.replace(/<[^>]+>/g, "").trim().length;
}

function containsYouTubeLink(html: string): boolean {
  return /youtube\.com|youtu\.be/i.test(html);
}

export function classify(
  status: MastodonStatus,
  ownAccountId: string,
  threads: Record<string, string>,
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
    if (
      !status.quote &&
      !containsYouTubeLink(status.content) &&
      minContentLength > 0 &&
      plainTextLength(status.content) <= minContentLength
    ) {
      return { kind: "skip", reason: `content is ${minContentLength} characters or shorter` };
    }
    return { kind: "new-root" };
  }

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
