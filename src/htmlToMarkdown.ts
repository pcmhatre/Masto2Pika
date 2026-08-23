import TurndownService from "turndown";
import type { MastodonQuote, MastodonStatus } from "./mastodon.js";
import type { PikaPhoto } from "./pika.js";

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
});

// Mastodon inlines custom emoji as <img class="emojione" alt=":shortcode:">
// within the text. Render as the shortcode instead of a Markdown image.
turndown.addRule("mastodonCustomEmoji", {
  filter: (node) =>
    node.nodeName === "IMG" && (node as HTMLElement).classList?.contains("emojione"),
  replacement: (_content, node) => (node as HTMLElement).getAttribute("alt") ?? "",
});

// Mastodon prepends a `RE: <link>` paragraph to quote-post content for
// clients that don't understand the `quote` field. buildQuoteBlock already
// renders the quoted post and its link, so this is redundant — drop it.
turndown.addRule("mastodonQuoteInlineLink", {
  filter: (node) =>
    node.nodeName === "P" && (node as HTMLElement).classList?.contains("quote-inline"),
  replacement: () => "",
});

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

export function extractHashtags(status: MastodonStatus): string[] {
  return status.tags.map((t) => t.name);
}

// Pika's Micropub `action: update` silently no-ops on a `photo` replace (see
// PROJECT_STATE.md's known Pika bugs) — `content` updates are the one thing
// confirmed to work reliably through that endpoint, so a continuation's
// photos are embedded as markdown images directly in the appended content
// instead of being sent as a separate `photo` property.
export function buildPhotoMarkdown(photos: PikaPhoto[]): string {
  return photos.map((p) => `![${p.alt ?? ""}](${p.value})`).join("\n\n");
}

export function buildContentMarkdown(status: MastodonStatus): string {
  const body = htmlToMarkdown(status.content);
  const withCw = status.spoiler_text ? `CW: ${status.spoiler_text}\n\n${body}` : body;
  const quoteBlock = buildQuoteBlock(status.quote);
  return quoteBlock ? `${withCw}\n\n${quoteBlock}` : withCw;
}

// Mastodon's native quote-post feature keeps the quoted status in a separate
// `quote` field rather than inlining it into `content`, so it has to be
// rendered explicitly or it silently disappears when crossposted.
function buildQuoteBlock(quote: MastodonQuote | null | undefined): string | null {
  if (!quote) return null;

  if (!quote.quoted_status) {
    return `> *(quoted post unavailable: ${quote.state})*`;
  }

  const quotedMarkdown = htmlToMarkdown(quote.quoted_status.content);
  const blockquote = quotedMarkdown
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");

  return `${blockquote}\n>\n> — [@${quote.quoted_status.account.acct}](${quote.quoted_status.url})`;
}
