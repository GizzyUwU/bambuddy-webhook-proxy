# bambuddy-webhook-photo-unauth

Proxy that lets Bambuddy notify Slack/Mattermost **with photos**, without exposing Bambuddy or giving Slack any credentials.

## Problem

- Bambuddy's **Slack-format** webhooks send `{"text": ...}` plus `attachments: [{image_url}]` pointing at Bambuddy itself. Slack's cloud fetcher can't reach that (LAN-only / needs auth / needs External URL), so the image is broken.
- Bambuddy's **generic-format** webhooks embed the snapshot as base64 `image`, which Slack/Mattermost incoming webhooks can't render.

## Solution

```
Bambuddy --(generic OR slack JSON)--> POST /webhook on this proxy (LAN, :3000)
  -> decode base64 `image`, or download `attachments[].image_url`
     (LAN fetch, optional BAMBUDDY_API_KEY / forwarded auth headers)
  -> re-host bytes at GET /img/:id  (NO auth — random 24-hex-char id, TTL 72h)
  -> forward {"text", attachments:[{image_url: <proxy>/img/:id}], blocks:[...]}
     to REAL_WEBHOOK_URL (Slack/Mattermost)
```

Slack fetches the image from **the proxy**, never from Bambuddy. Bambuddy stays private.

## Run with Docker (alpine/bun)

```bash
cp .env.example .env   # fill in REAL_WEBHOOK_URL + PUBLIC_BASE_URL
docker compose up -d --build
curl localhost:3000/healthz
```

## Run with Bun directly

```bash
bun src/index.ts
# env: REAL_WEBHOOK_URL=... PUBLIC_BASE_URL=... bun src/index.ts
```

## Bambuddy setup

1. **Create an API key** (required for photo URLs): Bambuddy serves snapshots at
   `https://<your-host>/api/v1/archives/.../photos/finish_....jpg` **behind API-key auth**
   (Slack can't send auth headers, which is the whole problem). Go to
   **Settings > API Keys > Create**, tick the **Read Status** scope (covers archive/photo reads),
   copy the key (shown once), and set it as `BAMBUDDY_API_KEY` in `.env`.
   The proxy fetches with the key and re-hosts the bytes unauthenticated for Slack.
2. Settings > Notifications > Add Provider > **Webhook**.
3. URL = `http://<proxy-lan-ip>:3000/webhook` (either payload format works):
   - **Generic format** (recommended): includes base64 `image`, needs no External URL, no auth. Proxy decodes and re-hosts.
   - **Slack format**: proxy downloads each `attachments[].image_url` using `BAMBUDDY_API_KEY` and re-hosts.
4. `PUBLIC_BASE_URL` must be reachable **from Slack's servers** (public HTTPS), e.g. `https://bambuddy-proxy.example.com`. Only `/img/:id` (random ids, 72h TTL) is exposed — not Bambuddy itself. If your Mattermost is on the same LAN, `PUBLIC_BASE_URL` can be the LAN address.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `POST` | `/webhook` (also `/`, `/slack`, `/mattermost`, `/hook`) | Bambuddy payload in, rewritten payload forwarded |
| `GET` | `/img/:id.jpg` | unauthenticated image, `Cache-Control: public` |
| `GET` | `/healthz` | `{"ok":true}` |

### Optional incoming auth

Set `INCOMING_TOKEN`: Bambuddy URL becomes `http://proxy:3000/webhook?token=SECRET`. (Bambuddy custom headers also work with `Authorization: Bearer SECRET`.)

## Env reference

| Var | Default | Meaning |
|---|---|---|
| `REAL_WEBHOOK_URL` | (required) | dest webhook; aliases `DESTINATION_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `WEBHOOK_URLS`; comma-separated = fan-out |
| `PUBLIC_BASE_URL` | auto from Host | base used to build `/img/:id` URLs for Slack to fetch |
| `PORT` | `3000` | listen port |
| `IMAGE_TTL_HOURS` | `72` | how long `/img/:id` lives (matches Bambuddy's 3-day links) |
| `MAX_IMAGE_BYTES` | `10000000` | reject larger images |
| `BAMBUDDY_API_KEY` | (required for photos) | Bambuddy API key (Read Status scope), sent as `X-API-Key` + `Bearer` when downloading `image_url`s |
| `INCOMING_TOKEN` | | require `?token=` / Bearer on POSTs |

## Quick test

```bash
# fake Bambuddy generic payload through the proxy to a debug endpoint:
REAL_WEBHOOK_URL=https://webhook.site/<id> PUBLIC_BASE_URL=http://localhost:3000 \
  bun src/index.ts &
curl -s localhost:3000/webhook -H 'Content-Type: application/json' -d '{
  "title": "Print Complete",
  "message": "X1C: benchy.3mf completed in 2h 15m",
  "event": "print_complete",
  "image": "'$(base64 -w0 /tmp/test.jpg)'"
}' | bun -e 'console.log(await (await fetch("http://localhost:3000/healthz")).text())'
```
