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
- [Known limitations](#known-limitations)
- [Code map](#code-map)

## User flow

1. **Open the page on both devices.** Each one shows a code under **Share your code**, for example `482 913`.
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
 Browser A                    Next.js server                    Browser B
 ─────────                    ──────────────                    ─────────
 claim mailbox  ───────────▶  /api/signal  ◀───────────  claim mailbox
 poll every 1.2 s ◀────────▶  (mailboxes in   ◀────────▶ poll every 1.2 s
                              Redis or memory)
        encrypted request / accept / offer / answer go through the mailboxes

 ═══════════════ direct WebRTC connection (DTLS-encrypted) ═══════════════
                     files travel only on this connection
```

- **Frontend:** a single client component (`components/transferly-app.tsx`) built with Next.js App Router and React 19.
- **Signaling server:** one route, `POST /api/signal`, which stores small encrypted messages in per-device *mailboxes*. It is used only to set up the connection.
- **Storage:** Upstash Redis (or Vercel KV) when configured, otherwise an in-memory map.
- **Transport:** WebRTC data channels between the browsers. STUN (Google's public servers by default) helps devices on different networks find each other; TURN can be added for strict networks.

## Pairing protocol

### Codes and mailboxes

On load, each browser:

1. Picks a random code from `000000` to `999999` with `crypto.getRandomValues`. It uses rejection sampling, so every code is equally likely.
2. Computes `mailboxId = SHA-256("transferly/mailbox/v1:" + code)`.
3. Generates a random 128-bit `secret`.
4. Calls `claim(mailboxId, secret)`. The server creates the mailbox only if that id is free. On a clash the browser picks a new code, up to 6 tries.

The **secret is needed to read** the mailbox, so nobody else can drain it. **Anyone may write** to a mailbox if they know the code, since writing requires computing its id.

Each browser then polls its own mailbox every 1.2 s, or every 3.6 s while the tab is hidden. Each poll returns and deletes any waiting messages and resets the mailbox's 10-minute expiry. If the mailbox has vanished (for example after a server restart), the browser automatically claims a new code.

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
| Mailbox lifetime | 10 min, renewed on every poll | `lib/server/store.ts` |
| Messages waiting per mailbox | 16 max | `lib/server/store.ts` |
| Max message size | 32 KB | `app/api/signal/route.ts` |
| Poll interval | 1.2 s visible, 3.6 s hidden | `components/transferly-app.tsx` |
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
npm install
npm run dev            # http://localhost:3000
```

Checks:

```bash
npm run lint
npm run typecheck
npm run build && npm run start
```

To try it on one machine, open the app in two isolated sessions, for example a normal window plus a private window, or two different browsers.

**Testing with a phone:** the encryption uses `crypto.subtle`, which browsers only allow on HTTPS or `localhost`. Opening `http://<your-LAN-IP>:3000` on a phone will **not** work. Use `npx next dev --experimental-https` and accept the self-signed certificate, or an HTTPS tunnel such as cloudflared or ngrok.

## Deploying

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`, or `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or any prefixed variant ending in `KV_REST_API_URL` / `KV_REST_API_TOKEN` (for example `UPSTASH_REDIS_REST_KV_REST_API_URL`) | Shared mailbox storage. **Required on serverless hosts such as Vercel**, where requests from the two devices can land on different instances. Without these variables an in-memory store is used, which works only with a single server process. |
| `CLOUDFLARE_TURN_KEY_ID` + `CLOUDFLARE_TURN_API_TOKEN` | **Recommended.** Cloudflare Realtime TURN relay. `/api/ice` creates short-lived relay credentials for each browser. |
| `TURN_CREDENTIALS_URL` | Alternative: any URL that returns an `iceServers` array, e.g. Metered's `https://<app>.metered.live/api/v1/turn/credentials?apiKey=…`. |
| `TURN_URLS` + `TURN_USERNAME` + `TURN_CREDENTIAL` | Alternative: your own TURN server (e.g. coturn). Takes comma-separated `turn:`/`turns:` URLs. |

Without a TURN relay, devices on networks that block direct connections (mobile carriers, office and guest Wi-Fi, some home routers) fail with *Couldn't connect the two devices…*. The relay only forwards traffic, which stays DTLS-encrypted, so it can't read files. Browsers always try a direct path first; the relay is a fallback. When a connection fails, the browser console logs which kinds of route each side offered (`host` = local network, `srflx` = public address, `relay` = TURN).

The app must be served over HTTPS (Vercel does this automatically).

## Known limitations

- **Received files are held in memory** until saved, so multi-gigabyte files may be too much for a phone. Streaming straight to disk would fix this.
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
| `lib/qr-signal.ts` | Packs a WebRTC description into a short QR string, and back. |
| `components/qr.tsx` | QR code display and camera scanner (native `BarcodeDetector` or jsQR). |
| `app/api/ice/route.ts` | Returns STUN servers plus TURN relay credentials, when configured. |
| `app/api/signal/route.ts` | The `claim`, `send`, `poll` and `release` actions, with validation and rate limits. |
| `lib/server/store.ts` | Mailbox storage: Upstash REST (`/multi-exec`) or an in-memory fallback. |
| `public/sw.js` | Service worker that saves the app for offline use. |
