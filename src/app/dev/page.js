"use client";

import { useEffect, useState } from "react";
import { ref, get, set, update } from "firebase/database";
import { signOut } from "firebase/auth";
import { db, auth, ensureAnonAuth, ensureAdminAuth } from "../../lib/firebase"; // ajustează dacă ai alias

export default function DevPage() {
  const [log, setLog] = useState([]);
  const [uid, setUid] = useState(null);

  const pushLog = (msg) =>
    setLog((prev) => [...prev, `[${new Date().toLocaleTimeString()}] ${msg}`]);

  useEffect(() => {
    pushLog("Dev page loaded.");
    pushLog(`Current user: ${auth.currentUser?.uid || "none"}`);
  }, []);

  async function doSignOut() {
    try {
      await signOut(auth);
      setUid(null);
      pushLog("Signed out OK.");
    } catch (e) {
      pushLog(`Sign out failed: ${e?.message || String(e)}`);
    }
  }

  async function initBroadcastOnly() {
    try {
      const admin = await ensureAdminAuth();
      setUid(admin.uid);
      pushLog(`Admin auth OK. uid=${admin.uid}`);

      await update(ref(db, "broadcast"), {
        status: "idle",
        sessionId: "",
        offer: "",
        adminOnline: false,
      });

      pushLog("Init OK: broadcast initialized.");
      pushLog(
        "Note: candidates/* will be created automatically when ICE candidates appear.",
      );
    } catch (e) {
      pushLog(`Init failed: ${e?.message || String(e)}`);
    }
  }

  async function testAnonListenerWrite() {
    try {
      // IMPORTANT: if you are logged in as admin, sign out first to test anon
      const user = await ensureAnonAuth();
      setUid(user.uid);
      pushLog(`Anon auth OK. uid=${user.uid}`);

      await set(ref(db, `listeners/${user.uid}`), {
        state: "waiting",
        joinedAt: Date.now(),
        updatedAt: Date.now(),
      });

      pushLog("Anon write to listeners/<uid> OK.");
    } catch (e) {
      pushLog(`Anon test failed: ${e?.message || String(e)}`);
    }
  }

  async function testAdminBroadcastWrite() {
    try {
      const user = await ensureAdminAuth();
      setUid(user.uid);
      pushLog(`Admin auth OK. uid=${user.uid}`);

      await update(ref(db, "broadcast"), {
        status: "idle",
        sessionId: "dev-session",
        offer: "",
        adminOnline: true,
      });

      pushLog("Admin write to broadcast/* OK.");
    } catch (e) {
      pushLog(`Admin test failed: ${e?.message || String(e)}`);
    }
  }

  async function readRoot() {
    try {
      const snap = await get(ref(db, "/"));
      pushLog(`root read: ${JSON.stringify(snap.val())}`);
    } catch (e) {
      pushLog(`Read failed: ${e?.message || String(e)}`);
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: "system-ui" }}>
      <h1>Dev Smoke Test</h1>

      <div
        style={{ display: "flex", gap: 8, marginBottom: 12, flexWrap: "wrap" }}
      >
        <button onClick={doSignOut}>Sign Out</button>
        <button onClick={initBroadcastOnly}>Init Broadcast (Admin)</button>
        <button onClick={testAnonListenerWrite}>
          Test Anon Listener Write
        </button>
        <button onClick={testAdminBroadcastWrite}>
          Test Admin Broadcast Write
        </button>
        <button onClick={readRoot}>Read Root</button>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div>Current UID: {uid || auth.currentUser?.uid || "-"}</div>
      </div>

      <pre
        style={{
          background: "#111",
          color: "#0f0",
          padding: 12,
          borderRadius: 8,
          height: 320,
          overflow: "auto",
        }}
      >
        {log.join("\n")}
      </pre>
    </div>
  );
}
