"use client";

import { useEffect, useRef, useState } from "react";
import QRCode from "qrcode";
import jsQR from "jsqr";
import { QR_PREFIX } from "../lib/qr-signal";

/** Renders text as a crisp SVG QR code (always dark-on-white so cameras can read it). */
export function QrCode({ value }: { value: string }) {
  const [svg, setSvg] = useState("");

  useEffect(() => {
    let active = true;
    QRCode.toString(value, { type: "svg", errorCorrectionLevel: "L", margin: 2, color: { dark: "#111111", light: "#ffffff" } })
      .then((markup) => active && setSvg(markup))
      .catch(() => active && setSvg(""));
    return () => {
      active = false;
    };
  }, [value]);

  return (
    <div className="qr" role="img" aria-label="Pairing QR code">
      {svg ? <div className="qr-svg" dangerouslySetInnerHTML={{ __html: svg }} /> : <span className="spinner" />}
    </div>
  );
}

type Detector = { detect: (source: CanvasImageSource) => Promise<{ rawValue: string }[]> };

/**
 * Camera QR scanner. Uses the native BarcodeDetector where available and
 * jsQR otherwise. `onResult` fires once per Transferly code; the camera stays
 * on until the component unmounts (the camera permission also lets browsers
 * share real LAN addresses, which offline pairing needs).
 */
export function QrScanner({
  onResult,
  paused,
  compact,
}: {
  onResult: (text: string) => void;
  paused?: boolean;
  compact?: boolean;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const onResultRef = useRef(onResult);
  const pausedRef = useRef(paused);
  const [message, setMessage] = useState(() =>
    typeof navigator !== "undefined" && !navigator.mediaDevices
      ? "This browser can't use the camera here (HTTPS is required)."
      : "Starting camera…",
  );

  useEffect(() => {
    onResultRef.current = onResult;
    pausedRef.current = paused;
  }, [onResult, paused]);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    const Native = (globalThis as unknown as { BarcodeDetector?: new (options: { formats: string[] }) => Detector }).BarcodeDetector;
    const detector = Native ? new Native({ formats: ["qr_code"] }) : null;
    let lastSeen = "";

    const scan = async () => {
      if (stopped) return;
      const video = videoRef.current;
      if (video && video.readyState >= 2 && !pausedRef.current) {
        let text: string | undefined;
        try {
          if (detector) {
            text = (await detector.detect(video))[0]?.rawValue;
          } else if (context) {
            const scale = Math.min(1, 720 / Math.max(video.videoWidth, video.videoHeight));
            canvas.width = Math.round(video.videoWidth * scale);
            canvas.height = Math.round(video.videoHeight * scale);
            context.drawImage(video, 0, 0, canvas.width, canvas.height);
            const image = context.getImageData(0, 0, canvas.width, canvas.height);
            text = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data;
          }
        } catch {
          // Ignore a bad frame and try the next one.
        }
        if (text && text !== lastSeen) {
          lastSeen = text;
          if (text.startsWith(QR_PREFIX)) onResultRef.current(text);
          else setMessage("That's not a Transferly code.");
        }
      }
      timer = setTimeout(scan, 150);
    };

    navigator.mediaDevices
      ?.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })
      .then((media) => {
        if (stopped) {
          media.getTracks().forEach((track) => track.stop());
          return;
        }
        stream = media;
        const video = videoRef.current;
        if (video) {
          video.srcObject = media;
          void video.play().catch(() => undefined);
        }
        setMessage("Point the camera at the code on the other device.");
        void scan();
      })
      .catch(() => setMessage("Camera unavailable. Allow camera access and try again."));

    return () => {
      stopped = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, []);

  return (
    <div className="scanner">
      <div className={"scanner-view" + (compact ? " scanner-compact" : "")}>
        <video muted playsInline ref={videoRef} />
        <span className="scanner-frame" aria-hidden />
      </div>
      {compact ? null : <p className="muted small center">{paused ? "Got it…" : message}</p>}
    </div>
  );
}
