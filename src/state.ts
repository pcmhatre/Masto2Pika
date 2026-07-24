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
  if (res.status === 404) return { lastProcessedId: null, threads: {} };
  if (!res.ok) {
    throw new Error(`Cloudflare KV read failed: ${res.status} ${await res.text()}`);
  }
  return JSON.parse(await res.text()) as ThreadState;
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
