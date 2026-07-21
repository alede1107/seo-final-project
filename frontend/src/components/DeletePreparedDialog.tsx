import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { useState } from "react";

import { deletePreparedVideo } from "../api";

interface DeletePreparedDialogProps {
  videoId: string;
  title: string;
  onDeleted: (videoId: string) => void;
}

export default function DeletePreparedDialog({
  videoId,
  title,
  onDeleted,
}: DeletePreparedDialogProps) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  const remove = async (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    setDeleting(true);
    setError("");
    try {
      await deletePreparedVideo(videoId);
      setOpen(false);
      onDeleted(videoId);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : "Could not delete this video.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (deleting) return;
        setOpen(nextOpen);
        if (nextOpen) setError("");
      }}
    >
      <AlertDialog.Trigger asChild>
        <button
          type="button"
          className="focus-ring h-9 rounded-md border border-red-400/20 px-3 text-xs font-bold text-red-300/80 transition-colors hover:bg-red-400/10 hover:text-red-200"
        >
          Delete
        </button>
      </AlertDialog.Trigger>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/80" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-white/10 bg-neutral-900 p-5 text-neutral-100 outline-none">
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-red-300/70">Delete prepared video</p>
          <AlertDialog.Title className="mt-2 text-base font-extrabold tracking-tight">
            Remove this video from History?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-6 text-neutral-500">
            <span className="block font-semibold text-neutral-300">{title}</span>
            This deletes its prepared transcript, gloss, and matched sign queue. Live-capture sessions, S3 audio, and the shared sign library stay untouched.
          </AlertDialog.Description>

          {error && (
            <p className="mt-4 border border-red-400/20 bg-red-400/5 px-3 py-2 text-xs leading-5 text-red-200/70" role="alert">
              {error}
            </p>
          )}

          <div className="mt-5 flex justify-end gap-2 border-t border-white/10 pt-4">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                disabled={deleting}
                className="focus-ring h-9 rounded-md border border-white/10 px-3 text-xs font-bold text-neutral-400 transition-colors hover:bg-neutral-800 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                disabled={deleting}
                onClick={remove}
                className="focus-ring h-9 rounded-md bg-red-400 px-3 text-xs font-extrabold text-neutral-950 transition-colors hover:bg-red-300 disabled:cursor-wait disabled:opacity-60"
              >
                {deleting ? "Deleting..." : "Delete video"}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
