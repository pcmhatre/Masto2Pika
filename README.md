# Masto2Pika

Crossposts Mastodon toots to [Pika](https://pika.page) (a Micropub-based blog) as titleless posts, carrying full text and images.

Built for a "Followers only" posting habit: reading followers-only content requires an authenticated Mastodon API client, which is why this exists instead of a public RSS/no-code integration.

## What it does

- Polls the account's Mastodon statuses and crossposts **originals only** — boosts and replies to other accounts are excluded.
- **Self-threads are stitched together**: a reply to your own previous toot is appended to the *same* Pika post (via Micropub's `q=source` + `action=update`) instead of becoming a separate post.
- **Native quote posts** (Mastodon 4.4+) are rendered as a Markdown blockquote with attribution, since the quoted content lives in a separate `quote` field, not in `content`. Mastodon's redundant `RE: <link>` courtesy paragraph is stripped.
- Images are downloaded from Mastodon and re-uploaded to Pika's media endpoint, so posts don't depend on the original toot still existing.
- Posts containing [REDACTED-EMOJI] are excluded entirely (see `EXCLUDED_CONTENT` in `src/threading.ts`).
- New posts are tagged `"Micro"` on Pika, alongside any hashtags from the toot.

## Architecture

Two parts:

1. **The crosspost logic** (this repo) — a Node/TypeScript script (`scripts/crosspost.ts`) that does the actual work, run via a GitHub Actions workflow (`.github/workflows/crosspost.yml`) on `workflow_dispatch`.
2. **The trigger** (`cron-trigger/`) — a Cloudflare Worker with a real `*/15 * * * *` Cron Trigger that calls GitHub's workflow-dispatch API. This exists because GitHub Actions' own `schedule:` trigger proved unreliable in practice (fired only ~2 times over 4 hours against a 15-minute config) — the Worker's cadence was verified landing precisely on the :00/:15/:30/:45 marks.

```
Cloudflare Worker (real cron, every 15 min)
  → POST GitHub Actions workflow-dispatch API
    → crosspost.yml runs scripts/crosspost.ts
      → reads state/thread-map.json (last synced status ID, thread → Pika URL map)
      → fetches new Mastodon statuses
      → creates/updates Pika posts via Micropub
      → commits updated state/thread-map.json back to the repo
```

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

Flags: `--dry-run` (log what would happen, never write state or post anything), `--backfill` (on first run, process existing history instead of just seeding the cursor to "now").

### GitHub Actions

Set the same four values as repository secrets (Settings → Secrets and variables → Actions). The workflow only runs on `workflow_dispatch` — it needs something to dispatch it, which is the Cloudflare Worker below.

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

`state/thread-map.json` tracks the last processed Mastodon status ID and a map of `mastodon_status_id → pika_post_url` for stitching thread replies. It's committed back to the repo by the GitHub Actions workflow after each run.

If a toot's root predates this tool's first run (or was itself skipped), replies to it won't be stitched — there's no Pika post on record to append to.

## Troubleshooting

If crossposts stop landing, check the Cloudflare Worker's cron and logs first (`npx wrangler tail` from `cron-trigger/`), not GitHub Actions — the Worker is the only thing driving the schedule.
