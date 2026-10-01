// Quick live test: real Bambuddy photo -> proxy -> real webhook.
// Run: BAMBUDDY_API_KEY='bb_...' REAL_WEBHOOK_URL='https://...' bun test-live.ts
// Secrets come from env only — never commit them.
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PHOTO_URL =
  process.env.TEST_PHOTO_URL ??
  "https://bam.gizzy.gay/api/v1/archives/21/photos/finish_20261001_153632_ddbb852f.jpg";
const KEY = process.env.BAMBUDDY_API_KEY ?? "";
const DEST = process.env.REAL_WEBHOOK_URL ?? "";
const PORT = process.env.TEST_PORT ?? "3005";

if (!KEY) throw new Error("set BAMBUDDY_API_KEY");
if (!DEST) throw new Error("set REAL_WEBHOOK_URL");

console.log("== 1. direct fetch of Bambuddy photo ==");
const direct = await fetch(PHOTO_URL, {
  headers: { "X-API-Key": KEY, Authorization: `Bearer ${KEY}` },
});
console.log(`status: ${direct.status} ${direct.headers.get("content-type")}`);
if (!direct.ok) throw new Error(`direct fetch failed: ${direct.status} ${await direct.text()}`);
const directBytes = new Uint8Array(await direct.arrayBuffer());
console.log(`bytes: ${directBytes.length}`);

console.log("\n== 2. start proxy ==");
const proxy = Bun.spawn(["bun", join(HERE, "src/index.ts")], {
  env: {
    ...process.env,
    PORT,
    REAL_WEBHOOK_URL: DEST,
    PUBLIC_BASE_URL: `http://127.0.0.1:${PORT}`,
    BAMBUDDY_API_KEY: KEY,
  },
  stdout: "inherit",
  stderr: "inherit",
});
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 30; i++) {
  try {
    const h = await fetch(`${base}/healthz`);
    if (h.ok) break;
  } catch {}
  await Bun.sleep(300);
}

console.log("\n== 3. POST slack-format payload (as Bambuddy would send) ==");
const res = await fetch(`${base}/webhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    text: "TEST: Print Complete (proxy live test, ignore)",
    attachments: [{ fallback: "test", image_url: PHOTO_URL }],
  }),
});
const out = (await res.json()) as any;
console.log(JSON.stringify(out, null, 2));

if (out.images?.length) {
  console.log("\n== 4. fetch re-hosted image ==");
  const img = await fetch(out.images[0]);
  const buf = new Uint8Array(await img.arrayBuffer());
  console.log(`status: ${img.status} ${img.headers.get("content-type")} bytes: ${buf.length}`);
  console.log(
    buf.length === directBytes.length ? "MATCH: re-hosted bytes == Bambuddy bytes" : "MISMATCH!",
  );
}

proxy.kill();
console.log("\nDone. Check your Slack/Mattermost channel for the test message.");
console.log(
  "NOTE: with this test's localhost PUBLIC_BASE_URL the proxy sends text + legacy attachments (no Block Kit image blocks, which Slack would 400-reject as invalid_blocks). The image renders in Slack only once PUBLIC_BASE_URL is a public HTTPS URL pointing at the proxy.",
);
process.exit(0);
