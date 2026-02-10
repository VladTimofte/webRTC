import {
  ref,
  onChildAdded,
  onValue,
  set,
  update,
  remove,
  push,
  get,
} from "firebase/database";
import { db } from "../firebase";

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

export class AdminWebRTCBroadcastManager {
  constructor({ audioDeviceId }) {
    this.audioDeviceId = audioDeviceId || null;

    this.peerConnections = new Map();

    // preview stream (always on after initPreview)
    this.previewStream = null;

    // outgoing stream (post-gain, sent to listeners)
    this.audioStream = null;

    this.sessionId = null;
    this.unsubscribeFns = [];

    // WebAudio pipeline
    this._audioCtx = null;
    this._srcNode = null;
    this._gainNode = null;
    this._destNode = null;

    // silent path to destination to force processing
    this._silentGain = null;

    this._volume = 1.0;
    this._muted = false;
    this._broadcastStarted = false;

    // bitrate cap (kbps). null = unlimited/default
    this._maxBitrateKbps = null;
  }

  setMaxBitrateKbps(kbps) {
    // kbps: remind: 0/null => unlimited
    const n = Number(kbps);
    const next =
      !Number.isFinite(n) || n <= 0
        ? null
        : Math.max(6, Math.min(320, Math.round(n)));

    this._maxBitrateKbps = next;

    // persist in DB (so UI reflects it + late-joiners inherit it)
    update(ref(db, "broadcast"), { maxBitrateKbps: next }).catch(() => {});

    // apply live to ALL existing peer connections
    for (const pc of this.peerConnections.values()) {
      this._applyMaxBitrateToPc(pc);
    }
  }

  _applyMaxBitrateToPc(pc) {
    const maxBps = this._maxBitrateKbps ? this._maxBitrateKbps * 1000 : null;

    pc.getSenders().forEach((sender) => {
      const track = sender.track;
      if (!track || track.kind !== "audio") return;

      try {
        const p = sender.getParameters();
        p.encodings = p.encodings || [{}];

        // maxBitrate is in bits/second
        if (maxBps) p.encodings[0].maxBitrate = maxBps;
        else delete p.encodings[0].maxBitrate;

        sender.setParameters(p).catch(() => {});
      } catch {
        // ignore
      }
    });
  }

  getPeerConnections() {
    return this.peerConnections;
  }

  get isBroadcasting() {
    return this._broadcastStarted;
  }

  async initPreview() {
    if (this.previewStream) return this.previewStream;

    this.previewStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: this.audioDeviceId
          ? { exact: this.audioDeviceId }
          : undefined,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: 48000,
      },
      video: false,
    });

    return this.previewStream;
  }

  async destroyPreview() {
    if (this.previewStream) {
      this.previewStream.getTracks().forEach((t) => t.stop());
      this.previewStream = null;
    }
  }

  async start() {
    if (this._broadcastStarted) return;

    await this.initPreview();

    this.sessionId = crypto.randomUUID();

    await update(ref(db, "broadcast"), {
      status: "live",
      sessionId: this.sessionId,
      adminOnline: true,
      volume: this._volume,
      muted: this._muted,
      maxBitrateKbps: this._maxBitrateKbps ?? null,
    });

    await this._setupOutgoingPipelineFromPreview();

    this._broadcastStarted = true;

    const listenersRef = ref(db, "listeners");

    // New listeners
    const u1 = onChildAdded(listenersRef, async (snap) => {
      const id = snap.key;
      const d = snap.val();
      if (d?.audioEnabled) await this._connectListener(id);
    });
    this.unsubscribeFns.push(() => u1());

    // Reconnect listeners when audioEnabled or session mismatch
    const u2 = onValue(listenersRef, async (snap) => {
      snap.forEach(async (c) => {
        const id = c.key;
        const d = c.val();
        if (d?.audioEnabled && d.sessionId !== this.sessionId) {
          await this._connectListener(id);
        }
      });
    });
    this.unsubscribeFns.push(() => u2());
  }

  async stop() {
    // Stop watchers first (prevents racing writes during cleanup)
    this.unsubscribeFns.forEach((fn) => {
      try {
        fn();
      } catch {}
    });
    this.unsubscribeFns = [];

    // Close all PCs
    for (const pc of this.peerConnections.values()) {
      try {
        pc.close();
      } catch {}
    }
    this.peerConnections.clear();

    // Stop outgoing stream
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
    }

    // Teardown audio pipeline
    await this._teardownPipeline();

    this._broadcastStarted = false;
    this.sessionId = null;

    // Set broadcast idle
    await update(ref(db, "broadcast"), {
      status: "idle",
      sessionId: "",
      adminOnline: false,
      muted: false,
      volume: 1,
    }).catch(() => {});

    // Cleanup signaling
    await remove(ref(db, "offers")).catch(() => {});
    await remove(ref(db, "candidates/listeners")).catch(() => {});
    await remove(ref(db, "candidates/admin")).catch(() => {});

    // Reset listeners state so UI + signaling restarts clean
    await this._resetAllListenersState().catch(() => {});
  }

  setVolume(v01) {
    const v = clamp01(Number(v01));
    this._volume = v;

    if (this._gainNode) this._gainNode.gain.value = this._muted ? 0 : v;

    update(ref(db, "broadcast"), { volume: v }).catch(() => {});
  }

  pause() {
    this._muted = true;
    if (this._gainNode) this._gainNode.gain.value = 0;
    update(ref(db, "broadcast"), { muted: true }).catch(() => {});
  }

  resume() {
    this._muted = false;
    if (this._gainNode) this._gainNode.gain.value = this._volume;
    update(ref(db, "broadcast"), { muted: false }).catch(() => {});
  }

  // WARNING: requires rules allowing admin write at root ("/")
  async resetDatabaseHard() {
    await remove(ref(db, "/")).catch(() => {});
  }

  async _resetAllListenersState() {
    const snap = await get(ref(db, "listeners"));
    if (!snap.exists()) return;

    const updates = {};
    const now = Date.now();

    snap.forEach((c) => {
      const id = c.key;
      updates[`listeners/${id}/state`] = "waiting";
      updates[`listeners/${id}/sessionId`] = "";
      updates[`listeners/${id}/answer`] = null;
      updates[`listeners/${id}/updatedAt`] = now;
    });

    await update(ref(db), updates);
  }

  async _setupOutgoingPipelineFromPreview() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    this._audioCtx = new Ctx();

    this._srcNode = this._audioCtx.createMediaStreamSource(this.previewStream);

    this._gainNode = this._audioCtx.createGain();
    this._gainNode.gain.value = this._muted ? 0 : this._volume;

    this._destNode = this._audioCtx.createMediaStreamDestination();

    // main path -> outgoing stream
    this._srcNode.connect(this._gainNode);
    this._gainNode.connect(this._destNode);

    // silent path -> destination (forces processing in some browsers)
    this._silentGain = this._audioCtx.createGain();
    this._silentGain.gain.value = 0;
    this._gainNode.connect(this._silentGain);
    this._silentGain.connect(this._audioCtx.destination);

    // resume context (Start button = user gesture)
    try {
      await this._audioCtx.resume();
    } catch {}

    this.audioStream = this._destNode.stream;
  }

  async _teardownPipeline() {
    try {
      this._srcNode?.disconnect?.();
    } catch {}
    try {
      this._gainNode?.disconnect?.();
    } catch {}
    try {
      this._destNode?.disconnect?.();
    } catch {}
    try {
      this._silentGain?.disconnect?.();
    } catch {}

    this._srcNode = null;
    this._gainNode = null;
    this._destNode = null;
    this._silentGain = null;

    try {
      await this._audioCtx?.close?.();
    } catch {}
    this._audioCtx = null;
  }

  async _connectListener(listenerId) {
    if (!this.audioStream || !this.sessionId) return;

    // always recreate PC for fresh offer
    if (this.peerConnections.has(listenerId)) {
      try {
        this.peerConnections.get(listenerId).close();
      } catch {}
      this.peerConnections.delete(listenerId);
    }

    // cleanup per-listener signaling branches to avoid stale reuse
    await remove(ref(db, `offers/${listenerId}`)).catch(() => {});
    await remove(ref(db, `candidates/listeners/${listenerId}`)).catch(() => {});
    await remove(ref(db, `candidates/admin/${listenerId}`)).catch(() => {});

    await update(ref(db, `listeners/${listenerId}`), {
      state: "connecting",
      sessionId: this.sessionId,
      answer: null,
      updatedAt: Date.now(),
    }).catch(() => {});

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.peerConnections.set(listenerId, pc);

    this.audioStream.getTracks().forEach((t) => {
      const sender = pc.addTrack(t, this.audioStream);

      try {
        const p = sender.getParameters();
        p.degradationPreference = "maintain-framerate";
        p.encodings = p.encodings || [{}];

        // apply bitrate cap if set
        if (this._maxBitrateKbps) {
          p.encodings[0].maxBitrate = this._maxBitrateKbps * 1000;
        } else {
          delete p.encodings[0].maxBitrate;
        }

        sender.setParameters(p).catch(() => {});
      } catch {}
    });

    // admin -> write ICE to candidates/listeners/<listenerId>
    pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const cRef = push(ref(db, `candidates/listeners/${listenerId}`));
      set(cRef, e.candidate.toJSON()).catch(() => {});
    };

    // read listener ICE from candidates/admin/<listenerId>
    const adminCandRef = ref(db, `candidates/admin/${listenerId}`);
    const unsubCand = onChildAdded(adminCandRef, (snap) => {
      pc.addIceCandidate(new RTCIceCandidate(snap.val())).catch(() => {});
    });
    this.unsubscribeFns.push(() => unsubCand());

    // create offer
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);

    await set(ref(db, `offers/${listenerId}`), {
      sessionId: this.sessionId,
      offer: offer.sdp,
      createdAt: Date.now(),
    });

    // wait for answer (one-shot)
    const answerRef = ref(db, `listeners/${listenerId}/answer`);
    const unsubAnswer = onValue(answerRef, async (snap) => {
      const sdp = snap.val();
      if (!sdp) return;
      if (pc.signalingState !== "have-local-offer") return;

      await pc.setRemoteDescription({ type: "answer", sdp }).catch(() => {});

      await update(ref(db, `listeners/${listenerId}`), {
        state: "connected",
        sessionId: this.sessionId,
        updatedAt: Date.now(),
      }).catch(() => {});

      unsubAnswer();
    });
    this.unsubscribeFns.push(() => unsubAnswer());
  }
}
