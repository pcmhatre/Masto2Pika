import type { ThreadState } from "./threading.js";

export interface KvConfig {
  accountId: string;
  namespaceId: string;
  apiToken: string;
}

const STATE_KEY = "thread-map";

function valueUrl(config: KvConfig, key: string): string {
  return `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/storage/kv/namespaces/${config.namespaceId}/values/${encodeURIComponent(key)}`;
}

export async function loadState(config: KvConfig): Promise<ThreadState> {
  const res = await fetch(valueUrl(config, STATE_KEY), {
    headers: { Authorization: `Bearer ${config.apiToken}` },
  });
  if (res.status === 404) return { lastProcessedId: null, threads: {}, pending: {}, pendingThreads: {} };
  if (!res.ok) {
    throw new Error(`Cloudflare KV read failed: ${res.status} ${await res.text()}`);
  }
  // `pending`/`pendingThreads` are newer fields — default them for state
  // blobs written before pending-thread support existed.
  const raw = JSON.parse(await res.text()) as Partial<ThreadState>;
  return {
    lastProcessedId: raw.lastProcessedId ?? null,
    threads: raw.threads ?? {},
    pending: raw.pending ?? {},
    pendingThreads: raw.pendingThreads ?? {},
  };
}

export async function saveState(config: KvConfig, state: ThreadState): Promise<void> {
  const res = await fetch(valueUrl(config, STATE_KEY), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "text/plain",
    },
    body: JSON.stringify(state),
  });
  if (!res.ok) {
    throw new Error(`Cloudflare KV write failed: ${res.status} ${await res.text()}`);
  }
}
