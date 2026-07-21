import type {
  CaptionChunk,
  PrepareStatus,
  SessionSummary,
  SignPage,
} from "./types";

const API_BASE = (import.meta.env.VITE_API_BASE ?? "").replace(/\/$/, "");

interface ErrorPayload {
  error?: string;
}

async function requestJson<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...(options?.body ? { "Content-Type": "application/json" } : {}),
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
