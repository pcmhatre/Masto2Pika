import TurndownService from "turndown";
import type { MastodonStatus } from "./mastodon.js";

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
  return status.spoiler_text ? `CW: ${status.spoiler_text}\n\n${body}` : body;
}
