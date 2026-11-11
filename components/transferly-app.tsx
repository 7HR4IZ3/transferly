"use client";

import { useCallback, useEffect, useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ArrowDown, ArrowUp, Check, Copy, Download, Lock, Plus, XIcon } from "./icons";
import { Mailbox, PairingError, formatCode, isValidCode, randomToken, type SignalMessage } from "../lib/pairing";
import { PeerLink, type LinkState, type Transfer } from "../lib/peer";

type Phase = "loading" | "idle" | "waiting" | "connecting" | "connected" | "ended";

const POLL_MS = 1200;
const CONNECT_TIMEOUT_MS = 30_000;

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
  const [knocked, setKnocked] = useState(false);
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);

  const mailboxRef = useRef<Mailbox | null>(null);
  const linkRef = useRef<PeerLink | null>(null);
  const phaseRef = useRef<Phase>("loading");
  const targetRef = useRef("");
  const sidRef = useRef("");
  const knocksRef = useRef(new Set<string>());
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const go = useCallback((next: Phase) => {
    phaseRef.current = next;
    setPhase(next);
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
      knocksRef.current.clear();
      setKnocked(false);
      setPeerCode("");
      setInput("");
      setError(message);
      go("idle");
    },
    [go],
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
        go("connected");
      } else if (state === "closed" || state === "failed") {
        if (phaseRef.current === "connected") {
          linkRef.current = null;
          go("ended");
        } else {
          backToIdle("Couldn't open a direct connection. Try again, ideally on the same Wi-Fi.");
        }
      }
    },
    [backToIdle, go],
  );

  const newLink = useCallback(
    (initiator: boolean) => {
      linkRef.current?.close();
      const link: PeerLink = new PeerLink(initiator, {
        onState: (state) => handleLinkState(link, state),
        onTransfer: upsertTransfer,
      });
      linkRef.current = link;
      clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        if (linkRef.current === link && !link.isOpen) {
          backToIdle("The connection timed out. Make sure both devices are online and try again.");
        }
      }, CONNECT_TIMEOUT_MS);
      return link;
    },
    [backToIdle, handleLinkState, upsertTransfer],
  );

  const sendOffer = useCallback(
    async (to: string) => {
      const from = mailboxRef.current?.code;
      if (!from) return;
      go("connecting");
      const sid = randomToken(8);
      sidRef.current = sid;
      const link = newLink(true);
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
      const link = newLink(false);
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
      const fromTarget = message.from === targetRef.current;

      if (message.kind === "hello") {
        knocksRef.current.add(message.from);
        if (fromTarget && phaseNow === "waiting") {
          // Both typed each other's code at the same time: lower code makes the offer.
          if (me < message.from) await sendOffer(message.from);
        } else if (!targetRef.current) {
          setKnocked(true);
        }
        return;
      }

      // Offers and answers are only accepted from the code this user typed in.
      if (!fromTarget) return;

      if (message.kind === "offer") {
        const link = linkRef.current;
        if (link?.initiator && me < message.from) return; // glare: keep our own offer
        if (link && !link.initiator) return; // already answering
        await answerOffer(message);
      } else if (message.kind === "answer") {
        const link = linkRef.current;
        if (!link?.initiator || message.sid !== sidRef.current) return;
        try {
          await link.acceptAnswer(message.sdp);
        } catch {
          backToIdle("The other device sent an invalid reply. Try again.");
        }
      }
    },
    [answerOffer, backToIdle, sendOffer],
  );

  const adoptMailbox = useCallback(
    (mailbox: Mailbox) => {
      mailboxRef.current = mailbox;
      setMyCode(mailbox.code);
      go("idle");
    },
    [go],
  );

  const claimFailed = useCallback(
    (err: unknown) => {
      setError(err instanceof Error ? err.message : "Couldn't get a code.");
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

  // Poll our mailbox for knocks, offers and answers until we're connected.
  useEffect(() => {
    if (!myCode) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = async () => {
      const mailbox = mailboxRef.current;
      if (stopped || !mailbox || mailbox.code !== myCode) return;
      try {
        const messages = await mailbox.poll();
        for (const message of messages) if (!stopped) await handleSignal(message);
      } catch (err) {
        if (err instanceof PairingError && err.status === 410 && !stopped && phaseRef.current !== "connected") {
          stopped = true;
          backToIdle("Your code expired, so here is a new one.");
          claimCode();
          return;
        }
      }
      if (!stopped) timer = setTimeout(tick, document.hidden ? POLL_MS * 3 : POLL_MS);
    };
    void tick();

    return () => {
      stopped = true;
      clearTimeout(timer);
    };
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
      setError("");
      targetRef.current = code;
      setPeerCode(code);

      if (knocksRef.current.has(code)) {
        await sendOffer(code);
        return;
      }

      go("waiting");
      try {
        await Mailbox.send(code, { kind: "hello", from: me });
      } catch (err) {
        if (targetRef.current === code) backToIdle(err instanceof Error ? err.message : "Couldn't reach that code.");
      }
    },
    [backToIdle, go, sendOffer],
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
        {!paired ? (
          <>
            <div className="block">
              <p className="label">Your code</p>
              <div className="my-code">
                <span className={"code" + (myCode ? "" : " code-loading")}>{myCode ? formatCode(myCode) : "··· ···"}</span>
                {myCode ? (
                  <button className="icon-button" onClick={copyCode} type="button" aria-label="Copy your code">
                    {copied ? <Check size={18} /> : <Copy size={18} />}
                  </button>
                ) : null}
              </div>
            </div>

            <div className="divider" />

            <div className="block">
              <label className="label" htmlFor="peer-code">
                Their code
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

              <Status phase={phase} peerCode={peerCode} error={error} knocked={knocked} onCancel={() => backToIdle()} />
            </div>
          </>
        ) : (
          <>
            <div className="connected-head">
              <div>
                <p className="peer">
                  <span className={"dot" + (live ? " dot-live" : "")} />
                  {live ? "Connected" : "Disconnected"}
                </p>
                <p className="muted small">{live ? "to " + formatCode(peerCode) : "The other device left."}</p>
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
  knocked,
  onCancel,
}: {
  phase: Phase;
  peerCode: string;
  error: string;
  knocked: boolean;
  onCancel: () => void;
}) {
  if (error) return <p className="status status-error">{error}</p>;
  if (phase === "waiting") {
    return (
      <p className="status">
        <span className="spinner" /> Waiting for {formatCode(peerCode)} to enter your code
        <button className="link-button" onClick={onCancel} type="button">
          Cancel
        </button>
      </p>
    );
  }
  if (phase === "connecting") {
    return (
      <p className="status">
        <span className="spinner" /> Connecting…
      </p>
    );
  }
  if (knocked) return <p className="status status-accent">Someone entered your code. Type theirs to connect.</p>;
  return <p className="status muted">Share your code, then type the code from the other device.</p>;
}

function TransferRow({ item }: { item: Transfer }) {
  const percent = item.size ? Math.round((item.bytes / item.size) * 100) : 100;
  const incoming = item.direction === "in";
  const detail =
    item.status === "failed"
      ? "Failed"
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
