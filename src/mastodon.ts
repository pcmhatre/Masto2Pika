export interface MastodonMediaAttachment {
  id: string;
  type: string;
  url: string;
  description: string | null;
}

export interface MastodonStatus {
  id: string;
  created_at: string;
  content: string;
  spoiler_text: string;
  in_reply_to_id: string | null;
  in_reply_to_account_id: string | null;
  reblog: unknown | null;
  media_attachments: MastodonMediaAttachment[];
  tags: { name: string }[];
}

export interface MastodonConfig {
  instanceUrl: string;
  accessToken: string;
  accountId: string;
}

const PAGE_LIMIT = 40;

/**
 * Fetches all statuses newer than minId, oldest-first. Boosts are excluded
 * server-side; replies are NOT excluded here because self-thread replies
 * must be inspected for thread stitching.
 */
export async function fetchNewStatuses(
  config: MastodonConfig,
  minId: string | undefined,
): Promise<MastodonStatus[]> {
  const base = config.instanceUrl.replace(/\/+$/, "");
  const collected: MastodonStatus[] = [];

  // Mastodon's min_id pagination walks backward from the newest page, so we
  // page until no more results come back, then sort ascending ourselves.
  let maxId: string | undefined;

  for (;;) {
    const params = new URLSearchParams({
      exclude_reblogs: "true",
      limit: String(PAGE_LIMIT),
    });
    if (minId) params.set("min_id", minId);
    if (maxId) params.set("max_id", maxId);

    const url = `${base}/api/v1/accounts/${config.accountId}/statuses?${params}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${config.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Mastodon statuses fetch failed: ${res.status} ${await res.text()}`);
    }
    const page = (await res.json()) as MastodonStatus[];
    if (page.length === 0) break;

    collected.push(...page);
    if (page.length < PAGE_LIMIT) break;

    // Page backward: next page's max_id is the oldest id seen so far minus one.
    const oldest = page[page.length - 1];
    maxId = oldest ? String(BigInt(oldest.id) - 1n) : undefined;
    if (!maxId) break;
  }

  return collected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}
