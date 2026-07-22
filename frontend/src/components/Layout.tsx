import * as Tooltip from "@radix-ui/react-tooltip";
import { createContext, useContext, useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { checkHealth } from "../api";

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
        <div className="flex items-center gap-2 font-mono text-[11px] text-neutral-500" role="status">
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
          className="z-50 rounded-md border border-white/10 bg-neutral-900 px-2.5 py-1.5 font-mono text-[11px] text-neutral-300"
        >
          Flask API at 127.0.0.1:5001
          <Tooltip.Arrow className="fill-neutral-900" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
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
              mobile ? "h-10 px-3" : "h-10 px-3",
              isActive
                ? "bg-neutral-800 text-white"
                : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-200",
            ].join(" ")
          }
        >
          <span className="font-mono text-[10px] font-medium text-neutral-600 group-[.active]:text-accent">
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
          className="focus-ring fixed left-3 top-3 z-[100] -translate-y-20 rounded-md bg-white px-3 py-2 text-sm font-bold text-black focus:translate-y-0"
          href="#main-content"
        >
          Skip to content
        </a>

        <div className="min-h-screen bg-neutral-950 text-neutral-100 md:grid md:grid-cols-[224px_minmax(0,1fr)]">
          <aside className="sticky top-0 hidden h-screen flex-col border-r border-white/10 bg-[#0c0c0e] px-3 py-4 md:flex">
            <Link className="focus-ring flex h-12 items-center gap-3 rounded-md px-2" to="/">
              <span className="grid size-8 place-items-center rounded-md border border-white/15 bg-neutral-900 font-mono text-xs font-bold tracking-tight text-accent">
                CA
              </span>
              <span>
                <strong className="block text-sm font-extrabold tracking-tight">CaptionAid</strong>
                <small className="block font-mono text-[10px] text-neutral-600">learning workspace</small>
              </span>
            </Link>

            <div className="my-4 border-t border-white/10" />
            <Navigation />

            <div className="mt-auto space-y-3 border-t border-white/10 px-2 pt-4">
              <BackendStatus state={backend} />
              <p className="max-w-[170px] text-[11px] leading-4 text-neutral-600">
                Captions first. Vocabulary clips support learning and context.
              </p>
            </div>
          </aside>

          <div className="min-w-0">
            <header className="sticky top-0 z-40 border-b border-white/10 bg-neutral-950/95 backdrop-blur md:hidden">
              <div className="flex h-14 items-center justify-between px-4">
                <Link className="focus-ring flex items-center gap-2 rounded-md" to="/">
                  <span className="grid size-7 place-items-center rounded-md border border-white/15 font-mono text-[10px] font-bold text-accent">
                    CA
                  </span>
                  <strong className="text-sm font-extrabold tracking-tight">CaptionAid</strong>
                </Link>
                <BackendStatus state={backend} />
              </div>
              <div className="border-t border-white/10 px-2">
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
