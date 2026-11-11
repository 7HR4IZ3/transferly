"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Download, Lock, Plus, QrIcon, XIcon } from "./icons";
import { QrCode, QrScanner } from "./qr";
import { Mailbox, PairingError, formatCode, isValidCode, randomToken, reportRelayUsage, type SignalMessage } from "../lib/pairing";
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

function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + units[unit];
}

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
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);

  const mailboxRef = useRef<Mailbox | null>(null);
  const linkRef = useRef<PeerLink | null>(null);
  const phaseRef = useRef<Phase>("loading");
  const targetRef = useRef("");
  const sidRef = useRef("");
  const requestRef = useRef<string | null>(null);
  const qrStepRef = useRef<QrStep | null>(null);
  const relayUnavailableRef = useRef<string | undefined>(undefined);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      setRoute(null);
      setRelayMaxBytes(ice.relayMaxBytes);
      const link: PeerLink = new PeerLink(
        initiator,
        {
          onState: (state) => handleLinkState(link, state),
          onTransfer: upsertTransfer,
          onRoute: (next) => linkRef.current === link && setRoute(next),
          onRelayUsage: reportRelayUsage,
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
      setMyCode(mailbox.code);
      go("idle");
    },
    [go],
  );

  const claimFailed = useCallback(
    (err: unknown) => {
      // No server reachable: switch to offline QR pairing instead of showing an error.
      if (err instanceof PairingError && (err.status === 0 || err.status >= 500)) setOffline(true);
      else setError(err instanceof Error ? err.message : "Couldn't get a code.");
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

  // Claim a code on first load and release it when the page goes away.
  useEffect(() => {
    let cancelled = false;
    Mailbox.claim().then(
      (mailbox) => (cancelled ? mailbox.release() : adoptMailbox(mailbox)),
      (err) => !cancelled && claimFailed(err),
    );
    const release = () => {
      mailboxRef.current?.release();
      linkRef.current?.close();
    };
    // A page restored from the back/forward cache has a released code: start fresh.
    const restore = (event: PageTransitionEvent) => event.persisted && window.location.reload();
    window.addEventListener("pagehide", release);
    window.addEventListener("pageshow", restore);
    return () => {
      cancelled = true;
      window.removeEventListener("pagehide", release);
      window.removeEventListener("pageshow", restore);
      release();
      mailboxRef.current = null;
    };
  }, [adoptMailbox, claimFailed]);

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

  const sendFiles = (list: FileList | null) => {
    if (list?.length && linkRef.current?.isOpen) linkRef.current.send(Array.from(list));
  };

  const startOver = () => {
    linkRef.current?.close();
    linkRef.current = null;
    setTransfers((current) => {
      current.forEach((item) => item.url && URL.revokeObjectURL(item.url));
      return [];
    });
    backToIdle();
    claimCode();
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    sendFiles(event.dataTransfer.files);
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
      </header>

      <section className="card" aria-live="polite">
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
              <p className="label">Share your code</p>
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
                <input
                  id="peer-code"
                  autoComplete="one-time-code"
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
          <>
            <div className="connected-head">
              <div>
                <p className="peer">
                  <span className={"dot" + (live ? " dot-live" : "")} />
                  {live ? "Connected" : "Disconnected"}
                </p>
                <p className="muted small">
                  {!live
                    ? "The other device left."
                    : (peerCode ? "to " + formatCode(peerCode) : "by QR code") +
                      (route === "relay" ? " · through a relay" : route === "direct" ? " · direct" : "")}
                </p>
              </div>
              <button className="ghost-button" onClick={startOver} type="button">
                {live ? "Disconnect" : "New connection"}
              </button>
            </div>

            {live ? (
              <div
                className={"drop" + (dragging ? " drop-active" : "")}
                onClick={() => fileInputRef.current?.click()}
                onDragEnter={(event) => {
                  event.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={onDrop}
                onKeyDown={(event) => (event.key === "Enter" || event.key === " ") && fileInputRef.current?.click()}
                role="button"
                tabIndex={0}
              >
                <span className="drop-icon">
                  <Plus size={20} />
                </span>
                <span>
                  <strong>Drop files</strong> or click to choose
                </span>
                <input
                  hidden
                  multiple
                  onChange={(event) => {
                    sendFiles(event.target.files);
                    event.target.value = "";
                  }}
                  ref={fileInputRef}
                  type="file"
                />
              </div>
            ) : null}

            {live && route === "relay" ? (
              <p className="muted small center relay-note">
                Your networks couldn&apos;t connect directly, so this goes through a free relay. Files up to{" "}
                {formatBytes(relayMaxBytes)} can be sent. Use the same Wi-Fi for bigger files.
              </p>
            ) : null}

            {transfers.length ? (
              <ul className="transfers">
                {transfers.map((item) => (
                  <TransferRow item={item} key={item.direction + item.id} />
                ))}
              </ul>
            ) : live ? (
              <p className="muted small center">Files you send or receive will appear here.</p>
            ) : null}
          </>
        )}
      </section>

      <footer className="foot">
        <Lock size={13} /> Files go directly between browsers, encrypted. Nothing is uploaded.
      </footer>
    </main>
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

function TransferRow({ item }: { item: Transfer }) {
  const percent = item.size ? Math.round((item.bytes / item.size) * 100) : 100;
  const incoming = item.direction === "in";
  const detail =
    item.status === "failed"
      ? item.note
        ? item.note + " · " + formatBytes(item.size)
        : "Failed"
      : item.status === "done"
        ? formatBytes(item.size) + (incoming ? "" : " · Delivered")
        : item.status === "queued"
          ? "Queued · " + formatBytes(item.size)
          : formatBytes(item.bytes) + " of " + formatBytes(item.size);

  return (
    <li className={"transfer" + (item.status === "failed" ? " transfer-failed" : "")}>
      <span className={"badge" + (incoming ? " badge-in" : "")} aria-label={incoming ? "Received" : "Sent"}>
        {incoming ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
      </span>
      <div className="transfer-body">
        <p className="transfer-name" title={item.name}>
          {item.name}
        </p>
        <p className="muted small">{detail}</p>
        {item.status === "active" ? (
          <div className="bar">
            <div className="bar-fill" style={{ width: percent + "%" }} />
          </div>
        ) : null}
      </div>
      {incoming && item.url ? (
        <a className="save" download={item.name} href={item.url}>
          <Download size={15} /> Save
        </a>
      ) : item.status === "done" ? (
        <Check className="ok" size={18} />
      ) : item.status === "failed" ? (
        <XIcon className="bad" size={18} />
      ) : (
        <span className="muted small">{percent}%</span>
      )}
    </li>
  );
}
