// Bambuddy -> Slack/Mattermost image proxy.
// Problem: Bambuddy Slack-format webhooks send `attachments: [{image_url}]`
// that point at Bambuddy itself (needs External URL / auth / LAN access),
// so Slack's cloud fetcher can't see the snapshot. Generic-format webhooks
// instead embed a base64 `image` field that incoming-webhooks can't display.
// This proxy sits on your LAN, accepts EITHER format from Bambuddy with no
// auth exposed to the internet, re-hosts the image bytes itself at an
// unauthenticated GET /img/:id URL, rewrites the payload to point at that
// URL, and forwards it to the real Slack/Mattermost webhook.
//
// Flow:
//   Bambuddy --(generic or slack JSON)--> POST /webhook (this proxy)
//     -> decode base64 `image` OR download `attachments[].image_url`
//        (using BAMBUDDY_API_KEY / forwarded auth headers, LAN ok)
//     -> store in memory, serve at GET /img/:id (no auth)
//     -> POST {"text", attachments:[{image_url: PUBLIC/img/:id}]} to REAL_WEBHOOK_URL
//
// Env:
//   REAL_WEBHOOK_URL (or DESTINATION_WEBHOOK_URL / SLACK_WEBHOOK_URL,
//     or comma-separated WEBHOOK_URLS for fan-out) - required
//   PUBLIC_BASE_URL - e.g. https://proxy.example.com (how Slack reaches /img/:id).
//     If unset, falls back to the incoming request Host (fine when proxy itself is public).
//   PORT - default 3000
//   IMAGE_TTL_HOURS - default 72 (matches Bambuddy's 3-day snapshot links)
//   MAX_IMAGE_BYTES - default 10_000_000
//   BAMBUDDY_API_KEY - REQUIRED for Slack-format photo URLs. Bambuddy serves
//     snapshots at /api/v1/archives/.../photos/....jpg behind API-key auth
//     (X-API-Key or Bearer). Create one in Bambuddy: Settings > API Keys
//     with the Read Status scope, and paste it here. The proxy fetches with
//     the key and re-hosts the bytes unauthenticated for Slack.
//   INCOMING_TOKEN - optional, if set require ?token=.. or Bearer on POSTs

const PORT = Number(process.env.PORT ?? 3000);
const IMAGE_TTL_HOURS = Number(process.env.IMAGE_TTL_HOURS ?? 72);
const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_BYTES ?? 10_000_000);
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
const BAMBUDDY_API_KEY = process.env.BAMBUDDY_API_KEY ?? "";
const INCOMING_TOKEN = process.env.INCOMING_TOKEN ?? "";

function destinations(): string[] {
  const raw =
    process.env.REAL_WEBHOOK_URL ??
    process.env.DESTINATION_WEBHOOK_URL ??
    process.env.SLACK_WEBHOOK_URL ??
    process.env.WEBHOOK_URLS ??
    "";
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

type StoredImage = {
  bytes: Uint8Array;
  contentType: string;
  createdAt: number;
};

const images = new Map<string, StoredImage>();

function newId(): string {
  // 16 hex chars, URL-safe, unpredictable (this IS the auth)
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function purgeExpired() {
  const ttlMs = IMAGE_TTL_HOURS * 3600_000;
  const now = Date.now();
  for (const [id, img] of images) {
    if (now - img.createdAt > ttlMs) images.delete(id);
  }
}
setInterval(purgeExpired, 10 * 60_000);

function decodeBase64Image(s: string): { bytes: Uint8Array; contentType: string } | null {
  try {
    let data = s.trim();
    if (data.length < 50) return null;
    let contentType = "image/jpeg";
    const m = data.match(/^data:([^;,]+)?;base64,(.*)$/s);
    if (m) {
      if (m[1]) contentType = m[1];
      data = m[2];
    }
    data = data.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/=]+$/.test(data)) return null;
    const bin = Buffer.from(data, "base64");
    if (bin.length === 0 || bin.length > MAX_IMAGE_BYTES) return null;
    // sniff type — must look like an image, otherwise it wasn't one
    if (bin[0] === 0x89 && bin[1] === 0x50) contentType = "image/png";
    else if (bin[0] === 0xff && bin[1] === 0xd8) contentType = "image/jpeg";
    else if (bin.subarray(0, 4).toString() === "GIF8") contentType = "image/gif";
    else if (bin[0] === 0x52 && bin[1] === 0x49) contentType = "image/webp"; // RIFF
    else return null;
    return { bytes: new Uint8Array(bin), contentType };
  } catch {
    return null;
  }
}

function extFor(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("webp")) return "webp";
  return "jpg";
}

function publicBase(req: Request): string {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const u = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto") ?? u.protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? u.host;
  return `${proto}://${host}`;
}

function isSlackRenderableUrl(url: string): boolean {
  // Slack validates Block Kit `image` blocks synchronously and rejects the
  // ENTIRE message with `400 invalid_blocks` if image_url isn't a public
  // HTTPS URL. Localhost / LAN / plain-HTTP re-hosts (e.g. the
  // http://127.0.0.1:3005 test base) always fail that check, so we must
  // not put them in `blocks` — send attachments-only (lenient) instead.
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return false;
    if (h === "127.0.0.1" || h === "::1" || h === "0.0.0.0") return false;
    if (/^(10|127)\./.test(h)) return false;
    if (/^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return false;
    return true;
  } catch {
    return false;
  }
}

function cleanUrl(raw: string): string {
  // Slack mrkdwn `<https://..|label>` leaves `|label` attached to the match,
  // and bold wrapping (`*url*`) or sentence punctuation (`.`, `,`, `!`)
  // gets glued to the end. Strip all of that.
  let u = raw;
  const pipe = u.indexOf("|");
  if (pipe !== -1) u = u.slice(0, pipe);
  u = u.replace(/[*,.!?;:_\]~]+$/g, "");
  return u;
}

function isImageCandidate(url: string): boolean {
  try {
    const u = new URL(url);
    const path = u.pathname;
    // Normal case: URL path ends with an image extension. Use pathname
    // (not the raw string) so query strings / fragments don't break it.
    if (/\.(jpe?g|png|gif|webp)$/i.test(path)) return true;
    // Bambuddy photo URLs: /api/v1/archives/<id>/photos/<file>
    // (usually .jpg, but accept regardless of extension — the download
    // verifies content-type anyway).
    if (/\/api\/v\d+\/archives\//i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

function collectImageUrls(node: unknown, out: string[]): void {
  // Scan EVERY string in the payload (text, message, fallback, blocks,
  // etc.) — Bambuddy puts the photo URL in different fields depending on
  // format/event, and only scanning `text` misses most of them.
  if (typeof node === "string") {
    const re = /https?:\/\/[^\s<>"')\]]+/g;
    for (const m of node.matchAll(re)) {
      const cleaned = cleanUrl(m[0]);
      if (cleaned.startsWith("http") && isImageCandidate(cleaned)) out.push(cleaned);
    }
    return;
  }
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const v of node) collectImageUrls(v, out);
    return;
  }
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if ((k === "image_url" || k === "imageUrl") && typeof v === "string" && v.startsWith("http")) {
      // Explicit image fields: trust them even without an extension
      // (Bambuddy photo routes); download verifies it's really an image.
      out.push(cleanUrl(v));
    } else {
      collectImageUrls(v, out);
    }
  }
}

async function downloadImage(
  url: string,
  incoming: Request,
): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  // Bambuddy sometimes fires the webhook before the photo file is
  // actually readable (or while the archive is still being written),
  // so a single fetch flakes. Retry 404/5xx/network errors a few times;
  // don't bother retrying 401/403 (bad key won't fix itself in 10s).
  const MAX_ATTEMPTS = 4;
  const DELAYS_MS = [1500, 3000, 5000];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const headers: Record<string, string> = { "User-Agent": "bambuddy-proxy/1.0" };
      // Auth for Bambuddy's protected photo URLs
      // (/api/v1/archives/.../photos/....jpg requires an API key).
      // Priority: configured key first, else whatever the caller sent us.
      // Bambuddy accepts the key as X-API-Key OR Authorization: Bearer —
      // send both forms so either gate passes.
      const auth = incoming.headers.get("authorization");
      const apiKey = incoming.headers.get("x-api-key");
      const key = BAMBUDDY_API_KEY || apiKey || (auth?.startsWith("Bearer ") ? auth.slice(7) : "");
      if (key) {
        headers["X-API-Key"] = key;
        headers["Authorization"] = `Bearer ${key}`;
      } else if (auth) {
        headers["Authorization"] = auth;
      }
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(url, { headers, signal: ctrl.signal });
      clearTimeout(t);
      if (res.ok) {
        const ct = res.headers.get("content-type") ?? "image/jpeg";
        const buf = new Uint8Array(await res.arrayBuffer());
        if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
        // Only accept actual images — a 200 with JSON/HTML (e.g. an API
        // error page) must not be re-hosted as an "image".
        if (!ct.split(";")[0].trim().toLowerCase().startsWith("image/")) {
          console.error(`[img] ${url} returned content-type ${ct} (not an image) — forwarding text-only.`);
          return null;
        }
        if (attempt > 1) console.log(`[img] fetched ${url} on attempt ${attempt}`);
        return { bytes: buf, contentType: ct.split(";")[0] };
      }
      if (res.status === 401 || res.status === 403) {
        console.error(
          `[img] fetch ${res.status} for ${url} — Bambuddy rejected the API key ` +
            `(missing key? set BAMBUDDY_API_KEY to a key with Read Status scope). ` +
            `Forwarding text-only.`,
        );
        return null;
      }
      const body = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`[img] fetch ${res.status} for ${url} (attempt ${attempt}/${MAX_ATTEMPTS}) ${body}`);
      if (attempt === MAX_ATTEMPTS) return null;
    } catch (e) {
      console.error(`[img] fetch failed for ${url} (attempt ${attempt}/${MAX_ATTEMPTS}):`, (e as Error).message);
      if (attempt === MAX_ATTEMPTS) return null;
    }
    await Bun.sleep(DELAYS_MS[Math.min(attempt - 1, DELAYS_MS.length - 1)]);
  }
  return null;
}

function checkIncomingAuth(req: Request): boolean {
  if (!INCOMING_TOKEN) return true;
  const u = new URL(req.url);
  if (u.searchParams.get("token") === INCOMING_TOKEN) return true;
  const auth = req.headers.get("authorization") ?? "";
  if (auth === `Bearer ${INCOMING_TOKEN}`) return true;
  if (req.headers.get("x-proxy-token") === INCOMING_TOKEN) return true;
  return false;
}

async function handleWebhook(req: Request): Promise<Response> {
  if (!checkIncomingAuth(req)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const dests = destinations();
  if (dests.length === 0) {
    return Response.json(
      { error: "server misconfigured: set REAL_WEBHOOK_URL" },
      { status: 500 },
    );
  }

  let payload: any;
  try {
    const ct = req.headers.get("content-type") ?? "";
    if (ct.includes("application/x-www-form-urlencoded")) {
      const form = await req.formData();
      const p = form.get("payload");
      payload = JSON.parse(typeof p === "string" ? p : "{}");
    } else {
      payload = await req.json();
    }
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  // --- determine display text ---
  const title = typeof payload.title === "string" ? payload.title : "";
  const message = typeof payload.message === "string" ? payload.message : "";
  let text: string =
    typeof payload.text === "string" && payload.text.length > 0
      ? payload.text
      : title && message
        ? `*${title}*\n${message}`
        : title || message || "Bambuddy notification";

  // --- gather image bytes ---
  const toHost: { bytes: Uint8Array; contentType: string }[] = [];

  // 1) generic-format base64 `image` field (preferred: no Bambuddy fetch needed)
  if (typeof payload.image === "string" && payload.image.length > 0) {
    const decoded = decodeBase64Image(payload.image);
    if (decoded) toHost.push(decoded);
  }

  // 2) slack-format attachments[].image_url (download with auth, re-host unauth).
  //    Bambuddy photo URLs look like
  //    https://<host>/api/v1/archives/21/photos/finish_....jpg and REQUIRE
  //    an API key (X-API-Key / Bearer) — Slack can't send one, we can.
  //    URLs are also picked up from ANY text field (text/message/fallback/
  //    blocks) so a bare photo link in the message still gets proxied.
  const urls: string[] = [];
  collectImageUrls(payload, urls);
  console.log(`[img] collected candidate URLs: ${JSON.stringify(urls)}`);
  const seen = new Set<string>();
  const downloadedFrom: string[] = [];
  let attempted = 0;
  for (const u of urls) {
    if (toHost.length >= 3) break;
    if (seen.has(u)) continue;
    seen.add(u);
    // skip if it already points at us (loop guard).
    if (u.startsWith(publicBase(req) + "/img/")) continue;
    attempted++;
    const dl = await downloadImage(u, req);
    if (dl) {
      toHost.push(dl);
      downloadedFrom.push(u);
    }
  }
  const downloadedCount = downloadedFrom.length;
  const imageWarning =
    attempted > downloadedCount
      ? "image download failed (Bambuddy photo not ready yet or missing/invalid BAMBUDDY_API_KEY) — forwarded text-only"
      : undefined;
  if (imageWarning) console.error(`[img] ${imageWarning} candidates=${JSON.stringify(urls)}`);

  // --- store + build public URLs ---
  const base = publicBase(req);
  const hosted: string[] = [];
  for (const img of toHost.slice(0, 3)) {
    const id = newId();
    images.set(id, { ...img, createdAt: Date.now() });
    hosted.push(`${base}/img/${id}.${extFor(img.contentType)}`);
  }
  // original URL -> hosted URL, used to swap the private Bambuddy link
  // out of the forwarded text so Slack never shows the unreachable URL.
  // toHost[0..nBase64) are base64 (no source URL); downloads follow in order.
  const nBase64 = toHost.length - downloadedCount;
  const replacements: [string, string][] = downloadedFrom
    .map((from, j): [string, string] => [from, hosted[nBase64 + j] ?? ""])
    .filter(([_, to]) => Boolean(to));
  // Swap private Bambuddy URLs for our public re-hosts in the text, so
  // the channel sees one working link/image instead of a dead private URL.
  for (const [from, to] of replacements) {
    text = text.split(from).join(to);
  }

  // --- build outgoing Slack/Mattermost-compatible payload ---
  const fallback = title || text.slice(0, 120);
  let outgoing: Record<string, unknown>;
  if (hosted.length > 0) {
    // Rewrite any existing attachment image_urls to our hosted ones (in order),
    // else create a fresh attachment. Keep username/channel/icon if caller set them.
    const origAttachments = Array.isArray(payload.attachments) ? [...payload.attachments] : [];
    let hi = 0;
    for (const a of origAttachments) {
      if (a && typeof a === "object" && hi < hosted.length) {
        const hasImg =
          typeof (a as any).image_url === "string" || typeof (a as any).imageUrl === "string";
        if (hasImg) {
          (a as any).image_url = hosted[hi++];
          delete (a as any).imageUrl;
        }
      }
    }
    // Scrub any leftover private Bambuddy URLs from attachment
    // fallback/text so only the public re-host is ever shown.
    for (const a of origAttachments) {
      if (a && typeof a === "object") {
        for (const fk of ["fallback", "text", "title"]) {
          if (typeof (a as any)[fk] === "string") {
            for (const [from, to] of replacements) {
              (a as any)[fk] = (a as any)[fk].split(from).join(to);
            }
          }
        }
      }
    }
    while (hi < hosted.length) {
      let amsg = message || undefined;
      if (typeof amsg === "string") {
        for (const [from, to] of replacements) amsg = amsg.split(from).join(to) as string;
      }
      origAttachments.push({
        fallback,
        title: title || undefined,
        text: amsg,
        image_url: hosted[hi++],
      });
    }
    outgoing = {
      text,
      attachments: origAttachments,
    };
    // NOTE: image goes in attachments ONLY. Slack renders both attachments
    // and Block Kit image blocks, so putting it in both = the image twice.
    // (Attachments render on both Slack and Mattermost; image blocks are
    // Slack-only.) Only add the text section block when it's safe: Slack
    // 400s the WHOLE message (invalid_blocks) on some non-public URLs.
    if (hosted.every(isSlackRenderableUrl)) {
      (outgoing as any).blocks = [
        { type: "section", text: { type: "mrkdwn", text } },
      ];
    }
    for (const k of ["username", "icon_emoji", "icon_url", "channel"]) {
      if (payload[k] !== undefined) outgoing[k] = payload[k];
    }
  } else {
    // no image: forward essentially as-is (slack-format) or as text (generic)
    if (typeof payload.text === "string") {
      outgoing = payload;
    } else {
      outgoing = { text };
      for (const k of ["username", "icon_emoji", "icon_url", "channel"]) {
        if (payload[k] !== undefined) outgoing[k] = payload[k];
      }
    }
  }

  // --- forward to real webhook(s) ---
  // If Slack still 400s on invalid_blocks (e.g. edge-case URL it dislikes),
  // retry attachments-only, then text-only, so the text always lands.
  async function postJson(url: string, body: unknown): Promise<{ status: number; ok: boolean; text: string }> {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const t = (await r.text()).slice(0, 500);
    return { status: r.status, ok: r.ok, text: t };
  }
  const textOnlyFallback: Record<string, unknown> = { text };
  for (const k of ["username", "icon_emoji", "icon_url", "channel"]) {
    if ((outgoing as any)[k] !== undefined) textOnlyFallback[k] = (outgoing as any)[k];
  }
  const results = [];
  for (const d of dests) {
    try {
      let r = await postJson(d, outgoing);
      console.log(`[fwd] ${r.status} -> ${d.slice(0, 60)}... ${r.text.slice(0, 120)}`);
      if (!r.ok && r.status === 400 && /invalid_blocks/i.test(r.text) && (outgoing as any).blocks) {
        const { blocks: _drop, ...noBlocks } = outgoing as any;
        console.log(`[fwd] invalid_blocks — retrying without blocks`);
        r = await postJson(d, noBlocks);
        console.log(`[fwd] retry ${r.status} -> ${d.slice(0, 60)}... ${r.text.slice(0, 120)}`);
      }
      if (!r.ok && r.status === 400 && (outgoing as any).attachments) {
        console.log(`[fwd] still 400 — retrying text-only`);
        r = await postJson(d, textOnlyFallback);
        console.log(`[fwd] retry2 ${r.status} -> ${d.slice(0, 60)}... ${r.text.slice(0, 120)}`);
      }
      results.push({ dest: d.slice(0, 60) + "...", status: r.status, ok: r.ok });
    } catch (e) {
      console.error(`[fwd] failed -> ${d}:`, (e as Error).message);
      results.push({ dest: d, ok: false, error: (e as Error).message });
    }
  }

  purgeExpired();
  const allOk = results.every((r) => r.ok);
  return Response.json(
    { ok: allOk, images: hosted, ...(imageWarning ? { warning: imageWarning } : {}), forwarded: results },
    { status: allOk ? 200 : 502 },
  );
}

function serveImage(req: Request): Response | null {
  const u = new URL(req.url);
  const m = u.pathname.match(/^\/img\/([A-Za-z0-9_-]+)(?:\.(jpg|jpeg|png|gif|webp))?$/);
  if (!m) return null;
  const img = images.get(m[1]);
  if (!img) return new Response("not found or expired", { status: 404 });
  if (Date.now() - img.createdAt > IMAGE_TTL_HOURS * 3600_000) {
    images.delete(m[1]);
    return new Response("expired", { status: 410 });
  }
  return new Response(img.bytes as unknown as BodyInit, {
    headers: {
      "Content-Type": img.contentType,
      "Cache-Control": "public, max-age=86400",
      "Content-Length": String(img.bytes.length),
    },
  });
}

const HELP = `<!doctype html><title>bambuddy proxy</title>
<h1>bambuddy-webhook-photo-unauth</h1>
<p>POST Bambuddy JSON to <code>/webhook</code>. Images are re-hosted unauthenticated at <code>/img/:id</code> and forwarded to <code>REAL_WEBHOOK_URL</code>.</p>
<ul><li>GET /healthz</li><li>GET /img/:id</li><li>POST /webhook (also / and /slack)</li></ul>`;

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const u = new URL(req.url);
    if (req.method === "GET" && u.pathname === "/healthz")
      return Response.json({ ok: true, images: images.size });
    if ((req.method === "GET" || req.method === "HEAD") && u.pathname.startsWith("/img/")) {
      const r = serveImage(req);
      if (r) return r;
      return new Response("not found", { status: 404 });
    }
    if (req.method === "POST" && ["/webhook", "/", "/slack", "/mattermost", "/hook"].includes(u.pathname))
      return handleWebhook(req);
    if (req.method === "GET" && u.pathname === "/") {
      return new Response(HELP, { headers: { "Content-Type": "text/html" } });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[proxy] listening on :${PORT}`);
console.log(`[proxy] destinations: ${destinations().length || "(none — set REAL_WEBHOOK_URL)"}`);
console.log(`[proxy] public base: ${PUBLIC_BASE_URL || "(auto from Host)"}, ttl: ${IMAGE_TTL_HOURS}h`);
console.log(
  BAMBUDDY_API_KEY
    ? "[proxy] bambuddy api key: set (authed photo URLs will download)"
    : "[proxy] WARNING: BAMBUDDY_API_KEY not set — authed Bambuddy photo URLs (/api/v1/archives/.../photos/...) will fail and forward text-only",
);
export default server;
