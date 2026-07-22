(() => {
  const host = window.location.hostname;
  const isCaptionAidHost =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "seo-final-project.vercel.app" ||
    /^seo-final-project-[a-z0-9-]+-alejandroperdomo823-5997s-projects\.vercel\.app$/.test(host);
  if (!isCaptionAidHost) return;

  const REQUEST_SOURCE = "captionaid-website";
  const RESPONSE_SOURCE = "captionaid-extension";

  function respond(requestId, type, payload) {
    window.postMessage(
      { source: RESPONSE_SOURCE, requestId, type, ...payload },
      window.location.origin,
    );
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== REQUEST_SOURCE) return;
    const { requestId, type, videoId } = event.data;
    if (!requestId) return;

    if (type === "PING") {
      respond(requestId, "PONG", { ok: true });
      return;
    }
    if (type !== "GET_YOUTUBE_TRANSCRIPT") return;

    chrome.runtime
      .sendMessage({ type: "GET_YOUTUBE_TRANSCRIPT_REMOTE", videoId })
      .then((result) => respond(requestId, "YOUTUBE_TRANSCRIPT", result || { ok: false }))
      .catch((error) => respond(requestId, "YOUTUBE_TRANSCRIPT", {
        ok: false,
        error: error.message || "CaptionAid could not read this transcript",
      }));
  });
})();
