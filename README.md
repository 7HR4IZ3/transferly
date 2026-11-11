# Transferly

Send files directly between two browsers. One person reads out their 6-digit code, the other types it in, the code's owner taps **Accept**, and the two browsers connect peer-to-peer. No accounts, no links, no copy-pasting long tokens.

## How it works

1. Each browser reserves a random 6-digit code on the server (`/api/signal`) and shows it.
2. Person B types A's code. B's browser sends an encrypted connection request, carrying B's
   own code, to A's mailbox.
3. A sees "**482 913 wants to connect**" with **Accept** / **Decline**. A can check that code
   against the one on B's screen.
4. On Accept, B's browser creates a fresh WebRTC offer, A's browser answers, and the devices
   connect directly. Either side can then drop files. Both codes are freed once connected.

More details:

- If both people type each other's code, that counts as consent on both sides, so they connect without a prompt. The device with the lower code makes the offer.
- Decline tells the requester straight away. The requester can cancel while waiting.
- Unanswered requests expire after 2 minutes. A device busy with one request automatically declines others.
- The WebRTC offer is created only after Accept, so network details aren't stale however long the owner takes to answer.

### What the server sees

- Mailbox ids: `SHA-256(code)`, never the code itself.
- Ciphertext: offers and answers are AES-GCM encrypted with a key derived from the recipient's code (PBKDF2).
- Never any file data. Files travel only over the DTLS-encrypted WebRTC data channel.

Mailboxes expire after 10 minutes of inactivity and hold at most 16 messages.

> A 6-digit code is short. Encryption stops casual snooping on stored messages, but someone running the server could brute-force the code. The guarantee that matters is that file data never touches the server.

## Running it

```bash
npm install
npm run dev        # http://localhost:3000
```

```bash
npm run lint
npm run typecheck
npm run build && npm run start
```

### Configuration

| Variable | Purpose |
| --- | --- |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` (or Vercel KV's `KV_REST_API_URL`, `KV_REST_API_TOKEN`) | Shared mailbox storage. **Required on serverless hosts such as Vercel**, where requests can land on different instances. Without them an in-memory store is used, which only works with a single server process. |
| `NEXT_PUBLIC_ICE_SERVERS` | Optional JSON array of `RTCIceServer`s, for example to add a TURN server. Defaults to Google's public STUN servers. |

### Connectivity notes

- Devices on the same network, or on most home and mobile networks, connect directly using STUN.
- Some corporate or carrier networks (symmetric NAT) block direct connections. Add a TURN server through `NEXT_PUBLIC_ICE_SERVERS` to relay traffic in those cases. A TURN relay still can't read the files: they stay DTLS-encrypted.
- Keep both tabs open until transfers finish. Received files are held in memory until you save them.

## Code map

- `app/api/signal/route.ts`: mailbox API (claim, send, poll, release) with basic rate limits.
- `lib/server/store.ts`: Upstash Redis store, with an in-memory fallback.
- `lib/pairing.ts`: code generation, hashing, encryption and mailbox client.
- `lib/peer.ts`: WebRTC link, with one data channel per direction and a chunked file protocol with backpressure.
- `components/transferly-app.tsx`: the UI.
