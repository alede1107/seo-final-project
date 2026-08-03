import * as Tooltip from "@radix-ui/react-tooltip";
import { createContext, useContext, useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { checkHealth } from "../api";
import { useAuth } from "../auth";
import ThemeToggle from "./ThemeToggle";

type BackendState = "checking" | "connected" | "disconnected";

const BackendContext = createContext<BackendState>("checking");

export function useBackendStatus(): BackendState {
  return useContext(BackendContext);
}

const navigation = [
  { to: "/", label: "History", index: "01", end: true },
  { to: "/signs", label: "Sign library", index: "02", end: false },
];

function BackendStatus({ state }: { state: BackendState }) {
  const label =
    state === "connected" ? "Backend online" : state === "disconnected" ? "Backend offline" : "Checking backend";

  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>
        <div className="flex items-center gap-2 font-mono text-[11px] text-muted" role="status">
          <span
            className={`size-1.5 rounded-full ${
              state === "connected"
                ? "bg-accent"
                : state === "disconnected"
                  ? "bg-red-400"
                  : "animate-pulse bg-amber-300"
            }`}
          />
          <span className="hidden min-[430px]:inline">{label}</span>
        </div>
      </Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          sideOffset={8}
          className="z-50 rounded-md border border-border bg-surface-strong px-2.5 py-1.5 font-mono text-[11px] text-foreground"
        >
          Flask API at 127.0.0.1:5001
          <Tooltip.Arrow className="fill-surface-strong" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function AccountControl({ compact = false }: { compact?: boolean }) {
  const { enabled, user, loading, error, signInWithGoogle, signOut } = useAuth();

  // With no Firebase project configured the site is guest-only; hide the control.
  if (!enabled) return null;

  if (user) {
    return (
      <div className={compact ? "flex items-center gap-2" : "space-y-1.5"}>
        {!compact && (
          <p className="truncate font-mono text-[11px] text-muted" title={user.email ?? undefined}>
            {user.email ?? "Signed in"}
          </p>
        )}
        <button
          type="button"
          onClick={() => void signOut()}
          className="focus-ring flex h-10 items-center gap-2 rounded-md border border-border px-3 text-xs font-semibold text-muted transition-colors hover:bg-surface hover:text-foreground"
        >
          <span aria-hidden className="size-1.5 rounded-full bg-accent" />
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className={compact ? "" : "space-y-1.5"}>
      <button
        type="button"
        onClick={() => void signInWithGoogle()}
        disabled={loading}
        className="focus-ring flex h-10 items-center gap-2 rounded-md border border-border bg-surface-strong px-3 text-xs font-semibold text-foreground transition-colors hover:bg-surface-active disabled:opacity-60"
      >
        <GoogleGlyph />
        Sign in with Google
      </button>
      {error && !compact && (
        <p role="alert" className="text-[11px] leading-4 text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

function GoogleGlyph() {
  return (
    <svg aria-hidden viewBox="0 0 48 48" className="size-4">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.6 2.4 30.1 0 24 0 14.6 0 6.5 5.4 2.6 13.2l7.9 6.1C12.4 13.2 17.7 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.7c-.5 3-2.2 5.5-4.7 7.2l7.3 5.7C43.9 37.9 46.5 31.8 46.5 24.5z" />
      <path fill="#FBBC05" d="M10.5 28.3a14.5 14.5 0 0 1 0-8.6l-7.9-6.1a24 24 0 0 0 0 20.8l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.1 0 11.3-2 15-5.5l-7.3-5.7c-2 1.4-4.7 2.2-7.7 2.2-6.3 0-11.6-3.7-13.5-9l-7.9 6.1C6.5 42.6 14.6 48 24 48z" />
    </svg>
  );
}

function Navigation({ mobile = false }: { mobile?: boolean }) {
  return (
    <nav className={mobile ? "flex items-center" : "space-y-1"} aria-label="Primary navigation">
      {navigation.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) =>
            [
              "focus-ring group flex items-center gap-3 rounded-md text-sm font-semibold transition-colors",
              "h-10 px-3",
              isActive
                ? "bg-surface-active text-foreground"
                : "text-muted hover:bg-surface hover:text-foreground",
            ].join(" ")
          }
        >
          <span className="font-mono text-[11px] font-medium text-muted/60 group-[.active]:text-accent">
            {item.index}
          </span>
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

export default function Layout() {
  const [backend, setBackend] = useState<BackendState>("checking");

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const connected = await checkHealth();
      if (active) setBackend(connected ? "connected" : "disconnected");
    };

    void refresh();
    const timer = window.setInterval(refresh, 15000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <Tooltip.Provider delayDuration={250}>
      <BackendContext.Provider value={backend}>
        <a
          className="focus-ring fixed left-3 top-3 z-[100] -translate-y-20 rounded-md bg-accent px-3 py-2 text-sm font-bold text-accent-contrast focus:translate-y-0"
          href="#main-content"
        >
          Skip to content
        </a>

        <div className="min-h-screen bg-background text-foreground md:grid md:grid-cols-[224px_minmax(0,1fr)]">
          <aside className="sticky top-0 hidden h-screen flex-col border-r border-border bg-surface px-3 py-4 md:flex">
            <Link className="focus-ring flex h-12 items-center gap-3 rounded-md px-2" to="/">
              <span className="grid size-8 place-items-center rounded-md border border-border bg-surface-strong font-mono text-xs font-bold tracking-tight text-accent">
                CA
              </span>
              <span>
                <strong className="block text-sm font-extrabold tracking-tight">CaptionAid</strong>
                <small className="block font-mono text-[11px] text-muted">learning workspace</small>
              </span>
            </Link>

            <div className="my-4 border-t border-border" />
            <Navigation />

            <div className="mt-auto space-y-3 border-t border-border px-2 pt-4">
              <BackendStatus state={backend} />
              <AccountControl />
              <ThemeToggle />
              <p className="max-w-[170px] text-[11px] leading-4 text-muted">
                Captions first. Vocabulary clips support learning and context.
              </p>
            </div>
          </aside>

          <div className="min-w-0">
            <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur md:hidden">
              <div className="flex h-14 items-center justify-between px-4">
                <Link className="focus-ring flex items-center gap-2 rounded-md" to="/">
                  <span className="grid size-7 place-items-center rounded-md border border-border font-mono text-[10px] font-bold text-accent">
                    CA
                  </span>
                  <strong className="text-sm font-extrabold tracking-tight">CaptionAid</strong>
                </Link>
                <div className="flex items-center gap-3">
                  <BackendStatus state={backend} />
                  <AccountControl compact />
                  <ThemeToggle />
                </div>
              </div>
              <div className="border-t border-border px-2">
                <Navigation mobile />
              </div>
            </header>

            <main id="main-content" className="min-h-screen min-w-0 overflow-x-clip">
              <Outlet />
            </main>
          </div>
        </div>
      </BackendContext.Provider>
    </Tooltip.Provider>
  );
}
