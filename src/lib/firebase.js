import { initializeApp, getApps } from "firebase/app";
import { getDatabase } from "firebase/database";
import {
  getAuth,
  signInAnonymously,
  signInWithEmailAndPassword,
} from "firebase/auth";

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  databaseURL: process.env.NEXT_PUBLIC_FIREBASE_DATABASE_URL,
};

export const app = getApps().length
  ? getApps()[0]
  : initializeApp(firebaseConfig);

export const db = getDatabase(app);
export const auth = getAuth(app);

// Listener (anonymous)
export async function ensureAnonAuth() {
  if (auth.currentUser) return auth.currentUser;
  const { user } = await signInAnonymously(auth);
  return user;
}

// Admin
export async function ensureAdminAuth() {
  if (auth.currentUser?.uid === process.env.NEXT_PUBLIC_ADMIN_UID) {
    return auth.currentUser;
  }

  const { user } = await signInWithEmailAndPassword(
    auth,
    process.env.NEXT_PUBLIC_ADMIN_EMAIL,
    process.env.NEXT_PUBLIC_ADMIN_PASSWORD,
  );

  return user;
}
