"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ref, onValue, update } from "firebase/database";
import { db } from "../../lib/firebase";
import { AdminWebRTCBroadcastManager } from "../../lib/webrtc/adminManager";
import { getAuth, signInWithEmailAndPassword, signOut } from "firebase/auth";

const LS_EMAIL = "geneza_admin_email";
const LS_PASS = "geneza_admin_pass";

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
function formatMs(ms) {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}
function pillStyle(kind) {
  const base = {
    display: "inline-flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 12px",
    borderRadius: 999,
    fontWeight: 700,
    fontSize: 12,
    letterSpacing: 0.2,
    border: "1px solid rgba(255,255,255,0.14)",
  };
  if (kind === "live") return { ...base, background: "rgba(16,185,129,0.18)" };
  if (kind === "danger")
    return { ...base, background: "rgba(248,113,113,0.18)" };
  return { ...base, background: "rgba(148,163,184,0.18)" };
}

function Meter({ value = 0, label, sublabel }) {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 6,
          opacity: 0.9,
        }}
      >
        <div style={{ fontWeight: 800 }}>{label}</div>
        <div style={{ fontVariantNumeric: "tabular-nums" }}>{pct}%</div>
      </div>
      <div
        style={{
          height: 12,
          borderRadius: 999,
          background: "rgba(255,255,255,0.08)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "rgba(255,255,255,0.65)",
          }}
        />
      </div>
      {sublabel ? (
        <div style={{ marginTop: 6, opacity: 0.7, fontSize: 12 }}>
          {sublabel}
        </div>
      ) : null}
    </div>
  );
}

function useNetworkInfo() {
  const [info, setInfo] = useState({ online: true });
  useEffect(() => {
    const updateInfo = () => {
      const c =
        navigator.connection ||
        navigator.mozConnection ||
        navigator.webkitConnection;
      setInfo({
        online: navigator.onLine,
        effectiveType: c?.effectiveType,
        downlink: c?.downlink,
        rtt: c?.rtt,
      });
    };
    updateInfo();
    window.addEventListener("online", updateInfo);
    window.addEventListener("offline", updateInfo);
    const c =
      navigator.connection ||
      navigator.mozConnection ||
      navigator.webkitConnection;
    c?.addEventListener?.("change", updateInfo);
    return () => {
      window.removeEventListener("online", updateInfo);
      window.removeEventListener("offline", updateInfo);
      c?.removeEventListener?.("change", updateInfo);
    };
  }, []);
  return info;
}

function createStreamMeter(stream, onLevel) {
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

async function getPcRttMs(pc) {
  const stats = await pc.getStats();
  let selectedPair = null;

  stats.forEach((r) => {
    if (r.type === "transport" && r.selectedCandidatePairId) {
      const pair = stats.get(r.selectedCandidatePairId);
      if (pair) selectedPair = pair;
    }
  });

  if (!selectedPair) {
    stats.forEach((r) => {
      if (r.type === "candidate-pair" && r.state === "succeeded" && r.nominated)
        selectedPair = r;
    });
  }

  const rttSec =
    selectedPair?.currentRoundTripTime ?? selectedPair?.roundTripTime;
  if (!Number.isFinite(rttSec)) return null;
  return rttSec * 1000;
}

function Shell({ children }) {
  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(1200px 500px at 50% -10%, rgba(59,130,246,0.18), transparent), #0b1220",
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
      }}
    >
      <div style={{ width: "100%", maxWidth: 980 }}>
        <div
          style={{
            borderRadius: 22,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.05)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
            overflow: "hidden",
          }}
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default function AdminPage() {
  const mgrRef = useRef(null);

  const previewMeterCleanupRef = useRef(null);
  const outMeterCleanupRef = useRef(null);

  const [inputLevel, setInputLevel] = useState(0);
  const [outLevel, setOutLevel] = useState(0);

  const [avgRttMs, setAvgRttMs] = useState(null);

  const [devices, setDevices] = useState([]);
  const [deviceId, setDeviceId] = useState("");

  const [status, setStatus] = useState("idle");
  const [broadcastSessionId, setBroadcastSessionId] = useState("");
  const [broadcastMuted, setBroadcastMuted] = useState(false);
  const [broadcastVolume, setBroadcastVolume] = useState(1);

  const [listeners, setListeners] = useState([]);
  const network = useNetworkInfo();

  // Login gate
  const [uiAuthed, setUiAuthed] = useState(false);
  const [email, setEmail] = useState("");
  const [pass, setPass] = useState("");
  const [authError, setAuthError] = useState("");

  // Reset confirmation: 2 clicks within 5s
  const [resetArmed, setResetArmed] = useState(false);
  const resetTimerRef = useRef(null);

  useEffect(() => {
    setUiAuthed(false);

    // Autocomplete DOAR dacă există deja în localStorage
    const savedEmail = localStorage.getItem(LS_EMAIL);
    const savedPass = localStorage.getItem(LS_PASS);

    if (savedEmail) setEmail(savedEmail);
    if (savedPass) setPass(savedPass);

    // Dacă nu există în LS, rămân goale (userul trebuie să știe credențialele)
  }, []);

  async function login() {
    setAuthError("");

    const e = (email || "").trim();
    const p = pass || "";

    if (!e || !p) {
      setAuthError("Te rog completează email și parolă.");
      setUiAuthed(false);
      return;
    }

    try {
      // IMPORTANT: NU salvăm nimic înainte de a confirma login-ul
      await signInWithEmailAndPassword(getAuth(), e, p);

      // DOAR după succes salvăm pentru autocomplete data viitoare
      localStorage.setItem(LS_EMAIL, e);
      localStorage.setItem(LS_PASS, p);

      setUiAuthed(true);
    } catch (err) {
      // NU scriem nimic în LS la fail
      setAuthError("Email sau parolă greșite.");
      setUiAuthed(false);
    }
  }

  async function logout() {
    try {
      if (mgrRef.current?.isBroadcasting) await mgrRef.current.stop();
    } catch {}
    mgrRef.current = null;

    previewMeterCleanupRef.current?.();
    previewMeterCleanupRef.current = null;
    outMeterCleanupRef.current?.();
    outMeterCleanupRef.current = null;

    setOutLevel(0);
    setInputLevel(0);

    await signOut(getAuth()).catch(() => {});
    setUiAuthed(false);
  }

  // Load devices
  useEffect(() => {
    if (!uiAuthed) return;

    (async () => {
      const list = await navigator.mediaDevices.enumerateDevices();
      const mics = list.filter((d) => d.kind === "audioinput");
      setDevices(mics);
      if (mics[0]) setDeviceId(mics[0].deviceId);
    })();
  }, [uiAuthed]);

  // When device changes: restart preview stream + input meter ALWAYS
  useEffect(() => {
    if (!uiAuthed) return;
    if (!deviceId) return;

    let mounted = true;

    (async () => {
      if (!mgrRef.current)
        mgrRef.current = new AdminWebRTCBroadcastManager({
          audioDeviceId: deviceId,
        });
      else mgrRef.current.audioDeviceId = deviceId;

      // recreate preview on device change
      try {
        await mgrRef.current.destroyPreview?.();
      } catch {}

      const stream = await mgrRef.current.initPreview();
      if (!mounted) return;

      previewMeterCleanupRef.current?.();
      previewMeterCleanupRef.current = await createStreamMeter(stream, (v) =>
        setInputLevel(v),
      );
    })();

    return () => {
      mounted = false;
    };
  }, [uiAuthed, deviceId]);

  // DB watchers
  useEffect(() => {
    if (!uiAuthed) return;

    const u1 = onValue(ref(db, "broadcast"), (snap) => {
      const b = snap.val() || {};
      setStatus(b.status || "idle");
      setBroadcastSessionId(b.sessionId || "");
      setBroadcastMuted(!!b.muted);
      setBroadcastVolume(Number.isFinite(b.volume) ? b.volume : 1);
    });

    const u2 = onValue(ref(db, "listeners"), (snap) => {
      const arr = [];
      snap.forEach((c) => {
        const v = c.val() || {};
        arr.push({
          id: c.key,
          audioEnabled: !!v.audioEnabled,
          state: v.state || "waiting",
          sessionId: v.sessionId || "",
          updatedAt: v.updatedAt || 0,
        });
      });
      setListeners(arr);
    });

    return () => {
      u1();
      u2();
    };
  }, [uiAuthed]);

  // Stats loop: RTT
  useEffect(() => {
    if (!uiAuthed) return;

    let t = null;
    t = setInterval(async () => {
      const mgr = mgrRef.current;
      if (!mgr?.isBroadcasting) {
        setAvgRttMs(null);
        return;
      }
      const pcs = mgr.getPeerConnections?.();
      if (!pcs || pcs.size === 0) {
        setAvgRttMs(null);
        return;
      }
      let sum = 0;
      let n = 0;
      for (const pc of pcs.values()) {
        const rtt = await getPcRttMs(pc).catch(() => null);
        if (Number.isFinite(rtt)) {
          sum += rtt;
          n += 1;
        }
      }
      setAvgRttMs(n ? sum / n : null);
    }, 1000);

    return () => {
      if (t) clearInterval(t);
    };
  }, [uiAuthed]);

  async function forceResetDBSoft() {
    await update(ref(db, "broadcast"), {
      status: "idle",
      sessionId: "",
      adminOnline: false,
      muted: false,
      volume: 1,
    }).catch(() => {});
  }

  async function start() {
    if (!uiAuthed) return;

    if (!mgrRef.current)
      mgrRef.current = new AdminWebRTCBroadcastManager({
        audioDeviceId: deviceId,
      });

    await mgrRef.current.initPreview();

    await mgrRef.current.start();
    mgrRef.current.setVolume(broadcastVolume);
    if (broadcastMuted) mgrRef.current.pause();

    // OUT meter = audioStream post-gain
    try {
      const outStream = mgrRef.current.audioStream;
      if (outStream) {
        outMeterCleanupRef.current?.();
        outMeterCleanupRef.current = await createStreamMeter(outStream, (v) =>
          setOutLevel(v),
        );
      }
    } catch {}
  }

  async function stop() {
    if (!uiAuthed) return;

    // stop broadcast + cleanup out meter
    try {
      if (mgrRef.current?.isBroadcasting) await mgrRef.current.stop();
    } catch {}

    outMeterCleanupRef.current?.();
    outMeterCleanupRef.current = null;
    setOutLevel(0);

    await forceResetDBSoft();
  }

  function muteToggle() {
    const mgr = mgrRef.current;
    if (!mgr || !mgr.isBroadcasting) return;

    if (broadcastMuted) {
      mgr.resume();
      setBroadcastMuted(false);
    } else {
      mgr.pause();
      setBroadcastMuted(true);
    }
  }

  function onVolumeChange(v) {
    const vv = clamp01(v);
    setBroadcastVolume(vv);
    if (mgrRef.current?.isBroadcasting) mgrRef.current.setVolume(vv);
    else update(ref(db, "broadcast"), { volume: vv }).catch(() => {});
  }

  async function resetDbHardClick() {
    if (!mgrRef.current)
      mgrRef.current = new AdminWebRTCBroadcastManager({
        audioDeviceId: deviceId,
      });

    if (!resetArmed) {
      setResetArmed(true);
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = setTimeout(() => setResetArmed(false), 5000);
      return;
    }

    clearTimeout(resetTimerRef.current);
    setResetArmed(false);

    try {
      if (mgrRef.current?.isBroadcasting) await mgrRef.current.stop();
    } catch {}

    outMeterCleanupRef.current?.();
    outMeterCleanupRef.current = null;
    setOutLevel(0);

    await mgrRef.current.resetDatabaseHard();
  }

  // Best-effort: if tab/browser closes while live, stop + set idle
  useEffect(() => {
    if (!uiAuthed) return;

    const handler = () => {
      try {
        mgrRef.current?.stop?.();
      } catch {}
      try {
        update(ref(db, "broadcast"), {
          status: "idle",
          sessionId: "",
          adminOnline: false,
        }).catch(() => {});
      } catch {}
    };

    window.addEventListener("beforeunload", handler);
    window.addEventListener("pagehide", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
      window.removeEventListener("pagehide", handler);
    };
  }, [uiAuthed]);

  const isLive = status === "live";
  const totalListeners = listeners.length;

  // Active listeners = audioEnabled && seen recently (last 30s)
  const activeListeners = useMemo(() => {
    const now = Date.now();
    return listeners.filter(
      (l) => l.audioEnabled && now - (l.updatedAt || 0) < 30_000,
    );
  }, [listeners]);

  const title = isLive ? "Transmisiune LIVE" : "Transmisiune oprită";

  // LOGIN ONLY
  if (!uiAuthed) {
    return (
      <Shell>
        <div
          style={{
            padding: 18,
            borderBottom: "1px solid rgba(255,255,255,0.10)",
          }}
        >
          <div style={{ opacity: 0.7, fontSize: 13 }}>
            Biserica Geneza · Broadcast Audio
          </div>
          <div style={{ fontSize: 26, fontWeight: 900, marginTop: 4 }}>
            Autentificare Admin
          </div>
        </div>

        <div style={{ padding: 18 }}>
          <div
            style={{
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,0.10)",
              padding: 16,
            }}
          >
            <div style={{ display: "grid", gap: 10 }}>
              <input
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email admin"
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(0,0,0,0.25)",
                  color: "white",
                }}
              />
              <input
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                type="password"
                placeholder="Parolă"
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(0,0,0,0.25)",
                  color: "white",
                }}
              />

              <button
                onClick={login}
                style={{
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(59,130,246,0.35)",
                  color: "white",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                Intră (Login)
              </button>

              {authError ? (
                <div style={{ color: "rgba(248,113,113,0.95)", fontSize: 13 }}>
                  {authError}
                </div>
              ) : null}

              <div style={{ opacity: 0.7, fontSize: 12 }}>
                Câmpurile se autocompletază (localStorage), dar trebuie să apeși
                Login de fiecare dată.
              </div>
            </div>
          </div>
        </div>

        <div
          style={{
            padding: 14,
            borderTop: "1px solid rgba(255,255,255,0.10)",
            opacity: 0.75,
            fontSize: 12,
          }}
        >
          Geneza Broadcast · Admin
        </div>
      </Shell>
    );
  }

  // ADMIN CONSOLE
  return (
    <Shell>
      {/* Header */}
      <div
        style={{
          padding: 18,
          borderBottom: "1px solid rgba(255,255,255,0.10)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <div>
            <div style={{ opacity: 0.7, fontSize: 13 }}>
              Biserica Geneza · Broadcast Audio
            </div>
            <div style={{ fontSize: 26, fontWeight: 900, marginTop: 4 }}>
              {title}
            </div>
            <div style={{ opacity: 0.7, fontSize: 12, marginTop: 6 }}>
              Email: {email}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              flexWrap: "wrap",
            }}
          >
            <span style={pillStyle(isLive ? "live" : "idle")}>
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: isLive
                    ? "rgba(34,197,94,1)"
                    : "rgba(148,163,184,1)",
                }}
              />
              {isLive ? "LIVE" : "IDLE"}
            </span>

            <span style={pillStyle("idle")}>
              Activi:{" "}
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {activeListeners.length}
              </span>
            </span>

            <span style={pillStyle("idle")}>
              Total:{" "}
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {totalListeners}
              </span>
            </span>

            <span style={pillStyle("idle")}>
              RTT:{" "}
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {formatMs(avgRttMs)}
              </span>
            </span>

            <button
              onClick={logout}
              style={{
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid rgba(255,255,255,0.14)",
                background: "rgba(0,0,0,0.25)",
                color: "white",
                fontWeight: 800,
                cursor: "pointer",
              }}
            >
              Logout
            </button>
          </div>
        </div>
      </div>

      {/* Body */}
      <div
        style={{
          padding: 18,
          display: "grid",
          gridTemplateColumns: "1.2fr 0.8fr",
          gap: 14,
        }}
      >
        {/* Left */}
        <div style={{ display: "grid", gap: 14 }}>
          {/* Controls */}
          <div
            style={{
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,0.10)",
              padding: 16,
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>
              Control Transmisiune
            </div>

            <div style={{ marginBottom: 10 }}>
              <div style={{ opacity: 0.75, fontSize: 12, marginBottom: 6 }}>
                Sursă audio (intrare):
              </div>
              <select
                style={{
                  width: "100%",
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(0,0,0,0.25)",
                  color: "white",
                }}
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
                disabled={isLive}
              >
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label || "Microfon / Intrare"}
                  </option>
                ))}
              </select>
            </div>

            {/* Volume slider */}
            <div style={{ marginTop: 12 }}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  marginBottom: 8,
                  opacity: 0.9,
                }}
              >
                <div style={{ fontWeight: 800 }}>Volum transmis</div>
                <div style={{ fontVariantNumeric: "tabular-nums" }}>
                  {Math.round(broadcastVolume * 100)}%
                </div>
              </div>
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={broadcastVolume}
                onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
                style={{ width: "100%" }}
              />
              <div style={{ marginTop: 6, opacity: 0.7, fontSize: 12 }}>
                Ajustează nivelul trimis către toate device-urile.
              </div>
            </div>

            <div
              style={{
                display: "flex",
                gap: 10,
                flexWrap: "wrap",
                marginTop: 14,
              }}
            >
              <button
                onClick={start}
                disabled={isLive}
                style={{
                  flex: "1 1 160px",
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: isLive
                    ? "rgba(255,255,255,0.08)"
                    : "rgba(34,197,94,0.30)",
                  color: "white",
                  fontWeight: 900,
                  cursor: isLive ? "not-allowed" : "pointer",
                }}
              >
                Pornește LIVE
              </button>

              <button
                onClick={stop}
                style={{
                  flex: "1 1 160px",
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: "rgba(248,113,113,0.25)",
                  color: "white",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                Oprește
              </button>

              <button
                onClick={muteToggle}
                disabled={!isLive}
                style={{
                  flex: "1 1 160px",
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: !isLive
                    ? "rgba(255,255,255,0.08)"
                    : broadcastMuted
                      ? "rgba(59,130,246,0.35)"
                      : "rgba(0,0,0,0.25)",
                  color: "white",
                  fontWeight: 900,
                  cursor: !isLive ? "not-allowed" : "pointer",
                }}
              >
                {broadcastMuted ? "Repornește Sunet" : "Mut (Pauză)"}
              </button>
            </div>

            {/* DB Reset */}
            <div
              style={{
                marginTop: 14,
                display: "flex",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
              }}
            >
              <button
                onClick={resetDbHardClick}
                style={{
                  padding: 12,
                  borderRadius: 14,
                  border: "1px solid rgba(255,255,255,0.14)",
                  background: resetArmed
                    ? "rgba(248,113,113,0.35)"
                    : "rgba(0,0,0,0.25)",
                  color: "white",
                  fontWeight: 900,
                  cursor: "pointer",
                }}
              >
                {resetArmed
                  ? "Confirmă RESET DB (încă o dată)"
                  : "Resetare Totală DB"}
              </button>
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                Șterge <b>tot</b> (broadcast, listeners, offers, candidates).
                Confirmare 2 click-uri (5 secunde).
              </div>
            </div>

            <div style={{ marginTop: 14, opacity: 0.75, fontSize: 12 }}>
              Sesiune:{" "}
              <span style={{ fontVariantNumeric: "tabular-nums" }}>
                {broadcastSessionId || "—"}
              </span>
            </div>
          </div>

          {/* Meters */}
          <div
            style={{
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,0.10)",
              padding: 16,
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 12 }}>
              Nivel Audio (în timp real)
            </div>
            <div style={{ display: "grid", gap: 14 }}>
              <Meter
                value={inputLevel}
                label="Intrare (mereu activă)"
                sublabel="Nivel semnal din device-ul selectat (chiar și idle/pauză)"
              />
              <Meter
                value={outLevel}
                label="Ieșire (broadcast, post-volum)"
                sublabel="Nivel real trimis către listeners (după slider / mute)"
              />
            </div>
          </div>
        </div>

        {/* Right */}
        <div style={{ display: "grid", gap: 14 }}>
          {/* Network */}
          <div
            style={{
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,0.10)",
              padding: 16,
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>
              Rețea (Admin)
            </div>
            <div
              style={{ display: "grid", gap: 6, fontSize: 13, opacity: 0.9 }}
            >
              <div>
                Online: <b>{network.online ? "Da" : "Nu"}</b>
              </div>
              <div>
                Tip: <b>{network.effectiveType || "—"}</b>
              </div>
              <div>
                RTT browser: <b>{network.rtt ? `${network.rtt} ms` : "—"}</b>
              </div>
              <div>
                Downlink:{" "}
                <b>{network.downlink ? `${network.downlink} Mbps` : "—"}</b>
              </div>
              <div style={{ opacity: 0.7, fontSize: 12 }}>
                (SSID Wi-Fi nu poate fi citit din browser.)
              </div>
            </div>
          </div>

          {/* Listeners */}
          <div
            style={{
              borderRadius: 18,
              border: "1px solid rgba(255,255,255,0.10)",
              padding: 16,
            }}
          >
            <div style={{ fontWeight: 900, fontSize: 16, marginBottom: 10 }}>
              Ascultători (detaliu)
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              {listeners.length === 0 ? (
                <div style={{ opacity: 0.75, fontSize: 13 }}>
                  Niciun ascultător încă.
                </div>
              ) : (
                listeners.map((l) => (
                  <div
                    key={l.id}
                    style={{
                      borderRadius: 14,
                      border: "1px solid rgba(255,255,255,0.10)",
                      padding: 12,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 10,
                      alignItems: "center",
                      background: "rgba(0,0,0,0.18)",
                    }}
                  >
                    <div style={{ minWidth: 0 }}>
                      <div
                        style={{
                          fontWeight: 900,
                          fontSize: 13,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {l.id}
                      </div>
                      <div style={{ opacity: 0.75, fontSize: 12 }}>
                        Audio: <b>{l.audioEnabled ? "Da" : "Nu"}</b> · Stare:{" "}
                        <b>{l.state}</b>
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ marginTop: 10, opacity: 0.7, fontSize: 12 }}>
              Activi = audioEnabled și au trimis update în ultimele 30 secunde.
            </div>
          </div>
        </div>
      </div>

      <div
        style={{
          padding: 14,
          borderTop: "1px solid rgba(255,255,255,0.10)",
          opacity: 0.75,
          fontSize: 12,
        }}
      >
        Geneza Broadcast · Admin
      </div>
    </Shell>
  );
}
