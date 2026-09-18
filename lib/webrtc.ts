import { decodeSignal, encodeSignal, type SignalDescription } from "./signal";

export const LOCAL_RTC_CONFIGURATION: RTCConfiguration = {
  // Host candidates keep the default mode local-only and usable without internet.
  iceServers: [],
};

export function createPeerConnection() {
  // STUN is best-effort: it can improve connections across different networks when
  // internet is available, but it is never required for same-network offline use.
  const iceServers = typeof navigator !== "undefined" && navigator.onLine
    ? [{ urls: ["stun:stun.l.google.com:19302", "stun1.l.google.com:19302"] }]
    : LOCAL_RTC_CONFIGURATION.iceServers;

  return new RTCPeerConnection({ ...LOCAL_RTC_CONFIGURATION, iceServers });
}

export function waitForIceGatheringComplete(connection: RTCPeerConnection, timeoutMs = 8000) {
  if (connection.iceGatheringState === "complete") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const handleStateChange = () => {
      if (connection.iceGatheringState === "complete") finish();
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      connection.removeEventListener("icegatheringstatechange", handleStateChange);
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(finish, timeoutMs);

    connection.addEventListener("icegatheringstatechange", handleStateChange);
  });
}

export function descriptionToSignal(description: RTCSessionDescription | RTCSessionDescriptionInit) {
  if (!description.type || !description.sdp) {
    throw new Error("The browser did not create a complete WebRTC description.");
  }

  const payload: SignalDescription = {
    type: description.type,
    sdp: description.sdp,
  };

  return encodeSignal(payload);
}

export function signalToDescription(signal: string): RTCSessionDescriptionInit {
  const description = decodeSignal(signal);
  return {
    type: description.type,
    sdp: description.sdp,
  };
}
