import * as Dialog from "@radix-ui/react-dialog";
import * as Tabs from "@radix-ui/react-tabs";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  deletePersonalClip,
  preferPersonalClip,
  uploadPersonalClip,
} from "../api";
import { useAuth } from "../auth";
import type { PersonalClip } from "../types";

interface AddClipDialogProps {
  /** The (normalized) gloss word to add a sign for; null keeps the dialog closed. */
  word: string | null;
  /** Whether the fixed vocabulary already has a default clip for this word. */
  hasDefault: boolean;
  /** The signed-in user's existing personal clips for this word. */
  existingClips: PersonalClip[];
  onOpenChange: (open: boolean) => void;
  /** Called after any change (upload / prefer / delete) so the parent can refetch. */
  onSaved: () => void;
}

// Client-side clip constraints. The backend only enforces MIME + a 15 MB hard
// cap, so duration and orientation are validated here (see plan/master-plan.md).
const MAX_DURATION_S = 5.2;
const MIN_ASPECT_RATIO = 1.2; // landscape only
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB target (server hard-caps at 15 MB)
const RECORD_LIMIT_MS = 5000;

interface ClipMeta {
  duration: number;
  width: number;
  height: number;
}

/**
 * Read a clip's duration + dimensions. `MediaRecorder` WebM blobs ship without a
 * duration in the header, so `video.duration` is `Infinity` until we seek to the
 * end — that forces the browser to compute the real duration. Resolves null if
 * the video can't be decoded at all.
 */
function readVideoMeta(blob: Blob): Promise<ClipMeta | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;

    let settled = false;
    const finish = (result: ClipMeta | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
      resolve(result);
    };
    // Safety net: if no event fires, resolve with whatever we have.
    const timer = window.setTimeout(() => {
      finish(
        Number.isFinite(video.duration) && video.duration > 0
          ? { duration: video.duration, width: video.videoWidth, height: video.videoHeight }
          : null,
      );
    }, 3000);

    const emit = () =>
      finish({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });

    video.onloadedmetadata = () => {
      if (video.duration === Infinity || Number.isNaN(video.duration)) {
        video.onseeked = emit;
        // Seek past the end; the browser clamps and updates duration.
        video.currentTime = 1e101;
      } else {
        emit();
      }
    };
    video.onerror = () => finish(null);
    video.src = url;
  });
}

/** Validate a clip. Resolves to an error string, or null when valid. */
async function validateClip(blob: Blob): Promise<string | null> {
  if (blob.size > MAX_BYTES) {
    return "Clip is larger than 10 MB. Record or trim a shorter clip.";
  }
  const meta = await readVideoMeta(blob);
  if (!meta || !Number.isFinite(meta.duration) || meta.duration <= 0) {
    return "Could not read this video. Use a webm or mp4 file.";
  }
  if (meta.duration > MAX_DURATION_S) {
    return `Clip is ${meta.duration.toFixed(1)}s. Keep it to 5 seconds or less.`;
  }
  if (!meta.width || !meta.height || meta.width / meta.height < MIN_ASPECT_RATIO) {
    return "Clip must be horizontal (landscape). Rotate your camera and try again.";
  }
  return null;
}

export default function AddClipDialog({
  word,
  hasDefault,
  existingClips,
  onOpenChange,
  onSaved,
}: AddClipDialogProps) {
  const { user, appToken, enabled, signInWithGoogle } = useAuth();
  const open = word !== null;
  // The upload API is authorized by the app token, not merely by a Firebase
  // session — a signed-in user with no app token would 401 on submit.
  const canUpload = Boolean(user && appToken);

  const [tab, setTab] = useState<"upload" | "record">("upload");
  const [clip, setClip] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busyClipId, setBusyClipId] = useState<string | null>(null);

  // Recording state
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [recording, setRecording] = useState(false);
  const liveVideoRef = useRef<HTMLVideoElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<number | null>(null);

  const stopStream = useCallback(() => {
    if (stopTimerRef.current) {
      window.clearTimeout(stopTimerRef.current);
      stopTimerRef.current = null;
    }
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
    recorderRef.current = null;
    setStream((current) => {
      current?.getTracks().forEach((track) => track.stop());
      return null;
    });
    setRecording(false);
  }, []);

  const resetClip = useCallback(() => {
    setClip(null);
    setValidationError(null);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  }, []);

  // Reset everything when the dialog closes.
  useEffect(() => {
    if (open) return;
    stopStream();
    resetClip();
    setTab("upload");
    setError(null);
    setSubmitting(false);
    setBusyClipId(null);
  }, [open, stopStream, resetClip]);

  // Release object URLs + camera on unmount.
  useEffect(() => () => {
    stopStream();
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Attach the live camera stream to the preview element.
  useEffect(() => {
    if (liveVideoRef.current && stream) {
      liveVideoRef.current.srcObject = stream;
    }
  }, [stream]);

  const acceptClip = useCallback(async (blob: Blob) => {
    const problem = await validateClip(blob);
    if (problem) {
      setValidationError(problem);
      setClip(null);
      setPreviewUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return null;
      });
      return;
    }
    setValidationError(null);
    setClip(blob);
    setPreviewUrl((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(blob);
    });
  }, []);

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) await acceptClip(file);
  };

  const startCamera = async () => {
    setError(null);
    resetClip();
    try {
      const media = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", aspectRatio: 16 / 9 },
        audio: false,
      });
      setStream(media);
    } catch {
      setError("Could not access the camera. Grant permission and try again.");
    }
  };

  const startRecording = () => {
    if (!stream) return;
    chunksRef.current = [];
    const mime = MediaRecorder.isTypeSupported("video/webm") ? "video/webm" : "";
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(chunksRef.current, { type: "video/webm" });
      void acceptClip(blob);
      stopStream();
    };
    recorderRef.current = recorder;
    recorder.start();
    setRecording(true);
    // Auto-stop at the 5s limit.
    stopTimerRef.current = window.setTimeout(() => {
      if (recorderRef.current && recorderRef.current.state !== "inactive") {
        recorderRef.current.stop();
      }
    }, RECORD_LIMIT_MS);
  };

  const stopRecording = () => {
    if (recorderRef.current && recorderRef.current.state !== "inactive") {
      recorderRef.current.stop();
    }
  };

  const submit = async () => {
    if (!clip || !word) return;
    setSubmitting(true);
    setError(null);
    try {
      await uploadPersonalClip(word, clip);
      onSaved();
      onOpenChange(false);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Upload failed.");
    } finally {
      setSubmitting(false);
    }
  };

  const runClipAction = async (action: () => Promise<unknown>, clipId: string) => {
    setBusyClipId(clipId);
    setError(null);
    try {
      await action();
      onSaved();
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : "Could not update clip.");
    } finally {
      setBusyClipId(null);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/75" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border border-border bg-surface-strong p-0 text-foreground outline-none">
          <div className="border-b border-border px-5 py-4">
            <div className="flex items-start justify-between gap-6">
              <div>
                <Dialog.Title className="text-base font-extrabold tracking-tight">
                  Add a sign for “{word}”
                </Dialog.Title>
                <Dialog.Description className="mt-1 text-sm leading-5 text-muted">
                  {hasDefault
                    ? "This word has a default sign. Add your own and mark it preferred to use it instead."
                    : "This word has no sign clip yet. Upload or record one — only you will see it."}
                </Dialog.Description>
              </div>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close"
                  className="focus-ring grid size-10 shrink-0 place-items-center rounded-md border border-border font-mono text-sm text-muted transition-colors hover:bg-surface-active hover:text-foreground"
                >
                  X
                </button>
              </Dialog.Close>
            </div>
          </div>

          {!canUpload ? (
            <div className="space-y-4 px-5 py-6 text-center">
              {user ? (
                <p className="text-sm leading-6 text-danger">
                  Signed in, but the server could not establish a session for uploads. This usually means the
                  backend is missing its Firebase verification credentials. Try signing out and back in.
                </p>
              ) : (
                <>
                  <p className="text-sm leading-6 text-muted">
                    Sign in to add your own sign clips. They stay private to your account.
                  </p>
                  {enabled ? (
                    <button
                      type="button"
                      onClick={() => void signInWithGoogle()}
                      className="focus-ring inline-flex h-10 items-center justify-center rounded-md border border-border bg-surface px-4 text-sm font-semibold text-foreground transition-colors hover:bg-surface-active"
                    >
                      Sign in with Google
                    </button>
                  ) : (
                    <p className="font-mono text-[11px] text-muted">
                      Sign-in is not configured on this deployment.
                    </p>
                  )}
                </>
              )}
            </div>
          ) : (
            <div className="space-y-5 px-5 py-5">
              {existingClips.length > 0 && (
                <div className="space-y-2">
                  <p className="font-mono text-[11px] uppercase tracking-wider text-muted">
                    Your clips for this word
                  </p>
                  <ul className="space-y-2">
                    {existingClips.map((personal) => (
                      <li
                        key={personal.clip_id}
                        className="flex items-center gap-3 border border-border bg-background/50 p-2"
                      >
                        <video
                          src={personal.url}
                          muted
                          playsInline
                          controls
                          className="h-14 w-24 shrink-0 rounded bg-black object-cover"
                        />
                        <span className="flex-1 text-xs text-foreground">
                          {personal.preferred ? (
                            <span className="font-semibold text-accent">Preferred</span>
                          ) : (
                            <span className="text-muted">Saved</span>
                          )}
                        </span>
                        {!personal.preferred && (
                          <button
                            type="button"
                            disabled={busyClipId === personal.clip_id}
                            onClick={() =>
                              void runClipAction(
                                () => preferPersonalClip(personal.clip_id),
                                personal.clip_id,
                              )
                            }
                            className="focus-ring h-10 rounded-md border border-border px-2.5 text-xs font-semibold text-foreground transition-colors hover:bg-surface-active disabled:opacity-50"
                          >
                            Prefer
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busyClipId === personal.clip_id}
                          onClick={() =>
                            void runClipAction(
                              () => deletePersonalClip(personal.clip_id),
                              personal.clip_id,
                            )
                          }
                          className="focus-ring h-10 rounded-md border border-border px-2.5 text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-50"
                        >
                          Delete
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <Tabs.Root value={tab} onValueChange={(value) => setTab(value as "upload" | "record")}>
                <Tabs.List
                  className="inline-flex w-fit rounded-md border border-border bg-background p-0.5"
                  aria-label="Add a clip"
                >
                  <Tabs.Trigger
                    value="upload"
                    className="focus-ring h-9 rounded-[4px] px-3 text-xs font-bold text-muted transition-colors data-[state=active]:bg-surface-active data-[state=active]:text-foreground"
                  >
                    Upload
                  </Tabs.Trigger>
                  <Tabs.Trigger
                    value="record"
                    className="focus-ring h-9 rounded-[4px] px-3 text-xs font-bold text-muted transition-colors data-[state=active]:bg-surface-active data-[state=active]:text-foreground"
                  >
                    Record
                  </Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="upload" className="mt-4 outline-none">
                  <label className="block">
                    <span className="mb-2 block font-mono text-[11px] uppercase tracking-wider text-muted">
                      Choose a horizontal clip (≤ 5s, webm or mp4)
                    </span>
                    <input
                      type="file"
                      accept="video/webm,video/mp4"
                      onChange={onFile}
                      className="focus-ring block w-full rounded-md border border-border bg-background px-3 py-2.5 text-xs text-foreground file:mr-3 file:rounded file:border-0 file:bg-surface-active file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-foreground"
                    />
                  </label>
                </Tabs.Content>

                <Tabs.Content value="record" className="mt-4 outline-none">
                  <div className="space-y-3">
                    {!stream && !clip && (
                      <button
                        type="button"
                        onClick={() => void startCamera()}
                        className="focus-ring h-10 rounded-md border border-border bg-surface px-4 text-sm font-semibold text-foreground transition-colors hover:bg-surface-active"
                      >
                        Start camera
                      </button>
                    )}
                    {stream && (
                      <div className="space-y-3">
                        <video
                          ref={liveVideoRef}
                          autoPlay
                          muted
                          playsInline
                          className="aspect-video w-full rounded-md bg-black"
                        />
                        <div className="flex items-center gap-2">
                          {!recording ? (
                            <button
                              type="button"
                              onClick={startRecording}
                              className="focus-ring h-10 rounded-md bg-accent px-4 text-sm font-bold text-accent-contrast transition-colors hover:bg-accent-strong"
                            >
                              Record
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={stopRecording}
                              className="focus-ring h-10 rounded-md bg-danger px-4 text-sm font-bold text-background transition-colors"
                            >
                              Stop
                            </button>
                          )}
                          <span className="font-mono text-[11px] text-muted">
                            {recording ? "Recording… auto-stops at 5s" : "Up to 5 seconds"}
                          </span>
                        </div>
                      </div>
                    )}
                  </div>
                </Tabs.Content>
              </Tabs.Root>

              {previewUrl && (
                <div className="space-y-2">
                  <p className="font-mono text-[11px] uppercase tracking-wider text-muted">Preview</p>
                  <video
                    src={previewUrl}
                    controls
                    playsInline
                    className="aspect-video w-full rounded-md bg-black"
                  />
                </div>
              )}

              {validationError && (
                <p role="alert" className="text-xs leading-5 text-danger">
                  {validationError}
                </p>
              )}
              {error && (
                <div className="border border-danger/30 bg-danger/10 px-3 py-2.5" role="alert">
                  <p className="text-xs leading-5 text-danger">{error}</p>
                </div>
              )}

              <div className="flex items-center justify-end gap-3 border-t border-border pt-4">
                <Dialog.Close asChild>
                  <button
                    type="button"
                    className="focus-ring h-10 rounded-md border border-border px-4 text-sm font-semibold text-muted transition-colors hover:bg-surface-active hover:text-foreground"
                  >
                    Cancel
                  </button>
                </Dialog.Close>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={!clip || submitting}
                  className="focus-ring h-10 rounded-md bg-accent px-4 text-sm font-extrabold text-accent-contrast transition-colors hover:bg-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {submitting ? "Saving…" : "Save clip"}
                </button>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
