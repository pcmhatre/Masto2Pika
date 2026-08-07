import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchNewStatuses, type MastodonConfig, type MastodonStatus } from "../src/mastodon.js";
import { buildContentMarkdown, extractHashtags } from "../src/htmlToMarkdown.js";
import {
  createPost,
  getSource,
  normalizePhotos,
  updatePost,
  uploadMedia,
  type PikaConfig,
  type PikaPhoto,
} from "../src/pika.js";
import { classify } from "../src/threading.js";
import { loadState, saveState, type KvConfig } from "../src/state.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has("--dry-run");
const BACKFILL = args.has("--backfill");

function loadDotEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadDotEnv();

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const mastodonConfig: MastodonConfig = {
  instanceUrl: requireEnv("MASTODON_INSTANCE_URL"),
  accessToken: requireEnv("MASTODON_ACCESS_TOKEN"),
  accountId: requireEnv("MASTODON_ACCOUNT_ID"),
};

const pikaConfig: PikaConfig = {
  endpoint: process.env.PIKA_ENDPOINT ?? "https://pika.page/micropub",
  mediaEndpoint: process.env.PIKA_MEDIA_ENDPOINT ?? "https://pika.page/micropub/media",
  token: requireEnv("PIKA_TOKEN"),
};

const kvConfig: KvConfig = {
  accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
  namespaceId: requireEnv("CLOUDFLARE_KV_NAMESPACE_ID"),
  apiToken: requireEnv("CLOUDFLARE_API_TOKEN"),
};

// Substrings (domains, emoji, etc.) that exclude a toot from crossposting.
// Kept out of source deliberately — set as a JSON array in the
// EXCLUDED_CONTENT secret so specific exclusions aren't publicly visible.
const excludedContent: string[] = process.env.EXCLUDED_CONTENT
  ? (JSON.parse(process.env.EXCLUDED_CONTENT) as string[])
  : [];

// Minimum visible-character length for a status to become a new post (0 =
// no minimum). Kept out of source for the same reason as EXCLUDED_CONTENT.
const minContentLength = process.env.MIN_CONTENT_LENGTH ? Number(process.env.MIN_CONTENT_LENGTH) : 0;

/** Latest existing status id, used to seed state on first run without backfilling. */
async function peekLatestStatusId(config: MastodonConfig): Promise<string | undefined> {
  const base = config.instanceUrl.replace(/\/+$/, "");
  const params = new URLSearchParams({ exclude_reblogs: "true", limit: "1" });
  const res = await fetch(`${base}/api/v1/accounts/${config.accountId}/statuses?${params}`, {
    headers: { Authorization: `Bearer ${config.accessToken}` },
  });
  if (!res.ok) throw new Error(`Mastodon peek failed: ${res.status} ${await res.text()}`);
  const page = (await res.json()) as MastodonStatus[];
  return page[0]?.id;
}

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
};

// Mastodon reports an attachment's type as "unknown" while it's still being
// processed server-side, before resolving to "image"/"video"/etc. A status
// fetched in that window has real media (media_attachments is non-empty)
// but would be silently skipped by a strict `type === "image"` filter —
// the download itself works fine regardless of Mastodon's own classification
// state, so treat "unknown" as a candidate image too.
async function uploadStatusImages(status: MastodonStatus): Promise<PikaPhoto[]> {
  const images = status.media_attachments.filter((m) => m.type === "image" || m.type === "unknown");
  const photos: PikaPhoto[] = [];

  for (const media of images) {
    const res = await fetch(media.url);
    if (!res.ok) {
      console.warn(`  ! failed to download media ${media.url}: ${res.status}`);
      continue;
    }
    const contentType = res.headers.get("content-type") ?? "image/jpeg";
    // "unknown" attachments can turn out to be video/audio still processing,
    // not an image — Pika's media endpoint only accepts image types, so skip
    // anything that didn't actually download as one.
    if (media.type === "unknown" && !contentType.startsWith("image/")) {
      console.warn(`  ! skipping non-image "unknown" attachment ${media.url} (${contentType})`);
      continue;
    }
    const bytes = Buffer.from(await res.arrayBuffer());
    const ext = Object.entries(IMAGE_MIME_BY_EXT).find(([, mime]) => mime === contentType)?.[0] ?? "jpg";
    const filename = `${media.id}.${ext}`;

    if (DRY_RUN) {
      console.log(`  [dry-run] would upload media ${media.url} (${contentType}, ${bytes.length} bytes)`);
      photos.push({ value: media.url, alt: media.description ?? undefined });
      continue;
    }

    const location = await uploadMedia(pikaConfig, bytes, contentType, filename);
    photos.push({ value: location, alt: media.description ?? undefined });
  }

  return photos;
}

async function main() {
  const state = await loadState(kvConfig);

  if (state.lastProcessedId === null && !BACKFILL) {
    const latestId = await peekLatestStatusId(mastodonConfig);
    if (!DRY_RUN) {
      await saveState(kvConfig, { lastProcessedId: latestId ?? "0", threads: {} });
    }
    console.log(
      `First run: initialized cursor to status ${latestId ?? "(none)"} without backfilling. ` +
        `Future toots will be crossposted on the next run. Re-run with --backfill to import history instead.`,
    );
    return;
  }

  const minId = state.lastProcessedId ?? undefined;
  const statuses = await fetchNewStatuses(mastodonConfig, minId);

  if (statuses.length === 0) {
    console.log("No new statuses.");
    return;
  }

  const threadsWorking: Record<string, string> = { ...state.threads };
  let lastProcessedId = state.lastProcessedId;

  for (const status of statuses) {
    const decision = classify(status, mastodonConfig.accountId, threadsWorking, excludedContent, minContentLength);
    console.log(`Status ${status.id}: ${decision.kind}${"reason" in decision ? ` (${decision.reason})` : ""}`);

    if (decision.kind === "skip") {
      lastProcessedId = status.id;
      continue;
    }

    const photos = await uploadStatusImages(status);
    const content = buildContentMarkdown(status);

    if (decision.kind === "new-root") {
      const category = [...extractHashtags(status), "Micro"];
      if (DRY_RUN) {
        console.log("  [dry-run] would create post:", JSON.stringify({ content, photos, category, published: status.created_at }, null, 2));
        threadsWorking[status.id] = `dry-run://${status.id}`;
      } else {
        const pikaUrl = await createPost(pikaConfig, {
          content,
          photos,
          category,
          published: status.created_at,
        });
        threadsWorking[status.id] = pikaUrl;
        console.log(`  created ${pikaUrl}`);
      }
    } else {
      const pikaUrl = decision.pikaUrl;
      if (DRY_RUN) {
        console.log(`  [dry-run] would fetch source of ${pikaUrl}, append content, and update`);
        threadsWorking[status.id] = pikaUrl;
      } else {
        const source = await getSource(pikaConfig, pikaUrl);
        const existingContent = source.content?.[0] ?? "";
        const existingPhotos = normalizePhotos(source.photo);
        const mergedContent = existingContent ? `${existingContent}\n\n${content}` : content;
        const mergedPhotos = [...existingPhotos, ...photos];
        await updatePost(pikaConfig, pikaUrl, { content: mergedContent, photos: mergedPhotos });
        threadsWorking[status.id] = pikaUrl;
        console.log(`  updated ${pikaUrl}`);
      }
    }

    lastProcessedId = status.id;
  }

  if (!DRY_RUN) {
    await saveState(kvConfig, { lastProcessedId, threads: threadsWorking });
  } else {
    console.log("[dry-run] state not written.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
