"use client";

import { useEffect, useRef, useState } from "react";
import { ref, set, onValue, update } from "firebase/database";
import { ensureAnonAuth, db } from "../../lib/firebase";
import { ListenerWebRTCManager } from "../../lib/webrtc/listenerManager";

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function MeterMini({ value = 0 }) {
  const pct = Math.round(clamp01(value) * 100);
  return (
    <div style={{ width: "100%" }}>
      <div
        style={{
          height: 10,
          borderRadius: 999,
          background: "rgba(255,255,255,0.10)",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "rgba(255,255,255,0.75)",
          }}
        />
      </div>
    </div>
  );
}

export default function ListenPage() {
  const mgrRef = useRef(null);
  const [uid, setUid] = useState(null);

  const [broadcastStatus, setBroadcastStatus] = useState("idle");
  const [status, setStatus] = useState("waiting"); // waiting | connecting | connected

  const [audioEnabled, setAudioEnabled] = useState(false);
  const [muted, setMuted] = useState(false);

  const [level, setLevel] = useState(0);

  useEffect(() => {
    (async () => {
      const user = await ensureAnonAuth();
      setUid(user.uid);

      await set(ref(db, `listeners/${user.uid}`), {
        state: "waiting",
        joinedAt: Date.now(),
        updatedAt: Date.now(),
        audioEnabled: false,
        sessionId: "",
        answer: null,
      });
    })();

    return () => {
      mgrRef.current?.destroy?.();
      mgrRef.current = null;
    };
  }, []);

  useEffect(() => {
    const unsub = onValue(ref(db, "broadcast/status"), (snap) => {
      const v = snap.val() || "idle";
      setBroadcastStatus(v);
      if (v === "idle") setStatus("waiting");
    });
    return () => unsub();
  }, []);

  async function enableAudioFn() {
    if (!uid || audioEnabled) return;

    setAudioEnabled(true);

    await update(ref(db, `listeners/${uid}`), {
      audioEnabled: true,
      updatedAt: Date.now(),
    }).catch(() => {});

    if (!mgrRef.current) {
      mgrRef.current = new ListenerWebRTCManager({
        listenerId: uid,
        onStatus: (s) => setStatus(s),
        onLevel: (v) => setLevel(v),
        debug: false,
      });
    }

    await mgrRef.current.enableAudio();
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    mgrRef.current?.setMuted?.(next);
  }

  const header = "Biserica Geneza";
  const title =
    broadcastStatus === "idle"
      ? "Se așteaptă transmiterea…"
      : status === "connected"
        ? "Conectat (audio live)"
        : "Se conectează…";

  return (
    <div
      style={{
        minHeight: "100vh",
        background:
          "radial-gradient(900px 500px at 50% -10%, rgba(34,197,94,0.16), transparent), #0b1220",
        color: "white",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 18,
      }}
    >
      <div style={{ width: "100%", maxWidth: 520 }}>
        <div
          style={{
            borderRadius: 22,
            border: "1px solid rgba(255,255,255,0.10)",
            background: "rgba(255,255,255,0.05)",
            boxShadow: "0 20px 60px rgba(0,0,0,0.35)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: 18,
              borderBottom: "1px solid rgba(255,255,255,0.10)",
            }}
          >
            <div style={{ opacity: 0.75, fontSize: 13 }}>
              {header} · Ascultă
            </div>
            <div style={{ fontSize: 26, fontWeight: 900, marginTop: 4 }}>
              {title}
            </div>
          </div>

          <div style={{ padding: 18 }}>
            {!audioEnabled ? (
              <>
                <div style={{ opacity: 0.8, fontSize: 14, lineHeight: 1.45 }}>
                  Apasă pentru a activa sunetul (necesar pe iPhone/iOS).
                </div>

                <button
                  onClick={enableAudioFn}
                  style={{
                    marginTop: 14,
                    width: "100%",
                    padding: 16,
                    borderRadius: 16,
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: "rgba(59,130,246,0.35)",
                    color: "white",
                    fontWeight: 900,
                    fontSize: 16,
                    cursor: "pointer",
                  }}
                >
                  Activează Audio
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={toggleMute}
                  style={{
                    width: "100%",
                    padding: 14,
                    borderRadius: 16,
                    border: "1px solid rgba(255,255,255,0.14)",
                    background: muted
                      ? "rgba(59,130,246,0.35)"
                      : "rgba(0,0,0,0.25)",
                    color: "white",
                    fontWeight: 900,
                    fontSize: 16,
                    cursor: "pointer",
                  }}
                >
                  {muted ? "Play (Activează)" : "Mute (Oprește local)"}
                </button>

                <div style={{ marginTop: 14, opacity: 0.8, fontSize: 12 }}>
                  Nivel audio (recepție):
                </div>
                <div style={{ marginTop: 8 }}>
                  <MeterMini value={level} />
                </div>
              </>
            )}
          </div>

          <div
            style={{
              padding: 14,
              borderTop: "1px solid rgba(255,255,255,0.10)",
              opacity: 0.75,
              fontSize: 12,
            }}
          >
            Geneza Broadcast
          </div>
        </div>
      </div>
    </div>
  );
}
