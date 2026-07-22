// Shared by the popup, offscreen document, and YouTube content script.
// Local development wins when Flask is running; otherwise the unpacked
// extension talks to the stable production deployment.

(() => {
  const LOCAL_BACKEND = "http://localhost:5001";
  const PRODUCTION_BACKEND = "https://seo-final-project.vercel.app";
  let resolvedBackend = null;

  async function localBackendIsRunning() {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 600);
    try {
      const response = await fetch(`${LOCAL_BACKEND}/health`, {
        cache: "no-store",
        signal: controller.signal,
      });
      return response.ok;
    } catch (_) {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function resolveBackend() {
    if (resolvedBackend) return resolvedBackend;

    const stored = await chrome.storage.local.get("captionAidBackend");
    const override = String(stored.captionAidBackend || "").replace(/\/$/, "");
    if (override) {
      resolvedBackend = override;
      return resolvedBackend;
    }

    resolvedBackend = (await localBackendIsRunning())
      ? LOCAL_BACKEND
      : PRODUCTION_BACKEND;
    return resolvedBackend;
  }

  globalThis.CaptionAidConfig = Object.freeze({
    LOCAL_BACKEND,
    PRODUCTION_BACKEND,
    resolveBackend,
  });
})();
