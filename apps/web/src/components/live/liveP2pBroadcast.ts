import type { RealtimeChannel } from "@supabase/supabase-js";
import { createBrowserClient } from "@/lib/supabase/client";

const EVENT = "webrtc";

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

type BcPayload = Record<string, unknown> & {
  type: string;
  sdp?: string;
  offerUfrag?: string;
  forOfferUfrag?: string;
  candidate?: RTCIceCandidateInit;
};

function parseRawPayload(raw: unknown): BcPayload | null {
  if (raw == null || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const inner = o.payload;
  if (inner && typeof inner === "object" && "type" in inner) {
    return inner as BcPayload;
  }
  if ("type" in o) return o as BcPayload;
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

function iceUfrag(sdp: string) {
  const m = /a=ice-ufrag:([^\s\r\n]+)/.exec(sdp);
  if (m) return m[1]!;
  let h = 0;
  for (let i = 0; i < Math.min(sdp.length, 500); i++) h = (h * 33 + sdp.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

/**
 * Broadcaster: trickle ICE.
 * - Sends offer immediately after setLocalDescription (no gather-wait).
 * - Streams local ICE candidates via "bc-candidate" broadcast events.
 * - Buffers & applies remote ICE candidates from "vc-candidate" events.
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
    config: { broadcast: { ack: false, self: false } },
  });
  let pc: RTCPeerConnection | null = null;
  let offerRetryTimer: ReturnType<typeof setInterval> | null = null;
  let lastOffer: string | null = null;
  let lastOfferUfrag: string | null = null;
  let isNegotiating = false;
  // Buffer vc-candidates that arrive before setRemoteDescription(answer)
  const vcBuf = new Map<string, RTCIceCandidateInit[]>();

  const send = (payload: BcPayload) =>
    void ch.send({ type: "broadcast", event: EVENT, payload });

  const clearOfferResend = () => {
    if (offerRetryTimer) { clearInterval(offerRetryTimer); offerRetryTimer = null; }
  };

  const closePc = () => {
    if (pc && pc.signalingState !== "closed") pc.close();
    pc = null;
  };

  const buildPcBase = () => {
    const p = new RTCPeerConnection(iceConfig);
    stream.getTracks().forEach((t) => p.addTrack(t, stream));
    p.onicegatheringstatechange = () => debug(`gather=${p.iceGatheringState}`);
    p.oniceconnectionstatechange = () => {
      const s = p.iceConnectionState;
      debug(`ice=${s}`);
      if (s === "connected" || s === "completed") clearOfferResend();
    };
    p.onconnectionstatechange = () => debug(`pc=${p.connectionState}`);
    pc = p;
    return p;
  };

  const sendOffer = async () => {
    if (isNegotiating) { debug("already negotiating, skip"); return; }
    isNegotiating = true;
    try {
      clearOfferResend();
      closePc();
      vcBuf.clear();
      lastOffer = null;
      lastOfferUfrag = null;

      const p = buildPcBase();
      const offer = await p.createOffer();
      const ug = iceUfrag(offer.sdp ?? "");
      // Attach onicecandidate BEFORE setLocalDescription so candidates that
      // fire during gathering are never dropped. Ufrag is captured in closure.
      p.onicecandidate = (e) => {
        if (!e.candidate) return;
        const c = e.candidate;
        debug(
          `bc-cand type=${(c as unknown as { type?: string }).type ?? "?"} proto=${c.protocol}`,
        );
        send({ type: "bc-candidate", candidate: c.toJSON(), forOfferUfrag: ug });
      };
      lastOfferUfrag = ug;
      await p.setLocalDescription(offer);
      const sdp = p.localDescription?.sdp ?? offer.sdp ?? "";
      lastOffer = sdp;
      debug(`send offer len=${sdp.length} ufrag=${ug.slice(0, 8)}…`);
      send({ type: "offer", sdp, offerUfrag: ug });

      let n = 0;
      offerRetryTimer = setInterval(() => {
        n++;
        if (n > 20 || !lastOffer || !lastOfferUfrag) { clearOfferResend(); return; }
        if (!pc || pc.signalingState !== "have-local-offer") {
          clearOfferResend();
          return;
        }
        debug(`resend offer #${n} ufrag=${lastOfferUfrag.slice(0, 6)}`);
        send({ type: "offer", sdp: lastOffer, offerUfrag: lastOfferUfrag });
      }, 2000);
    } finally {
      isNegotiating = false;
    }
  };

  ch.on("broadcast", { event: EVENT }, async (raw) => {
    const msg = parseRawPayload(raw);
    if (!msg) { debug(`bad payload ${JSON.stringify(raw).slice(0, 80)}`); return; }
    // Ignore self-echoes
    if (msg.type === "offer" || msg.type === "bc-candidate") return;
    debug(`recv ${msg.type}`);
    try {
      if (msg.type === "viewer-ready") {
        // Always rebuild on viewer-ready (handles both first viewer and stuck retry)
        await sendOffer();
      } else if (msg.type === "answer" && typeof msg.sdp === "string") {
        if (!pc || pc.signalingState === "closed") { debug("no pc for answer"); return; }
        const ansUfrag = typeof msg.forOfferUfrag === "string" ? msg.forOfferUfrag : null;
        if (ansUfrag && lastOfferUfrag && ansUfrag !== lastOfferUfrag) {
          debug(
            `stale answer (want=${lastOfferUfrag.slice(0, 6)} got=${ansUfrag.slice(0, 6)}) — ignore`,
          );
          return;
        }
        if (pc.signalingState !== "have-local-offer") {
          debug(`skip answer (state=${pc.signalingState})`);
          return;
        }
        try {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        } catch (e) {
          debug(`setRemote answer err: ${e instanceof Error ? e.message : String(e)}`);
          return;
        }
        debug("answer applied");
        clearOfferResend();
        // Flush buffered vc-candidates that arrived before answer
        const key = ansUfrag ?? lastOfferUfrag ?? "";
        const buffered = vcBuf.get(key) ?? [];
        vcBuf.clear();
        for (const cand of buffered) {
          try { await pc.addIceCandidate(cand); } catch { /* ignore stale */ }
        }
        if (buffered.length) debug(`flushed ${buffered.length} buffered vc-cands`);
      } else if (
        msg.type === "vc-candidate" &&
        msg.candidate &&
        typeof msg.forOfferUfrag === "string"
      ) {
        const forU = msg.forOfferUfrag;
        if (lastOfferUfrag && forU !== lastOfferUfrag) {
          debug(`stale vc-cand (want=${lastOfferUfrag.slice(0, 6)} got=${forU.slice(0, 6)}) — skip`);
          return;
        }
        const cand = msg.candidate as RTCIceCandidateInit;
        if (pc && pc.signalingState !== "closed" && pc.remoteDescription) {
          try {
            await pc.addIceCandidate(cand);
          } catch (e) {
            debug(`addIceCandidate err: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          const buf = vcBuf.get(forU) ?? [];
          buf.push(cand);
          vcBuf.set(forU, buf);
        }
      }
    } catch (e) {
      debug(`err: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  await waitSubscribed(ch);
  debug("subscribed");

  return () => {
    clearOfferResend();
    void ch.unsubscribe();
    closePc();
    vcBuf.clear();
    lastOfferUfrag = null;
  };
}

/**
 * Viewer: trickle ICE.
 * - Sends answer immediately after setLocalDescription (no gather-wait).
 * - Streams local ICE candidates via "vc-candidate" broadcast events.
 * - Buffers & applies remote ICE candidates from "bc-candidate" events.
 * - Retries answer every 2s until ICE connects (broadcaster-side answer loss protection).
 * - 6s stuck recovery: full reset of negotiation state and resend viewer-ready.
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
    config: { broadcast: { ack: false, self: false } },
  });
  let pc: RTCPeerConnection | null = null;
  let cleaned = false;
  let negotiateId = 0;
  // Use a Set so very-late offer retransmits don't tear down a newer negotiation.
  const seenUfrags = new Set<string>();
  let processingUfrag: string | null = null;
  let stuckTimer: ReturnType<typeof setInterval> | null = null;
  let answerRetryTimer: ReturnType<typeof setInterval> | null = null;
  // Buffer bc-candidates that arrive before we finish setRemoteDescription(offer)
  const bcBuf = new Map<string, RTCIceCandidateInit[]>();

  const send = (payload: BcPayload) =>
    void ch.send({ type: "broadcast", event: EVENT, payload });

  const clearStuck = () => {
    if (stuckTimer) { clearInterval(stuckTimer); stuckTimer = null; }
  };
  const clearAnswerRetry = () => {
    if (answerRetryTimer) { clearInterval(answerRetryTimer); answerRetryTimer = null; }
  };

  const closeViewerPc = () => {
    clearAnswerRetry();
    if (pc && pc.signalingState !== "closed") pc.close();
    pc = null;
  };

  const wire = (p: RTCPeerConnection, offerUfrag: string) => {
    p.ontrack = (e) => {
      debug(`ontrack kind=${e.track.kind}`);
      const s =
        e.streams[0] ??
        (() => {
          const m = new MediaStream();
          if (e.track) m.addTrack(e.track);
          return m;
        })();
      onRemoteStream(s);
    };
    p.onicegatheringstatechange = () => debug(`gather=${p.iceGatheringState}`);
    p.oniceconnectionstatechange = () => {
      if (cleaned) return;
      const s = p.iceConnectionState;
      debug(`ice=${s}`);
      if (s === "connected" || s === "completed") {
        clearStuck();
        clearAnswerRetry();
      }
      if (s === "failed" && p === pc) fail("ICE failed.");
    };
    p.onconnectionstatechange = () => {
      if (cleaned) return;
      debug(`pc=${p.connectionState}`);
      if (p.connectionState === "failed" && p === pc) fail("Connection failed.");
    };
    // Trickle ICE: stream local candidates as they arrive. Ufrag captured in closure.
    p.onicecandidate = (e) => {
      if (cleaned || p !== pc || !e.candidate) return;
      const c = e.candidate;
      debug(
        `vc-cand type=${(c as unknown as { type?: string }).type ?? "?"} proto=${c.protocol}`,
      );
      send({ type: "vc-candidate", candidate: c.toJSON(), forOfferUfrag: offerUfrag });
    };
  };

  const fail = (m: string) => { if (!cleaned) onFailure?.(m); };

  const applyOffer = async (om: { sdp: string; offerUfrag?: string }) => {
    const ufrag = om.offerUfrag || iceUfrag(om.sdp);
    if (!ufrag) return;
    if (seenUfrags.has(ufrag) || processingUfrag === ufrag) {
      debug(`dup offer ufrag=${ufrag.slice(0, 6)} — ignore`);
      return;
    }
    processingUfrag = ufrag;
    const g = ++negotiateId;
    closeViewerPc();
    if (cleaned) { processingUfrag = null; return; }
    const newPc = new RTCPeerConnection(iceConfig);
    wire(newPc, ufrag);
    pc = newPc;
    try {
      await newPc.setRemoteDescription({ type: "offer", sdp: om.sdp });
    } catch (e) {
      processingUfrag = null;
      if (!cleaned) fail(e instanceof Error ? e.message : "setRemote err");
      return;
    }
    if (g !== negotiateId || cleaned) return;

    // Flush bc-candidates that arrived while setRemoteDescription was pending
    const buffered = bcBuf.get(ufrag) ?? [];
    bcBuf.delete(ufrag);
    for (const cand of buffered) {
      try { await newPc.addIceCandidate(cand); } catch { /* ignore */ }
    }
    if (buffered.length) debug(`flushed ${buffered.length} buffered bc-cands`);

    let answer: RTCSessionDescriptionInit;
    try {
      answer = await newPc.createAnswer();
    } catch (e) {
      processingUfrag = null;
      if (!cleaned) fail(e instanceof Error ? e.message : "createAnswer err");
      return;
    }
    if (g !== negotiateId || cleaned) return;
    await newPc.setLocalDescription(answer);
    if (g !== negotiateId || cleaned) return;

    const answerSdp = newPc.localDescription?.sdp ?? answer.sdp ?? "";
    seenUfrags.add(ufrag);
    processingUfrag = null;
    debug(`send answer (trickle) len=${answerSdp.length} for ufrag=${ufrag.slice(0, 6)}`);

    const sendAns = () => {
      if (cleaned) return;
      send({ type: "answer", sdp: answerSdp, forOfferUfrag: ufrag });
    };
    sendAns();

    // Retry answer until ICE connects — the broadcast can be dropped in transit
    // and the broadcaster has no other way to recover.
    clearAnswerRetry();
    let r = 0;
    answerRetryTimer = setInterval(() => {
      if (cleaned) { clearAnswerRetry(); return; }
      if (g !== negotiateId) { clearAnswerRetry(); return; }
      const cur = pc;
      if (!cur || cur.signalingState === "closed") { clearAnswerRetry(); return; }
      if (
        cur.iceConnectionState === "connected" ||
        cur.iceConnectionState === "completed"
      ) {
        clearAnswerRetry();
        return;
      }
      r++;
      if (r > 10) { clearAnswerRetry(); return; }
      debug(`retry answer #${r} ufrag=${ufrag.slice(0, 6)}`);
      sendAns();
    }, 2000);
  };

  ch.on("broadcast", { event: EVENT }, async (raw) => {
    const msg = parseRawPayload(raw);
    if (!msg) return;
    // Ignore self-echoes
    if (msg.type === "viewer-ready" || msg.type === "answer" || msg.type === "vc-candidate") return;
    if (msg.type === "offer" && typeof msg.sdp === "string") {
      void applyOffer({
        sdp: msg.sdp,
        offerUfrag: typeof msg.offerUfrag === "string" ? msg.offerUfrag : undefined,
      });
    } else if (
      msg.type === "bc-candidate" &&
      msg.candidate &&
      typeof msg.forOfferUfrag === "string"
    ) {
      const forU = msg.forOfferUfrag;
      const candidate = msg.candidate as RTCIceCandidateInit;
      const curPc = pc;
      if (curPc && curPc.signalingState !== "closed" && curPc.remoteDescription) {
        try {
          await curPc.addIceCandidate(candidate);
        } catch (e) {
          debug(`addIceCandidate err: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        const buf = bcBuf.get(forU) ?? [];
        buf.push(candidate);
        bcBuf.set(forU, buf);
      }
    }
  });

  await waitSubscribed(ch);
  debug("subscribed");

  const sendReady = () => {
    debug("viewer-ready");
    send({ type: "viewer-ready" } as BcPayload);
  };

  sendReady();

  // Stuck-recovery: every 6s if still not connected, blow everything away and
  // resend viewer-ready. Broadcaster will rebuild its PC and send a fresh offer.
  stuckTimer = setInterval(() => {
    if (cleaned) { clearStuck(); return; }
    const s = pc?.iceConnectionState;
    if (s === "connected" || s === "completed") {
      clearStuck();
      return;
    }
    debug(`viewer-ready retry (stuck, ice=${s ?? "none"})`);
    seenUfrags.clear();
    processingUfrag = null;
    bcBuf.clear();
    closeViewerPc();
    sendReady();
  }, 6000);

  return () => {
    cleaned = true;
    clearStuck();
    clearAnswerRetry();
    void ch.unsubscribe();
    closeViewerPc();
    bcBuf.clear();
    seenUfrags.clear();
  };
}
