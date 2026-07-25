export interface MastodonMediaAttachment {
  id: string;
  type: string;
  url: string;
  description: string | null;
}

export interface MastodonQuotedStatus {
  content: string;
  url: string;
  account: { acct: string };
}

export interface MastodonQuote {
  state:
    | "pending"
    | "accepted"
    | "rejected"
    | "revoked"
    | "deleted"
    | "unauthorized"
    | "blocked_account"
    | "blocked_domain"
    | "muted_account";
  quoted_status: MastodonQuotedStatus | null;
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
  quote?: MastodonQuote | null;
}

export interface MastodonConfig {
  instanceUrl: string;
  accessToken: string;
  accountId: string;
}

const PAGE_LIMIT = 40;

async function fetchPage(
  base: string,
  config: MastodonConfig,
  params: URLSearchParams,
): Promise<MastodonStatus[]> {
  const url = `${base}/api/v1/accounts/${config.accountId}/statuses?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Mastodon statuses fetch failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as MastodonStatus[];
}

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

  if (minId) {
    // Resuming from a cursor: each page is anchored near min_id and
    // returned newest-first, so the next page's floor is this page's
    // newest id — walk forward toward "now" until a short page confirms
    // we've caught up.
    let cursor = minId;
    for (;;) {
      const params = new URLSearchParams({
        exclude_reblogs: "true",
        limit: String(PAGE_LIMIT),
        min_id: cursor,
      });
      const page = await fetchPage(base, config, params);
      if (page.length === 0) break;

      collected.push(...page);
      if (page.length < PAGE_LIMIT) break;

      const newest = page[0];
      if (!newest) break;
      cursor = newest.id;
    }
  } else {
    // No floor (true from-scratch backfill): start at "now" and walk
    // backward through full history via max_id.
    let maxId: string | undefined;
    for (;;) {
      const params = new URLSearchParams({
        exclude_reblogs: "true",
        limit: String(PAGE_LIMIT),
      });
      if (maxId) params.set("max_id", maxId);

      const page = await fetchPage(base, config, params);
      if (page.length === 0) break;

      collected.push(...page);
      if (page.length < PAGE_LIMIT) break;

      const oldest = page[page.length - 1];
      if (!oldest) break;
      maxId = String(BigInt(oldest.id) - 1n);
    }
  }

  return collected.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}
