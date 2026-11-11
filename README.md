# Transferly

Send files directly between two browsers. One person reads out their 6-digit code, the other types it in, the code's owner taps **Accept**, and the two browsers connect peer-to-peer. There are no accounts, links or long tokens to copy, and file data is never uploaded.

With no internet, the app still opens (it's cached after the first visit), and devices on the same Wi-Fi or hotspot pair by scanning each other's QR codes.

## Contents

- [User flow](#user-flow)
- [Architecture](#architecture)
- [Pairing protocol](#pairing-protocol)
- [Offline mode](#offline-mode)
- [File transfer protocol](#file-transfer-protocol)
- [Security model](#security-model)
- [Timeouts and limits](#timeouts-and-limits)
- [Running locally](#running-locally)
- [Deploying](#deploying)
  - [Pairing server](#1-pairing-server-cloudflare-worker)
- [Known limitations](#known-limitations)
- [Code map](#code-map)

## User flow

1. **Open the page on both devices.** Each one shows a code under **Share your code**, for example `482 913`. A small countdown ring next to it shows how long the code stays valid (10 minutes). The code renews itself when time runs out, but never while you're typing a code or pairing. Tap the ring to get a new code straight away.
2. **One person types the other's code** under **Enter a code**. That device shows *Waiting for 482 913 to accept*, with **Cancel**.
3. **The code's owner sees a prompt:** *615 207 wants to connect*, with **Decline** and **Accept**. `615 207` is the requester's own code, so the owner can check it against the requester's screen.
4. **Accept.** Both screens switch to **Connected** and show a drop area. Either side can drop or choose files at any time, and both directions work at once.
5. **Receive.** Incoming files appear with a progress bar, then a **Save** button. Sent files show *Delivered* once the other browser confirms them.
6. **Finish.** **Disconnect** ends the session and gives that device a fresh code. If the other side leaves, the screen shows **Disconnected**, with **New connection**.

Other outcomes:

| Situation | What happens |
| --- | --- |
| Owner taps Decline | Requester sees *482 913 declined your request.* |
| Requester taps Cancel | The owner's prompt disappears. |
| Nobody answers for 2 minutes | The request expires on both sides. |
| Both people type each other's code | Treated as mutual consent: they connect with no prompt. |
| Owner is already handling a request | Further requests are declined automatically. |
| Code doesn't exist or has expired | *No device is using that code.* |
| User types their own code | *That's your own code.* |
| Direct connection can't be made within 30 s | *The connection timed out…*, and both return to their codes. |

## Architecture

```
 Browser A              Cloudflare Worker (free plan)             Browser B
 ─────────              ─────────────────────────────             ─────────
 WebSocket  ══════════▶ Durable Object per code  ◀────── POST /send (encrypted)
 (holds code 482913)    pushes messages instantly
                        /ice: relay credentials (only while pairing, within budget)

 ═══════════════ direct WebRTC connection (DTLS-encrypted) ═══════════════
           files travel only on this connection (or via the TURN relay)
```

- **Frontend:** Next.js App Router and React 19, deployed on Vercel. A single client component, `components/transferly-app.tsx`, plus a service worker for offline use.
- **Pairing server (recommended): `worker/`.** A Cloudflare Worker with one Durable Object per code. The code's owner keeps a WebSocket open, and messages sent to the code are pushed down it immediately. Idle sockets hibernate, so they cost almost nothing, and nothing polls. See [Deploying](#1-pairing-server-cloudflare-worker).
- **Pairing server (fallback): `POST /api/signal`** on the Next.js app, which browsers poll every 1.2 s. It's used when `NEXT_PUBLIC_SIGNAL_URL` isn't set, and needs Upstash Redis on Vercel.
- **Transport:** WebRTC data channels. STUN finds a direct path; a TURN relay (Cloudflare Realtime) is the fallback for networks that block direct connections.

## Pairing protocol

### Codes and mailboxes

On load, each browser:

1. Picks a random code from `000000` to `999999` with `crypto.getRandomValues`. It uses rejection sampling, so every code is equally likely.
2. Computes `mailboxId = SHA-256("transferly/mailbox/v1:" + code)`.
3. Generates a random 128-bit `secret`.
4. Calls `claim(mailboxId, secret)`. The server creates the mailbox only if that id is free. On a clash the browser picks a new code, up to 6 tries.

The **secret is needed to read** the mailbox, so nobody else can drain it. **Anyone may write** to a mailbox if they know the code, since writing requires computing its id.

**Receiving messages:**

- **With the Worker:** the browser opens a WebSocket to `/ws?id=…&secret=…`, and that connection *is* the claim. The Durable Object for that id stores the secret and pushes each message as it arrives. If the socket drops (for example when a phone backgrounds the tab), the browser reconnects with the same secret, and messages sent in the meantime are queued (up to 16) and delivered. A code is freed 10 minutes after its owner's last socket closes, or straight away on release.
- **With the fallback:** the browser polls its mailbox every 1.2 s (3.6 s while the tab is hidden). If the mailbox has gone, it claims a new code.

### Messages

Every message is JSON, encrypted for the **recipient's** code:

```
key        = PBKDF2-SHA256(code, salt "transferly/key/v1", 150 000 iterations) → AES-256-GCM key
ciphertext = base64url( 12-byte random IV ‖ AES-GCM(key, JSON) )
```

| Message | Sent by | Contents | Meaning |
| --- | --- | --- | --- |
| `request` | requester → owner | `from` | "Can I connect?" |
| `accept` | owner → requester | `from` | "Yes." |
| `decline` | owner → requester | `from` | "No" (also used when busy). |
| `cancel` | requester → owner | `from` | "Never mind." |
| `offer` | requester → owner | `from`, `sid`, `sdp` | WebRTC offer (after accept). |
| `answer` | owner → requester | `from`, `sid`, `sdp` | WebRTC answer. |

`from` is always the sender's own code, so the recipient knows where to reply. A message that fails decryption or validation is ignored.

### Sequence

```
 Requester (B, code 615207)                                   Owner (A, code 482913)
 types 482913
   ── request{from:615207} ─────────────▶ mailbox(482913)
   "Waiting for 482 913 to accept"                            prompt: "615 207 wants to connect"
                                                              taps Accept
   mailbox(615207) ◀──────────────────── accept{from:482913} ──
   creates WebRTC offer (waits ≤3 s for ICE candidates)
   ── offer{from, sid, sdp} ─────────────▶ mailbox(482913)
                                                              creates answer (waits ≤3 s for ICE)
   mailbox(615207) ◀──────────────────── answer{from, sid, sdp}
   applies answer
   ════════════════ direct WebRTC connection opens ═════════════════
   both release their mailboxes (codes are single-use)
```

Rules each browser enforces:

- An `offer` is accepted only from the code this device asked to connect to, or the one it accepted. An `answer` is accepted only if its `sid` matches the offer this device sent.
- **Mutual typing.** If a requester receives a `request` from the very code it is requesting, both sides have consented. The device with the **lower** code sends the offer straight away, and the other answers it.
- **Busy.** If the device isn't idle or already has a pending prompt, a new `request` gets an automatic `decline`.
- **No stale offers.** The offer is created only *after* Accept. However long the owner takes, the connection details (ICE candidates, NAT mappings) are fresh.

## Offline mode

### Opening the app offline

`public/sw.js` is a service worker, registered in production builds only. The first online visit saves the page and every script and style it uses. After that, the address opens with no internet in the same browser.

- **The page** is fetched from the network first, so new deploys show up. If the network fails, or doesn't respond within 4 s, the saved copy is used.
- **`/_next/static/*`** files are content-hashed, so they're served from the cache. On every online visit the cache is refreshed, and files the new page no longer uses are deleted.
- **`/api/*`** is never cached.

iOS Safari can clear the saved copy of a site that hasn't been used for a few weeks. Adding the app to the Home Screen makes the copy last.

### Pairing without a server (QR codes)

If the pairing server can't be reached, the app switches to QR pairing on its own. You can also choose it any time with **No internet? Connect with QR codes**.

1. **Host** taps **Show my code**. The browser asks for the camera, then creates a WebRTC offer and shows it as a QR code. A small camera view sits under the code.
2. **Guest** taps **Scan a code** and scans it. The guest's browser creates an answer and shows it as a QR code.
3. **Host** points the camera, which is already running, at the guest's screen. The devices connect directly over the shared Wi-Fi or hotspot.

The QR codes don't contain a full WebRTC description (1–2 KB), only the fields that matter, packed into about 150 characters (`lib/qr-signal.ts`):

```
TLQ1~<o|a>~<session>~<mid>~<setup>~<ice-ufrag>~<ice-pwd>~<sha-256 fingerprint, base64url>~<candidates>
candidate = <h|s|r><address>_<port>       e.g. h192.168.1.20_53412
```

The other side rebuilds a minimal SDP from these fields. This keeps each QR code small enough to scan easily from a screen.

**Why two scans?** Each browser must know the other's DTLS certificate fingerprint before it will connect. The fingerprint is created randomly on each device, so with no server the only way to pass it across is the camera, once in each direction.

**Why the camera permission is requested first:** without it, browsers hide LAN addresses behind random `.local` names (or, in Safari, leave them out entirely). Once camera access is granted they share the real addresses, which offline connections need.

Online, QR pairing still uses the STUN/TURN servers, so it also works across networks.

## Receiving, saving and history

**Streaming to disk.** Incoming files are written to disk as the pieces arrive, so even very large files don't have to fit in memory (`lib/files.ts`):

| Where | When | Notes |
| --- | --- | --- |
| A folder you choose | **Choose a folder** on the transfer screen (Chrome/Edge desktop) | Files are written straight into it, and existing files are never overwritten (`photo (2).jpg`). |
| Browser storage on disk (OPFS) | Default where supported (Chrome, Edge, Firefox, Android, recent Safari) | Save them whenever you like. Kept for 7 days, then removed automatically. |
| Memory | Fallback | Only when neither of the above is available. |

The sender only marks a file *Delivered* once it has been fully written on the other side.

**Saving.** Each received file has a **Save** button. You can also tick several files and use **Save selected**, or **Save all**:

- on Chrome/Edge desktop, you pick a folder and the files are written into it;
- elsewhere, they download as one ZIP. The ZIP is assembled from the files already on disk, with no copying, because checksums are calculated while the files arrive (`lib/zip.ts`, `lib/crc32.ts`);
- if a ZIP would exceed 4 GB, they download one by one.

**History** (top-right button). Every sent and received file is listed by day, with size, the other device's code and the time. Received files kept in browser storage can be saved again, one at a time or several at once. You can delete single entries or clear everything, which also deletes the stored files. The list lives in `localStorage`, on this device only.

## File transfer protocol

The connection uses two **pre-negotiated data channels** (ids 0 and 1, ordered and reliable). The side that made the offer sends on channel 0 and receives on channel 1; the other side does the reverse. Each direction therefore has its own channel, and both people can send at once without their chunks mixing.

Each file is sent as:

```
{"t":"file","id":…,"name":…,"size":…,"mime":…}    JSON text message
<binary chunk> <binary chunk> …                  ArrayBuffers of up to 64 KB (capped by the connection's max message size)
{"t":"end","id":…}                               JSON text message
```

- **Sender.** Files queue and go one at a time. Before each chunk the sender waits if more than 4 MB is buffered, and resumes when the buffer drops below 1 MB (backpressure). Progress updates at most every 100 ms.
- **Receiver.** Collects chunks in memory. On `end` it checks that the received byte count equals `size`, builds a `Blob`, offers a **Save** link, and sends `{"t":"ack","id":…}` back on its own outgoing channel.
- **Delivered.** The sender marks a file *Delivered* only when the ack arrives.
- **Failure.** If the connection closes or fails, every queued, in-flight or unacknowledged file is marked *Failed*. If the connection drops to WebRTC's `disconnected` state and doesn't recover within 8 s, it is treated as closed.

## Security model

**The server sees:**

- mailbox ids, which are hashes of the codes, never the codes themselves
- AES-GCM ciphertext of the pairing messages
- request metadata (IP addresses, timing)

**The server never sees** file names, file contents or plaintext connection details.

**Files** travel only over the WebRTC connection, which is always DTLS-encrypted. A TURN relay, if you add one, can forward the traffic but can't read it.

**Consent.** Nobody connects without the owner tapping Accept, or both people typing each other's code. The prompt shows the requester's code so the owner can check it.

**Guessing codes.** Codes are single-use and freed on connect, and they expire after 10 minutes without polling. The API rate-limits each IP address (see below). A guessed code only produces a prompt, never a connection.

**Honest caveat.** A 6-digit code allows only a million possibilities. The encryption stops passive snooping on stored messages, but whoever runs the server could brute-force a code and read or forge pairing messages. That would let them sit in the middle of the connection setup. The Accept prompt and the visible codes make this harder to do unnoticed, but they don't make it impossible.

## Timeouts and limits

| What | Value | Where |
| --- | --- | --- |
| Code length | 6 digits | `lib/pairing.ts` |
| Code shown (countdown ring) | 10 min, then renewed automatically | `lib/pairing.ts` |
| Mailbox lifetime on the server | 10 min after the last contact | `lib/server/store.ts`, `worker/src/index.ts` |
| Fallback: give up on a code after failed polls | 8 min without a successful poll | `lib/pairing.ts` |
| Messages waiting per mailbox | 16 max | `lib/server/store.ts` |
| Max message size | 32 KB | `app/api/signal/route.ts`, `worker/src/index.ts` |
| Poll interval (fallback only) | 1.2 s visible, 3.6 s hidden | `lib/pairing.ts` |
| WebSocket keep-alive | ping every 25 s | `lib/pairing.ts` |
| Relay file cap / monthly budget | 1024 MB / 900 GB (configurable) | `worker/wrangler.jsonc` |
| Request expiry (unanswered) | 2 min | `components/transferly-app.tsx` |
| Accept → connected timeout | 30 s | `components/transferly-app.tsx` |
| QR reply scanned → connected timeout | 45 s | `components/transferly-app.tsx` |
| ICE candidate gathering | waits up to 5 s | `lib/peer.ts` |
| Drop detection | 8 s in `disconnected` state | `lib/peer.ts` |
| Chunk size | 64 KB | `lib/peer.ts` |
| Send buffer high / low marks | 4 MB / 1 MB | `lib/peer.ts` |
| Rate limits, per IP per minute | claim 20, send 30, poll 240, release 30 | `app/api/signal/route.ts` |

## Running locally

```bash
bun install
bun run dev            # http://localhost:3000
```

Checks:

```bash
bun run lint
bun run typecheck
bun run build && bun run start
```

To try it on one machine, open the app in two isolated sessions, for example a normal window plus a private window, or two different browsers.

**Testing with a phone:** the encryption uses `crypto.subtle`, which browsers only allow on HTTPS or `localhost`. Opening `http://<your-LAN-IP>:3000` on a phone will **not** work. Use `bunx next dev --experimental-https` and accept the self-signed certificate, or an HTTPS tunnel such as cloudflared or ngrok.

## Deploying

Everything here fits in free tiers:

- **Vercel Hobby:** the site.
- **Cloudflare Workers free plan:** pairing.
- **Cloudflare Realtime TURN:** relay, 1,000 GB a month free.

### 1. Pairing server (Cloudflare Worker)

```bash
cd worker
bun install
bunx wrangler login                                  # free Cloudflare account
bunx wrangler deploy                                 # prints https://transferly.<you>.workers.dev
```

Or deploy from GitHub with **Cloudflare Workers Builds**: in the Worker's **Settings → Build**, set **Root directory** to `worker`. Without this, Cloudflare builds the Next.js site from the repo root instead of the pairing Worker. The Worker's name in the dashboard must match `name` in `worker/wrangler.jsonc` (`transferly`).

Then, in Vercel, set `NEXT_PUBLIC_SIGNAL_URL` to the Worker's URL, including `https://`, and redeploy. It's read at build time.

Check the Worker before pointing the site at it: `https://<worker>/` should return `{"ok":true}`. If it returns the Transferly page, the site got deployed there instead.

Optionally, set `ALLOWED_ORIGINS` in `worker/wrangler.jsonc` to your site's origin (e.g. `https://transferly-khaki.vercel.app`) and deploy again, so other sites can't use your Worker.

### 2. Relay (Cloudflare Realtime TURN)

In the Cloudflare dashboard, open **Realtime → TURN Server** and create a key. Then:

```bash
cd worker
bunx wrangler secret put CLOUDFLARE_TURN_KEY_ID      # paste the Turn Token ID
bunx wrangler secret put CLOUDFLARE_TURN_API_TOKEN   # paste the API token
```

### Relay guardrails (keeping it free)

| Guardrail | How |
| --- | --- |
| Relay only while pairing | `/ice` hands out relay credentials only to a device that proves it owns a live code (with its secret) and received a pairing message in the last 10 minutes. QR pairing and random callers get STUN only. |
| Short-lived credentials | Relay credentials expire after 1 hour. |
| Size cap over the relay | After connecting, each browser checks whether its route uses the relay. If so, files over `RELAY_MAX_FILE_MB` (default 1024) are refused with *Too big for a relayed connection*. Direct connections have no cap. |
| Monthly budget | Browsers report bytes they send through the relay to `/usage`. Once `RELAY_MONTHLY_GB` (default 900, under the 1,000 GB free tier) is reached, `/ice` stops offering the relay until next month. Direct connections and QR pairing keep working. |

The guardrails rely on the app reporting honestly. Someone with valid credentials could misuse them for up to an hour, so treat the budget as a safety margin, not a hard limit. Check your Cloudflare account's billing settings too.

### Fallback: pairing on Vercel only

Without `NEXT_PUBLIC_SIGNAL_URL`, the app pairs through its own `/api/signal` by polling. On Vercel this needs Upstash Redis, and the polling uses up free tiers quickly. A tab left open makes roughly one request per second.

| Variable (on Vercel) | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or any prefixed variant ending in those names | Shared mailbox storage for the fallback. |
| `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN`, `TURN_CREDENTIALS_URL`, or `TURN_URLS` + `TURN_USERNAME` + `TURN_CREDENTIAL` | Relay for the fallback's `/api/ice`. The guardrails above apply only to the Worker. |

### Notes

- Browsers always try a direct path first; the relay is only a fallback. When a connection fails, the error message lists which routes each device offered.
- The site must be served over HTTPS (Vercel does this automatically).

## Known limitations

- **Without on-disk browser storage** (some older browsers), received files fall back to memory, so very large files may be too much for those devices.
- **Some networks block direct connections.** Configure a TURN relay (see [Deploying](#deploying)).
- **Both tabs must stay open**, and ideally in the foreground on mobile, until transfers finish. Interrupted transfers don't resume.
- **Rate limiting is per server instance** and in memory. On serverless platforms, put a shared limiter (for example Upstash Ratelimit or Vercel's firewall) in front for real protection.
- **Offline pairing needs two scans and a camera on both devices.** There's no way around this without a server (see [Offline mode](#offline-mode)).
- **Once connected, files arrive without a per-file prompt.** Accepting the connection means accepting files from that device.

## Code map

| File | Responsibility |
| --- | --- |
| `app/page.tsx`, `app/layout.tsx` | Page shell and metadata. |
| `app/globals.css` | All styles, with light and dark themes through `prefers-color-scheme`. |
| `components/transferly-app.tsx` | UI and the pairing state machine (`loading → idle → requesting/connecting → connected → ended`). |
| `components/icons.tsx` | Icon re-exports from Phosphor. |
| `lib/pairing.ts` | Code generation, mailbox ids, PBKDF2 and AES-GCM, and the mailbox client. |
| `lib/peer.ts` | `PeerLink`: the WebRTC connection, the two data channels, and the file send/receive protocol. Also `loadIceServers()`. |
| `lib/files.ts` | Where received files are written (folder / OPFS / memory), and saving out (single file, folder, ZIP). |
| `lib/history.ts` | Transfer history and the 7-day cleanup. |
| `lib/zip.ts`, `lib/crc32.ts` | Zero-copy ZIP builder and incremental checksum. |
| `components/transfer-panel.tsx`, `components/history-panel.tsx`, `components/file-row.tsx` | The transfer screen, the history screen, and the shared file row. |
| `lib/qr-signal.ts` | Packs a WebRTC description into a short QR string, and back. |
| `components/qr.tsx` | QR code display and camera scanner (native `BarcodeDetector` or jsQR). |
| `app/api/ice/route.ts` | Returns STUN servers plus TURN relay credentials, when configured. |
| `worker/src/index.ts` | Cloudflare Worker: `Mailbox` Durable Object (one WebSocket per code), `Budget` Durable Object, and the `/ws`, `/send`, `/ice` and `/usage` routes. |
| `app/api/signal/route.ts` | The `claim`, `send`, `poll` and `release` actions, with validation and rate limits. |
| `lib/server/store.ts` | Mailbox storage: Upstash REST (`/multi-exec`) or an in-memory fallback. |
| `public/sw.js` | Service worker that saves the app for offline use. |
