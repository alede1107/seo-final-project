import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  onAuthStateChanged,
  signInWithPopup,
  signOut as firebaseSignOut,
  type User,
} from "firebase/auth";

import { createSessionToken, getMe, setAppToken as setApiAppToken } from "./api";
import { firebaseEnabled, getFirebaseAuth, googleProvider } from "./firebase";

const TOKEN_STORAGE_KEY = "captionaid.appToken";

interface AuthState {
  /** True only when a Firebase project is configured. */
  enabled: boolean;
  /** Firebase user, or null for a guest. */
  user: User | null;
  /** Stable opaque app token sent on every API request, or null for a guest. */
  appToken: string | null;
  /** True until the initial Firebase session has been resolved. */
  loading: boolean;
  error: string | null;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

function persistToken(token: string | null) {
  setApiAppToken(token);
  if (token) localStorage.setItem(TOKEN_STORAGE_KEY, token);
  else localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [appToken, setAppToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(firebaseEnabled);
  const [error, setError] = useState<string | null>(null);
  // Guards against exchanging the same Firebase session for a token twice.
  const exchangingRef = useRef(false);

  // Restore a previously issued app token immediately so API calls stay
  // authenticated before Firebase finishes rehydrating its session.
  useEffect(() => {
    const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) {
      setApiAppToken(stored);
      setAppToken(stored);
    }
  }, []);

  useEffect(() => {
    const auth = getFirebaseAuth();
    if (!auth) {
      setLoading(false);
      return;
    }
    return onAuthStateChanged(auth, async (nextUser) => {
      setUser(nextUser);
      setLoading(false);
      if (!nextUser) {
        persistToken(null);
        setAppToken(null);
        return;
      }
      // Exchange the Firebase identity for a stable app token. A stored token is
      // reused only if the backend still recognizes it — a reset backend DB can
      // leave a stale token that must be re-minted, otherwise the user looks
      // signed in but every API call is treated as a guest.
      if (exchangingRef.current) return;
      exchangingRef.current = true;
      try {
        const stored = localStorage.getItem(TOKEN_STORAGE_KEY);
        if (stored) {
          setApiAppToken(stored);
          try {
            const me = await getMe();
            if (me.signed_in) {
              setAppToken(stored);
              return;
            }
          } catch {
            // Fall through to re-mint below.
          }
        }
        const idToken = await nextUser.getIdToken();
        const { app_token } = await createSessionToken(idToken, nextUser.email);
        persistToken(app_token);
        setAppToken(app_token);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Sign-in failed");
      } finally {
        exchangingRef.current = false;
      }
    });
  }, []);

  const signInWithGoogle = useCallback(async () => {
    const auth = getFirebaseAuth();
    if (!auth) return;
    setError(null);
    try {
      await signInWithPopup(auth, googleProvider);
      // The onAuthStateChanged listener performs the token exchange.
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    }
  }, []);

  const signOut = useCallback(async () => {
    const auth = getFirebaseAuth();
    persistToken(null);
    setAppToken(null);
    setUser(null);
    if (auth) await firebaseSignOut(auth);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      enabled: firebaseEnabled,
      user,
      appToken,
      loading,
      error,
      signInWithGoogle,
      signOut,
    }),
    [user, appToken, loading, error, signInWithGoogle, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
