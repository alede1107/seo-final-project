// Shared by the popup, offscreen document, and YouTube content script.
// Production is the default so the extension and companion website never
// split their data between localhost and Vercel.

(() => {
  const LOCAL_BACKEND = "http://localhost:5001";
  const PRODUCTION_BACKEND = "https://seo-final-project.vercel.app";
  let resolvedBackend = null;

  async function resolveBackend() {
    if (resolvedBackend) return resolvedBackend;

    const stored = await chrome.storage.local.get("captionAidBackend");
    const override = String(stored.captionAidBackend || "").replace(/\/$/, "");
    if (override) {
      resolvedBackend = override;
      return resolvedBackend;
    }

    resolvedBackend = PRODUCTION_BACKEND;
    return resolvedBackend;
  }

  globalThis.CaptionAidConfig = Object.freeze({
    LOCAL_BACKEND,
    PRODUCTION_BACKEND,
    resolveBackend,
  });
})();
