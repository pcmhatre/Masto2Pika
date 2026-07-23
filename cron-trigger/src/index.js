const REPO = "pcmhatre/Masto2Pika";
const WORKFLOW = "crosspost.yml";

async function dispatchCrosspost(env) {
  const res = await fetch(
    `https://api.github.com/repos/${REPO}/actions/workflows/${WORKFLOW}/dispatches`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "masto2pika-cron-worker",
      },
      body: JSON.stringify({ ref: "main" }),
    },
  );
  const ok = res.ok;
  const text = ok ? "" : await res.text();
  return { ok, status: res.status, text };
}

export default {
  async scheduled(_event, env, _ctx) {
    const result = await dispatchCrosspost(env);
    if (!result.ok) {
      console.error(`GitHub dispatch failed: ${result.status} ${result.text}`);
    } else {
      console.log("Dispatched crosspost workflow");
    }
  },

  // Manual trigger for testing/on-demand runs, gated by a shared secret so
  // this isn't an open unauthenticated endpoint that anyone can hit.
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    if (url.searchParams.get("secret") !== env.TRIGGER_SECRET) {
      return new Response("Not found", { status: 404 });
    }
    const result = await dispatchCrosspost(env);
    return new Response(
      result.ok ? "Dispatched crosspost workflow\n" : `Dispatch failed: ${result.status} ${result.text}\n`,
      { status: result.ok ? 200 : 502 },
    );
  },
};
