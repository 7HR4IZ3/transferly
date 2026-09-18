# Transferly

Transferly is an offline-first browser file transfer tool. It uses a PWA shell and WebRTC data channels to move files directly between two browsers without uploading them to cloud storage.

## Local transfer flow

1. Open Transferly once while online so the app can be cached.
2. Put both devices on the same Wi-Fi network or phone hotspot.
3. Choose **Send files** on one device and **Receive files** on the other.
4. Exchange the offer and answer using QR codes or copy/paste.
5. Keep both transfer screens open until the files finish.

The default build uses no application server, database, account system, or file-upload endpoint. WebRTC signaling is performed manually so the local mode still works when the internet is unavailable. Internet-wide pairing and TURN relay support can be added later with an external signaling service.

## Development

```bash
npm install
npm run dev
```

Open `http://localhost:3000`. Production builds use the same client-only transfer workspace:

```bash
npm run lint
npm run build
npm run start
```

## Browser notes

- Production PWA features require HTTPS. `localhost` is allowed for development.
- Both browser tabs should remain open and visible during a transfer.
- The local-only mode requires a network path between devices, usually the same Wi-Fi or hotspot. “Offline” means no internet or cloud file storage, not no connection between the devices.
- If camera scanning is unavailable, use the copy/paste signaling fallback.
