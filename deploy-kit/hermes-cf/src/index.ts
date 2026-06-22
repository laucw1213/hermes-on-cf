// Worker wrapper for the Hermes container.
//
// Hermes' `gateway run` command is NOT an HTTP server — it manages the
// messaging platforms (Telegram long-poll, Discord WS, etc). So there
// is no port-8642 to proxy, and the Worker exposes only an admin surface:
//
// - /health          Worker self-check (does not touch container)
// - /id              DO instance id (no container roundtrip)
// - /debug/cli       Runs `hermes <subcmd>` via the in-container shim
//                    on :9876 — primary deploy-script hook for
//                    `hermes pairing approve telegram <CODE>` and friends
// - everything else  404, with a hint pointing at /debug/cli
//
// Students talk to their Hermes bot directly via Telegram; this Worker
// is purely for ops. Bot ↔ Telegram traffic flows over Hermes' own
// outbound long-poll, never through us.
//
// `sleepAfter = "8760h"` (~1 year) is the SDK's nearest "never"; Hermes
// runs internal cron + listeners that must not pause.
import { Container } from "@cloudflare/containers";

const SHIM_PORT = 9876;

export class HermesContainer extends Container<Env> {
  // The shim is the only port the Worker proxies. Set as defaultPort so
  // the SDK's startAndWaitForPorts health-checks against it.
  defaultPort = SHIM_PORT;
  // Idle window before the container sleeps. Counter-intuitively this is
  // SHORT, not huge: @cloudflare/containers schedules its keepalive/renewal
  // alarm `sleepAfter` in the future, so a giant value (we used "8760h")
  // means ~no heartbeat → the container gets evicted when idle and nothing
  // wakes it (Hermes has no inbound HTTP). Instead we keep it warm with a
  // 1-minute cron (see wrangler.jsonc + scheduled() below) and set a
  // forgiving 5m idle window so a single missed tick doesn't drop it.
  sleepAfter = "5m";

  // Forward Worker secrets to the container as env vars. SDK reads this
  // when starting the container; without it the container sees no env
  // and start.sh fails with "$R2_ACCESS_KEY_ID is not set".
  //
  // Container uses rclone (not FUSE) to back up /opt/data to R2, so we
  // pass the R2 credentials through as-is — start.sh writes its own
  // rclone.conf and constructs the endpoint from CF_ACCOUNT_ID.
  envVars = {
    R2_ACCESS_KEY_ID: this.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: this.env.R2_SECRET_ACCESS_KEY,
    CF_ACCOUNT_ID: this.env.CF_ACCOUNT_ID,
    R2_BUCKET_NAME: this.env.R2_BUCKET_NAME,
    OPENAI_API_BASE_URL: this.env.OPENAI_API_BASE_URL,
    OPENAI_API_KEY: this.env.OPENAI_API_KEY,
    HERMES_MODEL: this.env.HERMES_MODEL,
    TELEGRAM_BOT_TOKEN: this.env.TELEGRAM_BOT_TOKEN,
  };

  // Route a request to the in-container admin shim on :9876. The shim
  // is started by start.sh as one of the first things, so it's ready
  // ~5s after container boot (well under any timeout).
  async shimFetch(req: Request): Promise<Response> {
    await this.startAndWaitForPorts(SHIM_PORT, {
      portReadyTimeoutMS: 45_000,
    });
    return this.containerFetch(req, SHIM_PORT);
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("worker ok\n", { status: 200 });
    }

    if (url.pathname === "/id") {
      const doId = env.HERMES.idFromName("singleton").toString();
      return new Response(`instance_id=${doId}\n`, {
        headers: { "content-type": "text/plain" },
        status: 200,
      });
    }

    // /debug/cli?cmd=hermes+pairing+approve+telegram+<CODE>
    // Forwarded to the admin shim on :9876 inside the container.
    if (url.pathname === "/debug/cli") {
      const cmd = url.searchParams.get("cmd") || "hermes --help";
      const stub = env.HERMES.get(env.HERMES.idFromName("singleton"));
      const shimReq = new Request(
        `http://internal/exec?cmd=${encodeURIComponent(cmd)}`,
        { method: "GET" }
      );
      return stub.shimFetch(shimReq);
    }

    return new Response(
      "hermes-cf: this Worker has no public HTTP gateway.\n" +
      "Ops endpoints: /health, /id, /debug/cli?cmd=hermes+<subcmd>\n" +
      "Bot users: message your Hermes Telegram bot directly.\n",
      { headers: { "content-type": "text/plain" }, status: 404 }
    );
  },

  // Keepalive heartbeat. Fired by the 1-minute cron trigger (wrangler.jsonc).
  // The Worker is serverless and always available, so this runs even while
  // the container is asleep. A single lightweight containerFetch is enough:
  // the @cloudflare/containers lib renews the sleepAfter timer on any fetch
  // AND cold-starts the container if it had gone down — restoring the
  // Telegram long-poll so queued inbound messages get picked up.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const stub = env.HERMES.get(env.HERMES.idFromName("singleton"));
    const ping = new Request(
      "http://internal/exec?cmd=" + encodeURIComponent("hermes gateway status"),
      { method: "GET" }
    );
    // waitUntil so the tick isn't billed/blocked on the full container boot;
    // starting it is what matters, not awaiting the response.
    ctx.waitUntil(
      stub.shimFetch(ping).then(
        () => {},
        () => {} // swallow errors — next tick retries
      )
    );
  },
};

interface Env {
  HERMES: DurableObjectNamespace<HermesContainer>;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_BUCKET_NAME: string;
  CF_ACCOUNT_ID: string;
  OPENAI_API_BASE_URL: string;
  OPENAI_API_KEY: string;
  HERMES_MODEL: string;
  TELEGRAM_BOT_TOKEN: string;
}
