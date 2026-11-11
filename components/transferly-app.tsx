"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent } from "react";
import { ArrowDown, Check, Copy, HistoryIcon, Lock, QrIcon } from "./icons";
import { HistoryPanel } from "./history-panel";
import { TransferPanel } from "./transfer-panel";
import { canPickFolder, createSink, pickFolder, requestPersistence } from "../lib/files";
import { history } from "../lib/history";
import { QrCode, QrScanner } from "./qr";
import { CODE_LIFETIME_MS, Mailbox, PairingError, formatCode, isValidCode, randomToken, reportRelayUsage, type SignalMessage } from "../lib/pairing";
import { PeerLink, loadIceConfig, type IceConfig, type LinkState, type Route, type Transfer } from "../lib/peer";
import { packSignal, unpackSignal } from "../lib/qr-signal";

// requesting: we typed a code and are waiting for its owner to accept.
type Phase = "loading" | "idle" | "requesting" | "connecting" | "connected" | "ended";

const CONNECT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 120_000;
const QR_CONNECT_TIMEOUT_MS = 45_000;

/**
 * Offline (QR) pairing steps. The "host" shows a code; the "guest" scans it and
 * shows a reply; the host's camera is already running under its code, so the
 * host just points it at the reply.
 *   host:  preparing → show-offer (camera on) → (connecting)
 *   guest: scan-offer → show-answer → (connecting)
 * Two scans are unavoidable offline: each browser must learn the other's
 * DTLS certificate fingerprint before it will connect.
 */
type QrStep = "menu" | "preparing" | "show-offer" | "scan-offer" | "show-answer";

export default function TransferlyApp() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [myCode, setMyCode] = useState("");
  const [input, setInput] = useState("");
  const [peerCode, setPeerCode] = useState("");
  const [error, setError] = useState("");
  const [request, setRequestState] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [qrStep, setQrStepState] = useState<QrStep | null>(null);
  const [qrText, setQrText] = useState("");
  const [scanBusy, setScanBusy] = useState(false);
  const [route, setRoute] = useState<Route | null>(null);
  const [relayMaxBytes, setRelayMaxBytes] = useState(0);
  const [codeExpiresAt, setCodeExpiresAt] = useState(0);
  const [now, setNow] = useState(0);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [copied, setCopied] = useState(false);
  const [view, setView] = useState<"main" | "history">("main");
  const [folder, setFolder] = useState<FileSystemDirectoryHandle | null>(null);
  const [folderSupported, setFolderSupported] = useState(false);

  const mailboxRef = useRef<Mailbox | null>(null);
  const linkRef = useRef<PeerLink | null>(null);
  const phaseRef = useRef<Phase>("loading");
  const targetRef = useRef("");
  const sidRef = useRef("");
  const requestRef = useRef<string | null>(null);
  const qrStepRef = useRef<QrStep | null>(null);
  const relayUnavailableRef = useRef<string | undefined>(undefined);
  const relayDetailRef = useRef<string | undefined>(undefined);
  const inputRef = useRef("");
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const folderRef = useRef<FileSystemDirectoryHandle | null>(null);

  const go = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const setQrStep = useCallback((step: QrStep | null) => {
    qrStepRef.current = step;
    setQrStepState(step);
  }, []);

  /** Incoming connection request awaiting Accept / Decline. */
  const setRequest = useCallback((code: string | null) => {
    requestRef.current = code;
    setRequestState(code);
  }, []);

  const upsertTransfer = useCallback((transfer: Transfer) => {
    if (transfer.status === "done" || transfer.status === "failed") {
      history.record({
        key: transfer.direction + ":" + transfer.id,
        direction: transfer.direction,
        name: transfer.name,
        size: transfer.size,
        mime: transfer.mime,
        peer: targetRef.current || undefined,
        at: Date.now(),
        status: transfer.status,
        storage: transfer.storage,
        location: transfer.location,
        crc: transfer.crc,
      });
    }
    setTransfers((current) => {
      const index = current.findIndex((item) => item.id === transfer.id && item.direction === transfer.direction);
      if (index === -1) return [transfer, ...current];
      const next = current.slice();
      next[index] = transfer;
      return next;
    });
  }, []);

  /** Drop the current link and go back to showing our code. */
  const backToIdle = useCallback(
    (message = "") => {
      clearTimeout(timeoutRef.current);
      linkRef.current?.close();
      linkRef.current = null;
      targetRef.current = "";
      sidRef.current = "";
      setPeerCode("");
      setInput("");
      setError(message);
      // Leaving a QR flow returns to its menu so the user can try again.
      if (qrStepRef.current) setQrStep("menu");
      setQrText("");
      setScanBusy(false);
      go("idle");
    },
    [go, setQrStep],
  );

  const armTimeout = useCallback(
    (ms: number, message: string) => {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (!linkRef.current?.isOpen) backToIdle(message);
      }, ms);
    },
    [backToIdle],
  );

  const handleLinkState = useCallback(
    (link: PeerLink, state: LinkState) => {
      if (linkRef.current !== link) return;
      if (state === "open") {
        clearTimeout(timeoutRef.current);
        // Codes are single-use: free ours as soon as we're paired.
        mailboxRef.current?.release();
        mailboxRef.current = null;
        setMyCode("");
        setError("");
        setQrStep(null);
        go("connected");
      } else if (state === "closed" || state === "failed") {
        if (phaseRef.current === "connected") {
          linkRef.current = null;
          go("ended");
        } else {
          const routes = link.describeCandidates();
          console.warn("Transferly: connection failed —", routes);
          backToIdle(
            (qrStepRef.current
              ? "Couldn't connect. Make sure both devices are on the same Wi-Fi or hotspot, then try again."
              : relayUnavailableRef.current === "budget"
                ? "Couldn't connect the two devices directly, and this month's free relay allowance is used up. Try the same Wi-Fi."
                : relayUnavailableRef.current === "error"
                  ? "Couldn't connect the two devices directly, and the relay isn't working: " +
                    (relayDetailRef.current ?? "unknown error") +
                    "."
                  : "Couldn't connect the two devices. Their networks are blocking a direct connection.") +
              " (Routes: " + routes + ".)",
          );
        }
      }
    },
    [backToIdle, go, setQrStep],
  );

  const newLink = useCallback(
    (initiator: boolean, ice: IceConfig, timeoutMs: number | null = CONNECT_TIMEOUT_MS) => {
      // Detach before closing so the old link's "closed" event is ignored.
      const previous = linkRef.current;
      linkRef.current = null;
      previous?.close();
      relayUnavailableRef.current = ice.relayUnavailable;
      relayDetailRef.current = ice.relayDetail;
      setRoute(null);
      setRelayMaxBytes(ice.relayMaxBytes);
      const link: PeerLink = new PeerLink(
        initiator,
        {
          onState: (state) => handleLinkState(link, state),
          onTransfer: upsertTransfer,
          onRoute: (next) => linkRef.current === link && setRoute(next),
          onRelayUsage: reportRelayUsage,
          // Stream incoming files to disk (a chosen folder, or browser storage).
          createSink: (meta) => {
            requestPersistence();
            return createSink(meta, folderRef.current);
          },
        },
        ice,
      );
      linkRef.current = link;
      if (timeoutMs === null) clearTimeout(timeoutRef.current);
      else armTimeout(timeoutMs, "The connection timed out. Make sure both devices are online and try again.");
      return link;
    },
    [armTimeout, handleLinkState, upsertTransfer],
  );

  const sendOffer = useCallback(
    async (to: string) => {
      const from = mailboxRef.current?.code;
      if (!from) return;
      go("connecting");
      const sid = randomToken(8);
      sidRef.current = sid;
      const ice = await loadIceConfig(mailboxRef.current?.auth);
      if (phaseRef.current !== "connecting" || targetRef.current !== to) return; // cancelled meanwhile
      const link = newLink(true, ice);
      try {
        const sdp = await link.createOffer();
        if (linkRef.current !== link) return;
        await Mailbox.send(to, { kind: "offer", from, sid, sdp });
      } catch (err) {
        if (linkRef.current === link) backToIdle(err instanceof Error ? err.message : "Couldn't reach the other device.");
      }
    },
    [backToIdle, go, newLink],
  );

  const answerOffer = useCallback(
    async (message: Extract<SignalMessage, { kind: "offer" }>) => {
      const from = mailboxRef.current?.code;
      if (!from) return;
      go("connecting");
      sidRef.current = message.sid;
      const ice = await loadIceConfig(mailboxRef.current?.auth);
      if (phaseRef.current !== "connecting" || targetRef.current !== message.from) return;
      const link = newLink(false, ice);
      try {
        const sdp = await link.acceptOffer(message.sdp);
        if (linkRef.current !== link) return;
        await Mailbox.send(message.from, { kind: "answer", from, sid: message.sid, sdp });
      } catch (err) {
        if (linkRef.current === link) backToIdle(err instanceof Error ? err.message : "Couldn't reach the other device.");
      }
    },
    [backToIdle, go, newLink],
  );

  const handleSignal = useCallback(
    async (message: SignalMessage) => {
      const me = mailboxRef.current?.code;
      const phaseNow = phaseRef.current;
      if (!me || phaseNow === "connected" || phaseNow === "ended") return;
      const from = message.from;
      const fromTarget = from === targetRef.current;
      const link = linkRef.current;

      switch (message.kind) {
        case "request":
          if (phaseNow === "requesting" && fromTarget) {
            // We both typed each other's code: that's consent on both sides.
            // The lower code makes the offer; the other waits for it.
            if (me < from) await sendOffer(from);
            return;
          }
          if (phaseNow !== "idle" || qrStepRef.current || (requestRef.current && requestRef.current !== from)) {
            // Busy with someone else.
            void Mailbox.send(from, { kind: "decline", from: me }).catch(() => undefined);
            return;
          }
          setRequest(from);
          return;

        case "cancel":
          if (requestRef.current === from) setRequest(null);
          else if (fromTarget) backToIdle("The other device cancelled.");
          return;

        case "decline":
          if (fromTarget && phaseNow === "requesting") backToIdle(formatCode(from) + " declined your request.");
          return;

        case "accept":
          if (fromTarget && phaseNow === "requesting") await sendOffer(from);
          return;

        case "offer":
          // Only from a device we accepted, or one we asked to connect to.
          if (!fromTarget) return;
          if (link && !link.initiator) return; // already answering
          if (link?.initiator && me < from) return; // both offered: lower code keeps its own
          await answerOffer(message);
          return;

        case "answer":
          if (!fromTarget || !link?.initiator || message.sid !== sidRef.current) return;
          try {
            await link.acceptAnswer(message.sdp);
          } catch {
            backToIdle("The other device sent an invalid reply. Try again.");
          }
          return;
      }
    },
    [answerOffer, backToIdle, sendOffer, setRequest],
  );

  const acceptRequest = useCallback(async () => {
    const me = mailboxRef.current?.code;
    const from = requestRef.current;
    if (!me || !from) return;
    setRequest(null);
    setError("");
    targetRef.current = from;
    setPeerCode(from);
    go("connecting");
    armTimeout(CONNECT_TIMEOUT_MS, "The other device didn't finish connecting. Try again.");
    try {
      await Mailbox.send(from, { kind: "accept", from: me });
    } catch {
      if (targetRef.current === from) backToIdle("That device is no longer available.");
    }
  }, [armTimeout, backToIdle, go, setRequest]);

  const declineRequest = useCallback(() => {
    const me = mailboxRef.current?.code;
    const from = requestRef.current;
    setRequest(null);
    if (me && from) void Mailbox.send(from, { kind: "decline", from: me }).catch(() => undefined);
  }, [setRequest]);

  /** Stop an outgoing request or a half-open connection. */
  const cancelPairing = useCallback(() => {
    const me = mailboxRef.current?.code;
    const to = targetRef.current;
    if (me && to) void Mailbox.send(to, { kind: "cancel", from: me }).catch(() => undefined);
    backToIdle();
  }, [backToIdle]);

  // A request nobody answers disappears on its own.
  useEffect(() => {
    if (!request) return;
    const timer = setTimeout(() => requestRef.current === request && setRequest(null), REQUEST_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [request, setRequest]);

  const adoptMailbox = useCallback(
    (mailbox: Mailbox) => {
      mailboxRef.current = mailbox;
      setOffline(false);
      setCodeExpiresAt(mailbox.expiresAt);
      setNow(Date.now());
      setMyCode(mailbox.code);
      go("idle");
    },
    [go],
  );

  const claimFailed = useCallback(
    (err: unknown) => {
      // No server reachable: switch to offline QR pairing instead of showing an error.
      if (err instanceof PairingError && (err.status === 0 || err.status >= 500)) {
        setOffline(true);
        // Online but the pairing server failed: say so, so a misconfiguration isn't mistaken for no internet.
        if (navigator.onLine) {
          setError(
            err.status === 0
              ? "Couldn't reach the pairing server, so you can only connect with QR codes right now."
              : err.message,
          );
        }
      } else setError(err instanceof Error ? err.message : "Couldn't get a code.");
      go("idle");
    },
    [go],
  );

  /** Reserve a fresh 6-digit code. */
  const claimCode = useCallback(() => {
    go("loading");
    setError("");
    Mailbox.claim().then(adoptMailbox, claimFailed);
  }, [adoptMailbox, claimFailed, go]);

  // Claim a code on first load.
  //
  // The code is deliberately NOT released on "pagehide": phones fire it when you
  // merely switch apps (e.g. to send someone the code), which used to leave a
  // dead code on screen. A closed tab's code simply expires on the server.
  useEffect(() => {
    let cancelled = false;
    Mailbox.claim().then(
      (mailbox) => (cancelled ? mailbox.release() : adoptMailbox(mailbox)),
      (err) => !cancelled && claimFailed(err),
    );
    return () => {
      cancelled = true;
      mailboxRef.current?.release();
      linkRef.current?.close();
      mailboxRef.current = null;
    };
  }, [adoptMailbox, claimFailed]);

  useEffect(() => {
    inputRef.current = input;
  }, [input]);

  /** Swap the shown code for a fresh one. */
  const renewCode = useCallback(() => {
    const old = mailboxRef.current;
    mailboxRef.current = null;
    setMyCode("");
    old?.release();
    claimCode();
  }, [claimCode]);

  // Tick the expiry ring, and renew the code when it runs out — but never in the
  // middle of something (typing a code, an incoming request, pairing).
  useEffect(() => {
    if (!myCode) return;
    const timer = setInterval(() => {
      const time = Date.now();
      setNow(time);
      const mailbox = mailboxRef.current;
      const quiet = phaseRef.current === "idle" && !requestRef.current && !qrStepRef.current && !inputRef.current;
      if (mailbox && time >= mailbox.expiresAt && quiet) renewCode();
    }, 1000);
    return () => clearInterval(timer);
  }, [myCode, renewCode]);

  useEffect(() => {
    void history.expire();
    // Feature detection has to wait for the browser (not available during prerender).
    const timer = setTimeout(() => setFolderSupported(canPickFolder()), 0);
    return () => clearTimeout(timer);
  }, []);

  // Cache the app for offline use (production only, so dev builds never go stale).
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  }, []);

  // Follow connectivity: offline → QR pairing; back online → get a code again.
  useEffect(() => {
    const goneOffline = () => {
      if (phaseRef.current !== "connected" && phaseRef.current !== "ended") setOffline(true);
    };
    const backOnline = () => {
      const step = qrStepRef.current;
      if (!mailboxRef.current && (phaseRef.current === "idle" || phaseRef.current === "loading") && (!step || step === "menu")) {
        claimCode();
      }
    };
    window.addEventListener("offline", goneOffline);
    window.addEventListener("online", backOnline);
    return () => {
      window.removeEventListener("offline", goneOffline);
      window.removeEventListener("online", backOnline);
    };
  }, [claimCode]);

  // ---- Offline (QR) pairing -------------------------------------------------

  /** Host: create an offer and show it as a QR code. */
  const startQrHost = useCallback(async () => {
    setError("");
    setQrStep("preparing");
    const ice = await loadIceConfig();
    // Camera permission lets browsers reveal real LAN addresses (instead of
    // hidden .local names), which offline pairing relies on. It's needed to
    // scan the reply anyway.
    const camera = await navigator.mediaDevices?.getUserMedia({ video: true }).catch(() => null);
    try {
      if (qrStepRef.current !== "preparing") return;
      const sid = randomToken(3);
      sidRef.current = sid;
      const link = newLink(true, ice, null); // no timeout while the guest scans
      const sdp = await link.createOffer();
      if (linkRef.current !== link || qrStepRef.current !== "preparing") return;
      setQrText(packSignal("offer", sid, sdp));
      setQrStep("show-offer");
    } catch (err) {
      backToIdle(err instanceof Error ? err.message : "Couldn't prepare a code.");
    } finally {
      camera?.getTracks().forEach((track) => track.stop());
    }
  }, [backToIdle, newLink, setQrStep]);

  const handleScan = useCallback(
    async (text: string) => {
      let signal;
      try {
        signal = unpackSignal(text);
      } catch (err) {
        setError(err instanceof Error ? err.message : "That code couldn't be read.");
        return;
      }
      const step = qrStepRef.current;

      if (step === "scan-offer") {
        if (signal.kind !== "offer") {
          setError("That's a reply code. Scan the first code the other device shows.");
          return;
        }
        setError("");
        setScanBusy(true);
        const ice = await loadIceConfig();
        if (qrStepRef.current !== "scan-offer") return;
        // The scanner (and camera) stays on until the answer exists; see startQrHost.
        const link = newLink(false, ice, null);
        try {
          const sdp = await link.acceptOffer(signal.sdp);
          if (linkRef.current !== link) return;
          sidRef.current = signal.sid;
          setQrText(packSignal("answer", signal.sid, sdp));
          setScanBusy(false);
          setQrStep("show-answer");
          armTimeout(QR_CONNECT_TIMEOUT_MS, "Not connected yet. Make sure the other device scanned your code and both are on the same Wi-Fi or hotspot.");
        } catch {
          backToIdle("That code couldn't be used. Try again.");
        }
      } else if (step === "show-offer") {
        const link = linkRef.current;
        if (signal.kind !== "answer") {
          setError("That's your own code type. Scan the reply the other device shows.");
          return;
        }
        if (signal.sid !== sidRef.current || !link?.initiator) {
          setError("That reply belongs to a different code. Ask them to scan your code again.");
          return;
        }
        setError("");
        setScanBusy(true);
        try {
          await link.acceptAnswer(signal.sdp);
          armTimeout(QR_CONNECT_TIMEOUT_MS, "Couldn't connect. Make sure both devices are on the same Wi-Fi or hotspot, then try again.");
        } catch {
          backToIdle("That reply couldn't be used. Try again.");
        }
      }
    },
    [armTimeout, backToIdle, newLink, setQrStep],
  );

  // Receive offers and answers for our code until we're connected (WebSocket or polling).
  useEffect(() => {
    const mailbox = mailboxRef.current;
    if (!myCode || !mailbox || mailbox.code !== myCode) return;
    let chain = Promise.resolve();
    mailbox.start({
      // One at a time, in arrival order (e.g. a request is handled before a later cancel).
      onMessage: (message) => {
        chain = chain.then(() => handleSignal(message)).catch(() => undefined);
      },
      onLost: () => {
        if (mailboxRef.current !== mailbox || phaseRef.current === "connected" || phaseRef.current === "ended") return;
        mailboxRef.current = null;
        backToIdle("Your code expired, so here is a new one.");
        claimCode();
      },
    });
    return () => mailbox.stop();
  }, [backToIdle, claimCode, handleSignal, myCode]);

  // Focus the code field once it's usable (desktop only, so phones don't pop a keyboard).
  const codeInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (phase === "idle" && myCode && window.matchMedia("(pointer: fine)").matches) codeInputRef.current?.focus();
  }, [phase, myCode]);

  const connectTo = useCallback(
    async (code: string) => {
      const me = mailboxRef.current?.code;
      if (!me || phaseRef.current !== "idle") return;
      if (code === me) {
        setError("That's your own code. Enter the code shown on the other device.");
        return;
      }
      if (requestRef.current === code) {
        // They already asked to connect to us; typing their code means yes.
        await acceptRequest();
        return;
      }
      setError("");
      targetRef.current = code;
      setPeerCode(code);
      go("requesting");
      armTimeout(REQUEST_TIMEOUT_MS, "No answer from " + formatCode(code) + ". Try again.");
      try {
        await Mailbox.send(code, { kind: "request", from: me });
      } catch (err) {
        if (targetRef.current === code) backToIdle(err instanceof Error ? err.message : "Couldn't reach that code.");
      }
    },
    [acceptRequest, armTimeout, backToIdle, go],
  );

  const handleInput = (event: ChangeEvent<HTMLInputElement>) => {
    const digits = event.target.value.replace(/\D/g, "").slice(0, 6);
    setInput(digits);
    if (error) setError("");
    if (isValidCode(digits)) void connectTo(digits);
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(myCode);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access is optional; the code is visible anyway.
    }
  };

  const sendFiles = (files: File[]) => {
    if (files.length && linkRef.current?.isOpen) linkRef.current.send(files);
  };

  const chooseFolder = async () => {
    const handle = await pickFolder();
    if (!handle) return;
    folderRef.current = handle;
    setFolder(handle);
  };

  const clearFolder = () => {
    folderRef.current = null;
    setFolder(null);
  };

  const startOver = () => {
    linkRef.current?.close();
    linkRef.current = null;
    setTransfers([]);
    backToIdle();
    claimCode();
  };



  const live = phase === "connected";
  const paired = phase === "connected" || phase === "ended";

  return (
    <main className="shell">
      <header className="top">
        <span className="brand">
          <span className="brand-mark" aria-hidden />
          transferly
        </span>
        <button className="ghost-button header-button" onClick={() => setView(view === "history" ? "main" : "history")} type="button">
          <HistoryIcon size={15} /> {view === "history" ? "Close history" : "History"}
        </button>
      </header>

      <section className={"card" + (paired || view === "history" ? " card-wide" : "")} aria-live="polite">
        {view === "history" ? <HistoryPanel onBack={() => setView("main")} /> : null}
        <div hidden={view === "history"}>
        {!paired && request && phase === "idle" ? (
          <div className="request">
            <span className="request-icon">
              <ArrowDown size={20} />
            </span>
            <p className="request-title">
              <span className="request-code">{formatCode(request)}</span> wants to connect
            </p>
            <p className="muted small">Only accept if you recognise this code from the other device.</p>
            <div className="request-actions">
              <button className="ghost-button" onClick={declineRequest} type="button">
                Decline
              </button>
              <button className="primary-button" onClick={() => void acceptRequest()} type="button">
                Accept
              </button>
            </div>
          </div>
        ) : !paired && qrStep && qrStep !== "menu" ? (
          <div className="qr-panel">
            {qrStep === "preparing" ? (
              <>
                <span className="spinner spinner-lg" />
                <p className="request-title">Getting ready…</p>
                <p className="muted small">Allow camera access when asked. You&apos;ll use it to scan their reply.</p>
              </>
            ) : qrStep === "show-offer" ? (
              <>
                <p className="request-title">Scan this on the other device</p>
                <QrCode value={qrText} />
                <p className="muted small">
                  They tap <strong>Scan a code</strong>, then show you a code back. Point your camera at it:
                </p>
                <QrScanner compact onResult={(text) => void handleScan(text)} paused={scanBusy} />
                {scanBusy ? (
                  <p className="status">
                    <span className="spinner" /> Connecting…
                  </p>
                ) : null}
              </>
            ) : qrStep === "scan-offer" ? (
              <>
                <p className="request-title">Scan the other device&apos;s code</p>
                <QrScanner onResult={(text) => void handleScan(text)} paused={scanBusy} />
              </>
            ) : (
              <>
                <p className="request-title">Now show this back to them</p>
                <QrCode value={qrText} />
                <p className="status">
                  <span className="spinner" /> You&apos;ll connect as soon as they scan it
                </p>
              </>
            )}
            {error ? <p className="status status-error">{error}</p> : null}
            <button className="link-button" onClick={() => backToIdle()} type="button">
              Cancel
            </button>
          </div>
        ) : !paired && (qrStep === "menu" || (offline && !myCode)) ? (
          <div className="qr-panel">
            {offline ? (
              <p className="offline-badge">
                <span className="dot" /> Offline
              </p>
            ) : null}
            <span className="request-icon">
              <QrIcon size={22} />
            </span>
            <p className="request-title">Connect with QR codes</p>
            <p className="muted small">
              Works without internet. Put both devices on the same Wi-Fi or phone hotspot. One shows a code, the other scans it, then you
              swap.
            </p>
            <div className="request-actions">
              <button
                className="ghost-button"
                onClick={() => {
                  setError("");
                  setQrStep("scan-offer");
                }}
                type="button"
              >
                Scan a code
              </button>
              <button className="primary-button" onClick={() => void startQrHost()} type="button">
                Show my code
              </button>
            </div>
            {error ? <p className="status status-error">{error}</p> : null}
            {!offline ? (
              <button
                className="link-button"
                onClick={() => {
                  setError("");
                  setQrStep(null);
                }}
                type="button"
              >
                Use a 6-digit code instead
              </button>
            ) : null}
          </div>
        ) : !paired ? (
          <>
            <div className="block">
              <div className="code-head">
                <p className="label">Share your code</p>
                {myCode && codeExpiresAt ? (
                  <ExpiryRing onRenew={renewCode} remaining={codeExpiresAt - now} total={CODE_LIFETIME_MS} />
                ) : null}
              </div>
              <div className="my-code">
                <span className={"code" + (myCode ? "" : " code-loading")}>{myCode ? formatCode(myCode) : "··· ···"}</span>
                {myCode ? (
                  <button className="icon-button" onClick={copyCode} type="button" aria-label="Copy your code">
                    {copied ? <Check size={18} /> : <Copy size={18} />}
                  </button>
                ) : null}
              </div>
            </div>

            <div className="divider">
              <span>or</span>
            </div>

            <div className="block">
              <label className="label" htmlFor="peer-code">
                Enter a code
              </label>
              <div className={"otp" + (phase !== "idle" ? " otp-locked" : "")}>
                {/* Not a login/2FA field: keep browsers and password managers from offering autofill. */}
                <input
                  id="peer-code"
                  name="transferly-peer-code"
                  type="text"
                  autoComplete="off"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  data-1p-ignore=""
                  data-lpignore="true"
                  data-bwignore=""
                  data-form-type="other"
                  disabled={phase !== "idle" || !myCode}
                  inputMode="numeric"
                  maxLength={6}
                  onChange={handleInput}
                  pattern="\d*"
                  ref={codeInputRef}
                  value={phase === "idle" ? input : peerCode}
                />
                <div className="otp-cells" aria-hidden>
                  {Array.from({ length: 6 }, (_, index) => {
                    const value = (phase === "idle" ? input : peerCode)[index] ?? "";
                    const active = phase === "idle" && index === Math.min(input.length, 5);
                    return (
                      <span className={"cell" + (active ? " cell-active" : "") + (value ? " cell-filled" : "")} key={index}>
                        {value}
                      </span>
                    );
                  })}
                </div>
              </div>

              <Status phase={phase} peerCode={peerCode} error={error} onCancel={cancelPairing} />
            </div>

            {phase === "idle" || phase === "loading" ? (
              <button
                className="link-button qr-link"
                onClick={() => {
                  setError("");
                  setQrStep("menu");
                }}
                type="button"
              >
                <QrIcon size={15} /> No internet? Connect with QR codes
              </button>
            ) : null}
          </>
        ) : (
          <TransferPanel
            canPickFolder={folderSupported}
            folderName={folder?.name ?? null}
            live={live}
            onClearFolder={clearFolder}
            onLeave={startOver}
            onPickFolder={() => void chooseFolder()}
            onSend={sendFiles}
            peerLabel={peerCode ? "to " + formatCode(peerCode) : "by QR code"}
            relayMaxBytes={relayMaxBytes}
            route={route}
            transfers={transfers}
          />
        )}
        </div>
      </section>

      <footer className="foot">
        <Lock size={13} /> Files go directly between browsers, encrypted. Nothing is uploaded.
      </footer>
    </main>
  );
}

/** Countdown ring showing how long the current code stays valid. */
function ExpiryRing({ remaining, total, onRenew }: { remaining: number; total: number; onRenew: () => void }) {
  const left = Math.max(0, remaining);
  const seconds = Math.ceil(left / 1000);
  const label = Math.floor(seconds / 60) + ":" + String(seconds % 60).padStart(2, "0");
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const fraction = Math.min(1, left / total);

  return (
    <button
      aria-label={"Code expires in " + label + ". Tap for a new code now."}
      className={"expiry" + (left < 60_000 ? " expiry-low" : "")}
      onClick={onRenew}
      title="Codes renew automatically. Tap for a new one now."
      type="button"
    >
      <svg aria-hidden height="18" viewBox="0 0 18 18" width="18">
        <circle className="expiry-track" cx="9" cy="9" r={radius} />
        <circle
          className="expiry-fill"
          cx="9"
          cy="9"
          r={radius}
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span>{left > 0 ? label : "Renewing…"}</span>
    </button>
  );
}

function Status({
  phase,
  peerCode,
  error,
  onCancel,
}: {
  phase: Phase;
  peerCode: string;
  error: string;
  onCancel: () => void;
}) {
  if (error) return <p className="status status-error">{error}</p>;
  if (phase === "requesting") {
    return (
      <p className="status">
        <span className="spinner" /> Waiting for {formatCode(peerCode)} to accept
        <button className="link-button" onClick={onCancel} type="button">
          Cancel
        </button>
      </p>
    );
  }
  if (phase === "connecting") {
    return (
      <p className="status">
        <span className="spinner" /> Connecting to {formatCode(peerCode)}…
        <button className="link-button" onClick={onCancel} type="button">
          Cancel
        </button>
      </p>
    );
  }
  return <p className="status muted">Only one of you needs to type a code. The other just taps Accept.</p>;
}
