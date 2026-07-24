# Masto2Pika

Crossposts Mastodon toots to [Pika](https://pika.page) (a Micropub-based blog) as titleless posts, carrying full text and images.

Built for a "Followers only" posting habit: reading followers-only content requires an authenticated Mastodon API client, which is why this exists instead of a public RSS/no-code integration.

## What it does

- Polls the account's Mastodon statuses and crossposts **originals only** — boosts and replies to other accounts are excluded.
- **Self-threads are stitched together**: a reply to your own previous toot is appended to the *same* Pika post (via Micropub's `q=source` + `action=update`) instead of becoming a separate post.
- **Native quote posts** (Mastodon 4.4+) are rendered as a Markdown blockquote with attribution, since the quoted content lives in a separate `quote` field, not in `content`. Mastodon's redundant `RE: <link>` courtesy paragraph is stripped.
- Images are downloaded from Mastodon and re-uploaded to Pika's media endpoint, so posts don't depend on the original toot still existing.
- Posts matching a configurable exclusion list (domains, emoji, etc. — see `EXCLUDED_CONTENT` below) are skipped entirely.
- New posts are tagged `"Micro"` on Pika, alongside any hashtags from the toot.

## Architecture

Two parts:

1. **The crosspost logic** (this repo) — a Node/TypeScript script (`scripts/crosspost.ts`) that does the actual work, run via a GitHub Actions workflow (`.github/workflows/crosspost.yml`) on `workflow_dispatch`.
2. **The trigger** (`cron-trigger/`) — a Cloudflare Worker with a real `*/15 * * * *` Cron Trigger that calls GitHub's workflow-dispatch API. This exists because GitHub Actions' own `schedule:` trigger proved unreliable in practice (fired only ~2 times over 4 hours against a 15-minute config) — the Worker's cadence was verified landing precisely on the :00/:15/:30/:45 marks.

```
Cloudflare Worker (real cron, every 15 min)
  → POST GitHub Actions workflow-dispatch API
    → crosspost.yml runs scripts/crosspost.ts
      → reads state from Cloudflare KV (last synced status ID, thread → Pika URL map)
      → fetches new Mastodon statuses
      → creates/updates Pika posts via Micropub
      → writes updated state back to Cloudflare KV
```

State (which post maps to which Pika URL, and any configured content exclusions) lives in Cloudflare, not in this repo — see [State](#state) and [Excluding content](#excluding-content) below.

## Setup

### Mastodon

Create an application (Settings → Development → New Application) with `read:statuses` scope (or `read`). You need the access token and your numeric account ID.

### Pika

Create an app token (Settings → App tokens).

### Local development

```bash
cp .env.example .env   # fill in the four values below
npm install
npm run crosspost:dry  # preview without posting anything
npm run crosspost      # run for real
```

Required env vars (see `.env.example`):

- `MASTODON_INSTANCE_URL`
- `MASTODON_ACCESS_TOKEN`
- `MASTODON_ACCOUNT_ID`
- `PIKA_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_KV_NAMESPACE_ID`
- `CLOUDFLARE_API_TOKEN` (scoped to Account → Workers KV Storage → Edit)

Optional: `EXCLUDED_CONTENT` — see [Excluding content](#excluding-content).

Flags: `--dry-run` (log what would happen, never write state or post anything), `--backfill` (on first run, process existing history instead of just seeding the cursor to "now").

### GitHub Actions

Set the same values as repository secrets (Settings → Secrets and variables → Actions). The workflow only runs on `workflow_dispatch` — it needs something to dispatch it, which is the Cloudflare Worker below.

### Cloudflare KV (state storage)

```bash
cd cron-trigger
npx wrangler login
npx wrangler kv namespace create masto2pika_state   # note the returned namespace id
```

Create an API token at dash.cloudflare.com/profile/api-tokens scoped to Account → Workers KV Storage → Edit, then set `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_KV_NAMESPACE_ID`, and `CLOUDFLARE_API_TOKEN` locally (`.env`) and as GitHub Actions secrets.

### Cloudflare Worker (the cron trigger)

```bash
cd cron-trigger
npx wrangler login
npx wrangler secret put GITHUB_TOKEN     # fine-grained PAT scoped to this repo, Actions read/write only
npx wrangler secret put TRIGGER_SECRET   # any random string; gates the manual-trigger endpoint below
npx wrangler deploy
```

Once deployed, it fires the GitHub workflow every 15 minutes on its own. It also exposes a secret-gated HTTP endpoint for on-demand triggers:

```
https://<worker-subdomain>.workers.dev/?secret=<TRIGGER_SECRET>
```

## State

The last processed Mastodon status ID and a map of `mastodon_status_id → pika_post_url` (for stitching thread replies) are stored in a Cloudflare KV namespace, read/written by `src/state.ts` via Cloudflare's REST API. This is deliberately *not* committed to the repo — it would otherwise expose which blog domain posts land on and the IDs of followers-only toots.

If a toot's root predates this tool's first run (or was itself skipped), replies to it won't be stitched — there's no Pika post on record to append to.

## Excluding content

`src/threading.ts`'s `classify()` takes an `excludedContent: string[]` parameter — any toot whose content contains one of these substrings (a domain, an emoji, anything) is skipped entirely, whether it would otherwise be a new post or a thread continuation. The actual list is never hardcoded in source; `scripts/crosspost.ts` reads it at runtime from the `EXCLUDED_CONTENT` env var as a JSON array, e.g.:

```
EXCLUDED_CONTENT=["[REDACTED-EMOJI]","https://example.com/"]
```

Set this as a GitHub Actions secret (and locally in `.env` if needed) rather than committing it, so the specific exclusions stay private even if this repo is public.

## Troubleshooting

If crossposts stop landing, check the Cloudflare Worker's cron and logs first (`npx wrangler tail` from `cron-trigger/`), not GitHub Actions — the Worker is the only thing driving the schedule.
