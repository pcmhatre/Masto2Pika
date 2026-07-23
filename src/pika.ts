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

export function normalizePhotos(photos: (string | PikaPhoto)[] | undefined): PikaPhoto[] {
  if (!photos) return [];
  return photos.map((p) => (typeof p === "string" ? { value: p } : p));
}

async function assertOk(res: Response, label: string, expectedStatus?: number) {
  const ok = expectedStatus ? res.status === expectedStatus : res.ok;
  if (!ok) {
    throw new Error(`${label} failed: ${res.status} ${await res.text()}`);
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

  const res = await fetch(config.mediaEndpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}` },
    body: form,
  });
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

  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ type: ["h-entry"], properties }),
  });
  await assertOk(res, "Pika post creation", 201);
  return requireLocation(res, "Pika post creation");
}

export async function getSource(config: PikaConfig, url: string): Promise<PikaSource> {
  const params = new URLSearchParams({ q: "source", url });
  const res = await fetch(`${config.endpoint}?${params}`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  await assertOk(res, "Pika source query");
  const body = (await res.json()) as { properties?: PikaSource };
  return body.properties ?? {};
}

export interface UpdatePostInput {
  content: string;
  photos?: PikaPhoto[];
}

export async function updatePost(
  config: PikaConfig,
  url: string,
  input: UpdatePostInput,
): Promise<void> {
  const replace: Record<string, unknown> = { content: [input.content] };
  if (input.photos) replace.photo = input.photos;

  const res = await fetch(config.endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action: "update", url, replace }),
  });
  await assertOk(res, "Pika post update");
}
