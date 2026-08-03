import type {
  CaptionChunk,
  PreparedTranscript,
  PrepareStatus,
  SessionSummary,
  SignPage,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

interface ErrorPayload {
  error?: string;
}

// The stable opaque app token (set by the auth layer after Firebase sign-in) is
// attached to every request so the backend can personalize responses per user.
// A JSON `body` still auto-sets Content-Type; FormData uploads deliberately do not.
let appToken: string | null = null;

export function setAppToken(token: string | null): void {
  appToken = token;
}

function authHeaders(): Record<string, string> {
  return appToken ? { "X-App-Token": appToken } : {};
}

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const isFormData =
    typeof FormData !== "undefined" && options?.body instanceof FormData;
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options?.body && !isFormData ? { "Content-Type": "application/json" } : {}),
      ...authHeaders(),
      ...options?.headers,
    },
  });
  const payload = (await response.json().catch(() => ({}))) as T & ErrorPayload;
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }
  return payload;
}

export async function checkHealth(signal?: AbortSignal): Promise<boolean> {
  try {
    const payload = await requestJson<{ ok: boolean }>("/api/health", { signal });
    return payload.ok;
  } catch {
    return false;
  }
}

export function startPreparation(videoId: string): Promise<PrepareStatus> {
  return requestJson<PrepareStatus>("/api/prepare", {
    method: "POST",
    body: JSON.stringify({ video_id: videoId }),
  });
}

export function startTranscriptPreparation(
  transcript: PreparedTranscript,
): Promise<PrepareStatus> {
  return requestJson<PrepareStatus>("/api/prepare/transcript", {
    method: "POST",
    body: JSON.stringify({
      video_id: transcript.videoId,
      title: transcript.title,
      duration: transcript.duration,
      captions: transcript.captions,
    }),
  });
}

export function getPreparation(videoId: string, signal?: AbortSignal): Promise<PrepareStatus> {
  return requestJson<PrepareStatus>(`/api/prepare/${encodeURIComponent(videoId)}`, { signal });
}

export async function getVideoCaptions(
  videoId: string,
  signal?: AbortSignal,
): Promise<CaptionChunk[]> {
  const payload = await requestJson<{ chunks: CaptionChunk[] }>(
    `/api/captions/video/${encodeURIComponent(videoId)}`,
    { signal },
  );
  return payload.chunks;
}

export async function getSessions(signal?: AbortSignal): Promise<SessionSummary[]> {
  const payload = await requestJson<{ items: SessionSummary[] }>("/api/sessions?limit=50", {
    signal,
  });
  return payload.items;
}

export function deletePreparedVideo(
  videoId: string,
): Promise<{ ok: boolean; video_id: string; captions_deleted: number }> {
  return requestJson(`/api/sessions/${encodeURIComponent(videoId)}`, {
    method: "DELETE",
  });
}

export function getSigns(
  query: string,
  letter: string,
  offset: number,
  signal?: AbortSignal,
): Promise<SignPage> {
  const params = new URLSearchParams({
    limit: "60",
    offset: String(offset),
  });
  if (query) params.set("q", query);
  if (letter) params.set("letter", letter);
  return requestJson<SignPage>(`/api/signs?${params}`, { signal });
}

export function createSessionToken(
  idToken: string,
  email?: string | null,
): Promise<{ app_token: string; email: string | null }> {
  return requestJson("/api/session-token", {
    method: "POST",
    body: JSON.stringify({ id_token: idToken, email: email ?? undefined }),
  });
}

export function getMe(
  signal?: AbortSignal,
): Promise<{ uid: string | null; signed_in: boolean }> {
  return requestJson("/api/me", { signal });
}
