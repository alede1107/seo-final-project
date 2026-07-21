import { createContext, useContext, useEffect, useState } from "react";
import { Link, NavLink, Outlet } from "react-router-dom";

import { checkHealth } from "../api";

type BackendState = "checking" | "connected" | "disconnected";

const BackendContext = createContext<BackendState>("checking");

export function useBackendStatus(): BackendState {
  return useContext(BackendContext);
}

const navigation = [
  { to: "/", label: "Prepare", end: true },
  { to: "/history", label: "History" },
  { to: "/signs", label: "Sign Library" },
  { to: "/references", label: "About" },
];

export default function Layout() {
  const [backend, setBackend] = useState<BackendState>("checking");
  const [menuOpen, setMenuOpen] = useState(false);

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
    <BackendContext.Provider value={backend}>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <div className="site-shell">
        <header className="site-header">
          <div className="header-inner">
            <Link className="brand" to="/" onClick={() => setMenuOpen(false)}>
              <span className="brand-mark" aria-hidden="true">
                <span />
                <span />
              </span>
              <span className="brand-copy">
                <strong>CaptionAid</strong>
                <small>companion</small>
              </span>
            </Link>

            <button
              className="menu-button"
              type="button"
              aria-expanded={menuOpen}
              aria-controls="primary-navigation"
              onClick={() => setMenuOpen((open) => !open)}
            >
              <span aria-hidden="true">{menuOpen ? "Close" : "Menu"}</span>
            </button>

            <nav
              id="primary-navigation"
              className={`primary-nav ${menuOpen ? "is-open" : ""}`}
              aria-label="Primary navigation"
            >
              {navigation.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  onClick={() => setMenuOpen(false)}
                  className={({ isActive }) => (isActive ? "active" : undefined)}
                >
                  {item.label}
                </NavLink>
              ))}
            </nav>

            <div className={`backend-pill ${backend}`} role="status" aria-live="polite">
              <span aria-hidden="true" />
              {backend === "checking"
                ? "Checking backend"
                : backend === "connected"
                  ? "Backend connected"
                  : "Backend offline"}
            </div>
          </div>
        </header>

        <main id="main-content" className="main-content">
          <Outlet />
        </main>

        <footer className="site-footer">
          <div>
            <strong>CaptionAid</strong>
            <span>Accessibility-first captions with supplementary ASL vocabulary clips.</span>
          </div>
          <p>Educational MVP. Not a replacement for a qualified ASL interpreter.</p>
        </footer>
      </div>
    </BackendContext.Provider>
  );
}
