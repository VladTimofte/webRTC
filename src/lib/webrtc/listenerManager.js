import { ref, onValue, set, update, remove, push } from "firebase/database";
import { db } from "../firebase";

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function attachRmsMeter(stream, onLevel) {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx();
  const src = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  src.connect(analyser);

  const buf = new Uint8Array(analyser.fftSize);
  let raf = 0;

  const tick = () => {
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    onLevel(clamp01(rms * 2.2));
    raf = requestAnimationFrame(tick);
  };

  raf = requestAnimationFrame(tick);

  return async () => {
    cancelAnimationFrame(raf);
    try {
      src.disconnect();
    } catch {}
    try {
      analyser.disconnect();
    } catch {}
    try {
      await ctx.close();
    } catch {}
  };
}

export class ListenerWebRTCManager {
  constructor({ listenerId, onStatus, onLevel, debug = false }) {
    this.listenerId = listenerId;
    this.onStatus = onStatus || (() => {});
    this.onLevel = onLevel || (() => {});
    this.debug = debug;

    this.pc = null;
    this.sessionId = null;

    this.audioEl = null;

    this.unsubscribeFns = [];
    this.reconnectTimer = null;

    this._cleanupMeter = null;
    this._muted = false;

    this._offerAppliedForSession = null;
  }

  _log(...a) {
    if (this.debug) console.log("[LISTENER]", ...a);
  }

  async enableAudio() {
    if (!this.audioEl) {
      this.audioEl = document.createElement("audio");
      this.audioEl.autoplay = true;
      this.audioEl.playsInline = true;
      this.audioEl.muted = false;
      this.audioEl.volume = 1;
      document.body.appendChild(this.audioEl);
    }

    // mark in DB
    await update(ref(db, `listeners/${this.listenerId}`), {
      audioEnabled: true,
      updatedAt: Date.now(),
    }).catch(() => {});

    this._watchBroadcast();
  }

  setMuted(m) {
    this._muted = !!m;
    if (this.audioEl) this.audioEl.muted = this._muted;
  }

  _watchBroadcast() {
    const bRef = ref(db, "broadcast");
    const unsub = onValue(bRef, (snap) => {
      const b = snap.val();
      if (!b) return;

      if (b.status === "idle") {
        this._cleanupAll();
        this.onStatus("waiting");
        return;
      }

      // live + new session => reconnect
      if (
        b.status === "live" &&
        b.sessionId &&
        b.sessionId !== this.sessionId
      ) {
        this.sessionId = b.sessionId;
        this._offerAppliedForSession = null;
        this._connect();
      }
    });

    this.unsubscribeFns.push(() => unsub());
  }

  _attachStream(stream) {
    if (!this.audioEl) return;

    try {
      this.audioEl.pause?.();
    } catch {}

    // HARD flush
    this.audioEl.srcObject = null;

    // reduce buffering tendencies
    this.audioEl.preload = "none";
    this.audioEl.playbackRate = 1.0;
    this.audioEl.disableRemotePlayback = true;
    this.audioEl.setAttribute("playsinline", "true");
    this.audioEl.setAttribute("webkit-playsinline", "true");

    // attach new stream
    this.audioEl.srcObject = stream;
    this.audioEl.muted = this._muted;

    // try to reset internal buffer (works in some browsers)
    try {
      this.audioEl.currentTime = 0;
    } catch {}

    // force immediate play
    Promise.resolve(this.audioEl.play?.()).catch(() => {});

    // meter
    this._cleanupMeter?.();
    this._cleanupMeter = null;
    this._cleanupMeter = attachRmsMeter(stream, (v) => this.onLevel(v));
  }

  async _connect() {
    this._cleanupPCOnly();
    this.onStatus("connecting");

    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    this.pc.ontrack = (e) => {
      const stream = e.streams?.[0];
      if (!stream) return;
      this._attachStream(stream);
      this.onStatus("connected");
    };

    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed" || s === "disconnected") this._scheduleReconnect();
    };

    // ICE: listener -> admin
    this.pc.onicecandidate = (e) => {
      if (!e.candidate) return;
      const cRef = push(ref(db, `candidates/admin/${this.listenerId}`));
      set(cRef, e.candidate.toJSON()).catch(() => {});
    };

    // ICE: admin -> listener
    const candRef = ref(db, `candidates/listeners/${this.listenerId}`);
    const unsubCand = onValue(candRef, (snap) => {
      snap.forEach((c) => {
        if (!this.pc || this.pc.signalingState === "closed") return;
        this.pc.addIceCandidate(new RTCIceCandidate(c.val())).catch(() => {});
      });
    });
    this.unsubscribeFns.push(() => unsubCand());

    // Offer
    const offerRef = ref(db, `offers/${this.listenerId}`);
    const unsubOffer = onValue(offerRef, async (snap) => {
      const data = snap.val();
      if (!data || data.sessionId !== this.sessionId) return;

      // ensure one-shot per session
      if (this._offerAppliedForSession === this.sessionId) return;
      this._offerAppliedForSession = this.sessionId;

      if (!this.pc || this.pc.signalingState === "closed") return;

      await this.pc
        .setRemoteDescription({ type: "offer", sdp: data.offer })
        .catch(() => {});
      const answer = await this.pc.createAnswer().catch(() => null);
      if (!answer) return;

      await this.pc.setLocalDescription(answer).catch(() => {});

      await update(ref(db, `listeners/${this.listenerId}`), {
        answer: answer.sdp,
        state: "connecting",
        sessionId: this.sessionId,
        updatedAt: Date.now(),
      }).catch(() => {});
    });
    this.unsubscribeFns.push(() => unsubOffer());
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;
    this.onStatus("connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.sessionId) {
        this._offerAppliedForSession = null;
        this._connect();
      }
    }, 1500);
  }

  _cleanupPCOnly() {
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }
    remove(ref(db, `candidates/admin/${this.listenerId}`)).catch(() => {});
    remove(ref(db, `candidates/listeners/${this.listenerId}`)).catch(() => {});
    remove(ref(db, `offers/${this.listenerId}`)).catch(() => {});
  }

  _cleanupAll() {
    this._cleanupPCOnly();
    this.sessionId = null;
    this._offerAppliedForSession = null;

    this._cleanupMeter?.();
    this._cleanupMeter = null;
    this.onLevel(0);

    if (this.audioEl) {
      try {
        this.audioEl.pause?.();
      } catch {}
      this.audioEl.srcObject = null;
    }
  }

  destroy() {
    this._cleanupAll();
    this.unsubscribeFns.forEach((fn) => fn());
    this.unsubscribeFns = [];

    if (this.audioEl) {
      this.audioEl.remove();
      this.audioEl = null;
    }
  }
}
