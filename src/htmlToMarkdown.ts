import TurndownService from "turndown";
import type { MastodonQuote, MastodonStatus } from "./mastodon.js";

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

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html).trim();
}

export function extractHashtags(status: MastodonStatus): string[] {
  return status.tags.map((t) => t.name);
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
