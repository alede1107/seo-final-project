import type { PreparedTranscript } from "./types";

const REQUEST_SOURCE = "captionaid-website";
const RESPONSE_SOURCE = "captionaid-extension";

function requestBridge<T>(
  type: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const timer = window.setTimeout(() => {
      window.removeEventListener("message", receive);
      reject(new Error("CaptionAid extension is not connected"));
    }, timeoutMs);

    function receive(event: MessageEvent) {
      if (
        event.source !== window ||
        event.data?.source !== RESPONSE_SOURCE ||
        event.data?.requestId !== requestId
      ) {
        return;
      }
      window.clearTimeout(timer);
      window.removeEventListener("message", receive);
      resolve(event.data as T);
    }

    window.addEventListener("message", receive);
    window.postMessage({ source: REQUEST_SOURCE, requestId, type, ...payload }, window.location.origin);
  });
}

export async function getExtensionTranscript(videoId: string): Promise<PreparedTranscript> {
  await requestBridge("PING", {}, 1200);
  const result = await requestBridge<PreparedTranscript & { ok?: boolean; error?: string }>(
    "GET_YOUTUBE_TRANSCRIPT",
    { videoId },
    30_000,
  );
  if (!result.ok) throw new Error(result.error || "The extension could not read this transcript");
  if (!Array.isArray(result.captions) || !result.captions.length) {
    throw new Error("The extension returned an empty transcript");
  }
  return result;
}
