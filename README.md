# Transferly

Send files directly between two browsers. Each device shows a 6-digit code; the two people tell each other their codes, type them in, and the browsers connect peer-to-peer. No accounts, no links, no copy-pasting long tokens.

## How it works

1. Each browser reserves a random 6-digit code on the server (`/api/signal`).
2. Person A types B's code. A drops an encrypted "hello" in B's mailbox.
3. Person B types A's code. B sees A's hello and sends an encrypted WebRTC offer to A; A answers.
   (If both type at the same moment, the device with the lower code makes the offer.)
4. The browsers open a direct WebRTC connection. Either side can drop files and they stream
   straight to the other browser. Codes are freed as soon as the devices connect.

Both people must type the other's code. A device only accepts a connection from the code its user entered, so guessing someone's code isn't enough to connect to them.

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
