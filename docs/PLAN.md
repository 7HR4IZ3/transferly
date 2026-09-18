# Transferly build plan

## Product goal

Transferly is an offline-first browser application for sending files directly from one browser to another. It should not upload files to cloud storage or require accounts.

The first release prioritizes a local-network/offline workflow:

`sender browser -> WebRTC data channel -> receiver browser`

The app itself is installable and cached as a PWA so it can be opened after the initial online visit. The transfer path is direct and uses no signaling backend by default.

## User experience

1. A user opens Transferly and chooses **Send files** or **Receive files**.
2. The sender selects or drops one or more files.
3. Transferly creates a local WebRTC offer.
4. The offer is shown as a QR code sequence, with copy/paste available as a fallback.
5. The receiver scans or pastes the offer.
6. The receiver creates an answer and shows it as a QR code sequence.
7. The sender scans or pastes the answer.
8. The peers connect directly and the sender sees per-file progress.
9. The receiver can download each completed file.

The UI will clearly explain that the devices need to be on the same Wi-Fi network or hotspot for a truly offline transfer. Internet-wide automatic pairing and TURN relaying are intentionally not part of this first release because they require a signaling/storage service and may relay traffic through a server.

## Architecture

- Next.js App Router with a client-side transfer workspace.
- Manual PWA service worker in `public/sw.js`.
- Web App Manifest and app icons.
- WebRTC `RTCPeerConnection` with `RTCDataChannel`.
- No application database, authentication, file upload API, or cloud storage.
- QR generation and camera scanning for offline signaling.
- LocalStorage for non-sensitive UI preferences only; received transfer data remains in memory until downloaded.
- Binary file chunks with metadata envelopes and sender backpressure.
- A reliable ordered data channel for file integrity.
- Optional ICE server configuration can be added later without changing the transfer protocol.

## Transfer protocol

- Session signals are encoded as compact URL-safe strings.
- Large signals are split into numbered QR frames and reassembled by the scanner.
- The data channel sends:
  - session metadata,
  - file metadata,
  - binary chunks,
  - file completion markers,
  - cancellation/error messages.
- File chunks are kept below browser data-channel message limits.
- Sender pauses when the outbound data-channel buffer is high and resumes on `bufferedamountlow`.
- Receiver tracks bytes and validates the expected file size before enabling download.
- A fallback copy/paste path remains available when camera access is unavailable.

## Offline and browser constraints

- The first visit must happen while online so the app and service worker can be cached.
- Service workers require HTTPS in production; localhost is supported for development.
- Both transfer pages should remain open and visible during a transfer, especially on mobile browsers.
- Browser storage and large-file limits vary, so the first release will provide clear progress and failure states rather than pretending transfers are resumable after a tab is closed.
- iOS/Safari and desktop Chromium/Firefox will be treated as first-class test targets.

## Milestones

### Milestone 1 — Foundation

- Scaffold Next.js project.
- Add responsive visual system and landing/workspace UI.
- Add manifest, service worker, icons, offline status, and install prompt.

### Milestone 2 — Local transfer

- Implement WebRTC offer/answer lifecycle.
- Implement QR frame generation and scanning.
- Implement copy/paste signaling fallback.
- Implement file selection, drag/drop, metadata, chunked sending, backpressure, and progress.

### Milestone 3 — Receiver experience

- Implement incoming transfer states.
- Add completed-file download cards.
- Add cancellation, disconnect, and retry guidance.
- Add multi-file queue behavior.

### Milestone 4 — Verification and deployment

- Run lint/type/build checks.
- Test sender/receiver in two browser contexts.
- Commit the implementation to GitHub.
- Deploy the production app to Vercel.
- Verify the deployed PWA shell and report browser/network limitations.

## Future phases

- Automatic room-code signaling through a small realtime service.
- STUN/TURN configuration for internet-wide transfers.
- Resumable transfers backed by OPFS/IndexedDB.
- Optional end-to-end application-level encryption and peer verification.
- Transfer history and explicit storage management.
