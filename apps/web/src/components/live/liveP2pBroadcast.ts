import type { RealtimeChannel } from "@supabase/supabase-js";
import { createBrowserClient } from "@/lib/supabase/client";

const EVENT = "webrtc";

/**
 * ICE servers: STUN + optional TURN.
 * Set NEXT_PUBLIC_TURN_URL / USERNAME / CREDENTIAL to use your own TURN server.
 * Without TURN, Chrome↔Safari on localhost will NOT work because:
 *   - Chrome emits mDNS (.local) host candidates that Safari cannot resolve.
 *   - Chrome does NOT emit loopback (127.0.0.1) candidates.
 *   - STUN reflexive addresses are the same WAN IP, so pairs fail on loopback.
 * Run `scripts/coturn.sh` for a local TURN and set NEXT_PUBLIC_ICE_RELAY_ONLY=1 in .env.local.
 */
function buildIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [
    { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  ];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  const turnUser = process.env.NEXT_PUBLIC_TURN_USERNAME;
  const turnCred = process.env.NEXT_PUBLIC_TURN_CREDENTIAL;
  if (turnUrl && turnUser && turnCred) {
    servers.push({ urls: [turnUrl], username: turnUser, credential: turnCred });
  }
  return servers;
}

function buildIceConfig(): RTCConfiguration {
  return {
    iceServers: buildIceServers(),
    bundlePolicy: "max-bundle",
    rtcpMuxPolicy: "require",
    iceTransportPolicy:
      process.env.NEXT_PUBLIC_ICE_RELAY_ONLY === "1" ? "relay" : "all",
  };
}

export function webrtcChannelName(liveSessionId: string) {
  return `live-webrtc:${liveSessionId}`;
}

/**
 * Signaling messages — all ICE is embedded in SDP (gather-complete approach).
 * No separate ice-* messages needed; this avoids ordering issues on Supabase Realtime.
 */
type SignalPayload =
  | { type: "viewer-ready" }
  | { type: "offer"; sdp: string }
  | { type: "answer"; sdp: string };

function parseSignalPayload(raw: unknown): SignalPayload | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const inner = o.payload;
  if (inner && typeof inner === "object" && "type" in inner) {
    return inner as SignalPayload;
  }
  if ("type" in o) return o as SignalPayload;
  return null;
}

function waitSubscribed(ch: RealtimeChannel) {
  return new Promise<void>((resolve, reject) => {
    ch.subscribe((status, err) => {
      if (status === "SUBSCRIBED") resolve();
      else if (status === "CHANNEL_ERROR")
        reject(err ?? new Error("Realtime channel error"));
      else if (status === "TIMED_OUT") reject(new Error("Realtime subscribe timed out"));
    });
  });
}

/**
 * Wait for ICE gathering to finish (all candidates collected, including TURN relay).
 * Falls back after `timeoutMs` so we never stall indefinitely.
 */
function waitForGatheringComplete(pc: RTCPeerConnection, timeoutMs = 6000): Promise<void> {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") {
      resolve();
      return;
    }
    const done = () => { clearTimeout(timer); resolve(); };
    const onchange = () => { if (pc.iceGatheringState === "complete") done(); };
    pc.addEventListener("icegatheringstatechange", onchange);
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onchange);
      resolve();
    }, timeoutMs);
  });
}

/**
 * Broadcaster: publishes camera/mic to viewers that signal readiness.
 * Uses gather-complete signaling: waits for all ICE candidates to be gathered
 * before sending the offer, so the SDP is self-contained (no trickle-ICE).
 */
export async function startBroadcasterP2p(
  liveSessionId: string,
  stream: MediaStream,
  onDebug?: (line: string) => void,
): Promise<() => void> {
  const debug = (line: string) => {
    onDebug?.(line);
    if (typeof window !== "undefined") console.log("[camtok-broadcast]", line);
  };

  const iceConfig = buildIceConfig();
  debug(
    `ICE policy=${iceConfig.iceTransportPolicy ?? "all"} servers=${iceConfig.iceServers?.length ?? 0}`,
  );

  const supabase = createBrowserClient();
  const ch = supabase.channel(webrtcChannelName(liveSessionId), {
    config: { broadcast: { ack: false } },
  });

  let pc: RTCPeerConnection | null = null;
  let offerRetryTimer: ReturnType<typeof setInterval> | null = null;
  let lastOffer: string | null = null;
  // Block new viewer-ready only while actively gathering (TURN alloc in progress).
  // After offer is sent, always allow fresh offer on next viewer-ready (stale allocs).
  let isGathering = false;

  const send = (payload: SignalPayload) => {
    void ch.send({ type: "broadcast", event: EVENT, payload });
  };

  const clearRetry = () => {
    if (offerRetryTimer) { clearInterval(offerRetryTimer); offerRetryTimer = null; }
    lastOffer = null;
  };

  const closePc = () => {
    if (pc && pc.signalingState !== "closed") { pc.close(); pc = null; }
  };

  const ensurePc = () => {
    if (pc && pc.signalingState !== "closed") return pc;
    pc = new RTCPeerConnection(iceConfig);
    stream.getTracks().forEach((t) => pc!.addTrack(t, stream));
    pc.onicegatheringstatechange = () => debug(`gather=${pc!.iceGatheringState}`);
    pc.oniceconnectionstatechange = () => debug(`ice=${pc!.iceConnectionState}`);
    pc.onconnectionstatechange = () => debug(`pc=${pc!.connectionState}`);
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        const c = e.candidate;
        debug(`cand type=${(c as unknown as { type?: string }).type ?? "?"} proto=${c.protocol}`);
      }
    };
    return pc;
  };

  const sendOffer = async () => {
    if (isGathering) {
      debug("gathering in progress — viewer-ready ignored");
      return;
    }
    // Always start fresh: viewer reconnected or connection failed.
    clearRetry();
    closePc();
    isGathering = true;
    lastOffer = null;
    try {
      const p = ensurePc();
      const offer = await p.createOffer();
      await p.setLocalDescription(offer);
      debug("gathering…");
      await waitForGatheringComplete(p);
      const sdp = p.localDescription?.sdp ?? offer.sdp ?? "";
      lastOffer = sdp;
      debug(`send offer (${sdp.length}b)`);
      send({ type: "offer", sdp });

      let repeats = 0;
      offerRetryTimer = setInterval(() => {
        if (repeats >= 8 || !lastOffer || (pc && pc.signalingState === "stable")) {
          clearRetry();
          return;
        }
        repeats += 1;
        debug(`retry offer #${repeats}`);
        send({ type: "offer", sdp: lastOffer });
      }, 2000);
    } finally {
      isGathering = false;
    }
  };

  ch.on("broadcast", { event: EVENT }, async (raw) => {
    const msg = parseSignalPayload(raw);
    if (!msg) {
      debug(`recv unknown: ${JSON.stringify(raw).slice(0, 120)}`);
      return;
    }
    debug(`recv ${msg.type}`);
    try {
      if (msg.type === "viewer-ready") {
        await sendOffer();
      } else if (msg.type === "answer" && msg.sdp) {
        clearRetry();
        if (!pc || pc.signalingState !== "have-local-offer") {
          debug(`skip answer — signalingState=${pc?.signalingState ?? "none"}`);
          return;
        }
        await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        debug("answer applied");
      }
    } catch (err) {
      debug(`error: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  debug(`subscribing to ${webrtcChannelName(liveSessionId)}`);
  await waitSubscribed(ch);
  debug("subscribed");

  return () => {
    clearRetry();
    void ch.unsubscribe();
    pc?.close();
    pc = null;
  };
}

/**
 * Viewer: connects to the broadcaster's session.
 * Uses gather-complete signaling: waits for all ICE before sending the answer.
 */
export async function startViewerP2p(
  liveSessionId: string,
  onRemoteStream: (stream: MediaStream) => void,
  onFailure?: (message: string) => void,
  onDebug?: (line: string) => void,
): Promise<() => void> {
  const debug = (line: string) => {
    onDebug?.(line);
    if (typeof window !== "undefined") console.log("[camtok-viewer]", line);
  };

  const iceConfig = buildIceConfig();
  debug(
    `ICE policy=${iceConfig.iceTransportPolicy ?? "all"} servers=${iceConfig.iceServers?.length ?? 0}`,
  );

  const supabase = createBrowserClient();
  const ch = supabase.channel(webrtcChannelName(liveSessionId), {
    config: { broadcast: { ack: false } },
  });

  const pc = new RTCPeerConnection(iceConfig);
  let cleaned = false;
  let offerApplied = false;
  let answerRetryTimer: ReturnType<typeof setInterval> | null = null;

  const clearAnswerRetry = () => {
    if (answerRetryTimer) { clearInterval(answerRetryTimer); answerRetryTimer = null; }
  };

  const fail = (msg: string) => { if (!cleaned) onFailure?.(msg); };

  pc.ontrack = (e) => {
    debug(`ontrack kind=${e.track.kind}`);
    if (e.streams[0]) onRemoteStream(e.streams[0]);
  };
  pc.onicegatheringstatechange = () => debug(`gather=${pc.iceGatheringState}`);
  pc.oniceconnectionstatechange = () => {
    if (cleaned) return;
    debug(`ice=${pc.iceConnectionState}`);
    if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
      clearAnswerRetry();
    } else if (pc.iceConnectionState === "failed") {
      clearAnswerRetry();
      fail("ICE failed — check TURN server config (NEXT_PUBLIC_TURN_URL).");
    }
  };
  pc.onconnectionstatechange = () => {
    if (cleaned) return;
    debug(`pc=${pc.connectionState}`);
    if (pc.connectionState === "failed") {
      clearAnswerRetry();
      fail("WebRTC connection failed.");
    }
  };
  pc.onicecandidate = (e) => {
    if (e.candidate) {
      const c = e.candidate;
      debug(
        `cand type=${(c as unknown as { type?: string }).type ?? "?"} proto=${c.protocol}`,
      );
    }
  };

  const applyOffer = async (sdp: string) => {
    if (offerApplied) {
      debug("offer already applied, skipping retry");
      return;
    }
    offerApplied = true;
    await pc.setRemoteDescription({ type: "offer", sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    debug("gathering answer…");
    await waitForGatheringComplete(pc);
    const answerSdp = pc.localDescription?.sdp ?? answer.sdp ?? "";
    debug(`send answer (${answerSdp.length}b)`);

    const sendAnswer = () => {
      void ch.send({ type: "broadcast", event: EVENT, payload: { type: "answer", sdp: answerSdp } });
    };
    sendAnswer();

    // Retry answer every 2s until the broadcaster applies it (ICE connects).
    let retries = 0;
    answerRetryTimer = setInterval(() => {
      if (retries >= 6 || pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        clearAnswerRetry();
        return;
      }
      retries += 1;
      debug(`retry answer #${retries}`);
      sendAnswer();
    }, 2000);
  };

  ch.on("broadcast", { event: EVENT }, async (raw) => {
    const msg = parseSignalPayload(raw);
    if (!msg) {
      debug(`recv unknown: ${JSON.stringify(raw).slice(0, 120)}`);
      return;
    }
    debug(`recv ${msg.type}`);
    try {
      if (msg.type === "offer" && msg.sdp) {
        await applyOffer(msg.sdp);
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : "WebRTC negotiation failed");
    }
  });

  debug(`subscribing to ${webrtcChannelName(liveSessionId)}`);
  await waitSubscribed(ch);
  debug("subscribed");

  const sendReady = () => {
    debug("send viewer-ready");
    void ch.send({ type: "broadcast", event: EVENT, payload: { type: "viewer-ready" } });
  };

  sendReady();
  // Single retry after 8s — long enough for the broadcaster to finish TURN gathering
  // without interrupting it. Subsequent retries are handled by the broadcaster's offer
  // resend timer (every 1.5s) once the offer is in flight.
  const readyTimers = [8000].map((ms) => setTimeout(() => {
    if (!offerApplied) {
      debug("no offer after 8s — re-sending viewer-ready");
      sendReady();
    }
  }, ms));

  return () => {
    cleaned = true;
    clearAnswerRetry();
    readyTimers.forEach(clearTimeout);
    void ch.unsubscribe();
    pc.close();
  };
}
