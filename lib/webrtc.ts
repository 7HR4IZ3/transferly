import { decodeSignal, encodeSignal, type SignalDescription } from "./signal";

export const LOCAL_RTC_CONFIGURATION: RTCConfiguration = {
  // An empty ICE server list keeps the default mode local-only and usable without internet.
  iceServers: [],
};

export function createPeerConnection() {
  return new RTCPeerConnection(LOCAL_RTC_CONFIGURATION);
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
