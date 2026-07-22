export type JobStatus = "none" | "preparing" | "ready" | "error";

export interface SignClip {
  token: string;
  url: string;
  target_duration?: number;
}

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionChunk {
  video_id: string;
  session_id: string;
  chunk_index: number;
  status: string;
  video_time_offset: number;
  video_time_end: number;
  text: string;
  words: CaptionWord[];
  gloss: string[];
  clips: SignClip[];
  error?: string | null;
}

export interface PrepareStatus {
  video_id: string;
  status: JobStatus;
  error: string | null;
  title?: string | null;
  duration?: number | null;
  created_at?: number;
  cached?: boolean;
  stage?: string;
  progress?: number;
  source?: string;
}

export interface SessionSummary {
  video_id: string;
  session_id: string;
  title: string;
  status: Exclude<JobStatus, "none">;
  error: string | null;
  created_at: number;
  duration: number;
  chunk_count: number;
  sign_count: number;
  transcript_preview: string;
}

export interface SignEntry {
  word: string;
  url: string;
  source: string;
}

export interface SignPage {
  items: SignEntry[];
  matched_total: number;
  vocabulary_total: number;
  limit: number;
  offset: number;
}
