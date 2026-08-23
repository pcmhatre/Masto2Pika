export interface PikaConfig {
  endpoint: string; // https://pika.page/micropub
  mediaEndpoint: string; // https://pika.page/micropub/media
  token: string;
}

export interface PikaPhoto {
  value: string;
  alt?: string;
}

export interface PikaSource {
  content?: string[];
  photo?: (string | PikaPhoto)[];
  category?: string[];
  published?: string[];
}

// Per the Micropub spec (https://micropub.spec.indieweb.org/#error-response),
// a 403 splits into "insufficient_scope" (token needs broader permissions —
// fixable by re-issuing a token) and "forbidden" (the generic catch-all,
// covering things like a post-limit/quota being reached — not something a
// retry will ever fix). Pika's dev confirmed they follow this spec. Neither
// 401 nor 403 will resolve itself on retry, unlike a network blip or 5xx, so
// flag it distinctly in the error message rather than let it look identical
// to a transient failure in the logs.
function describePermanence(status: number, errorCode: string | undefined): string {
  if (status !== 401 && status !== 403) return "";
  const reason = errorCode ?? "auth/permission issue";
  return ` — likely permanent (${reason}); won't resolve by retrying, needs manual attention`;
}

async function assertOk(res: Response, label: string, expectedStatus?: number) {
  const ok = expectedStatus ? res.status === expectedStatus : res.ok;
  if (!ok) {
    const text = await res.text();
    let errorCode: string | undefined;
    try {
      errorCode = (JSON.parse(text) as { error?: string }).error;
    } catch {
      // Not JSON (or unexpected shape) — fall through with no parsed code.
    }
    throw new Error(`${label} failed: ${res.status} ${text}${describePermanence(res.status, errorCode)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Pika's docs: "Use exponential backoff starting at one minute. Retrying
// without waiting will keep your requests throttled." A backlog-catch-up
// run (e.g. after a cron outage) can fire many Micropub/media calls in
// quick succession, which is exactly the kind of burst that could trip
// this — so every request goes through this retry wrapper rather than
// failing the whole run (and blocking retries for 15+ min) on the first 429.
const RATE_LIMIT_BASE_DELAY_MS = 60_000;
const RATE_LIMIT_MAX_RETRIES = 3;

async function fetchWithRateLimitRetry(url: string, init: RequestInit, label: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.status !== 429 || attempt >= RATE_LIMIT_MAX_RETRIES) return res;
    const delayMs = RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt;
    console.warn(`  ! ${label} rate limited (429), retrying in ${delayMs / 1000}s (attempt ${attempt + 1}/${RATE_LIMIT_MAX_RETRIES})`);
    await sleep(delayMs);
  }
}

function requireLocation(res: Response, label: string): string {
  const location = res.headers.get("Location");
  if (!location) throw new Error(`${label} did not return a Location header`);
  return location;
}

export async function uploadMedia(
  config: PikaConfig,
  bytes: Buffer,
  mimeType: string,
  filename: string,
): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);

  const res = await fetchWithRateLimitRetry(
    config.mediaEndpoint,
    { method: "POST", headers: { Authorization: `Bearer ${config.token}` }, body: form },
    "Pika media upload",
  );
  await assertOk(res, "Pika media upload", 201);
  return requireLocation(res, "Pika media upload");
}

export interface CreatePostInput {
  content: string;
  photos?: PikaPhoto[];
  category?: string[];
  published?: string;
}

export async function createPost(config: PikaConfig, input: CreatePostInput): Promise<string> {
  const properties: Record<string, unknown> = { content: [input.content] };
  if (input.photos?.length) properties.photo = input.photos;
  if (input.category?.length) properties.category = input.category;
  if (input.published) properties.published = [input.published];

  const res = await fetchWithRateLimitRetry(
    config.endpoint,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ type: ["h-entry"], properties }),
    },
    "Pika post creation",
  );
  await assertOk(res, "Pika post creation", 201);
  return requireLocation(res, "Pika post creation");
}

export async function getSource(config: PikaConfig, url: string): Promise<PikaSource> {
  const params = new URLSearchParams({ q: "source", url });
  const res = await fetchWithRateLimitRetry(
    `${config.endpoint}?${params}`,
    { headers: { Authorization: `Bearer ${config.token}` } },
    "Pika source query",
  );
  await assertOk(res, "Pika source query");
  const body = (await res.json()) as { properties?: PikaSource };
  return body.properties ?? {};
}

export interface UpdatePostInput {
  content: string;
  addCategory?: string[];
}

export async function updatePost(
  config: PikaConfig,
  url: string,
  input: UpdatePostInput,
): Promise<void> {
  const body: Record<string, unknown> = {
    action: "update",
    url,
    replace: { content: [input.content] },
  };
  // `add` appends without needing to know the post's existing categories —
  // the documented way to attach a reply's hashtags to an already-published
  // thread (a `replace` would require fetching and re-sending the full set).
  if (input.addCategory?.length) body.add = { category: input.addCategory };

  const res = await fetchWithRateLimitRetry(
    config.endpoint,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    "Pika post update",
  );
  await assertOk(res, "Pika post update");
}
