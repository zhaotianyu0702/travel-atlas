"use client";

import { useEffect, useRef } from "react";
import type { Trip } from "@/lib/types";

export default function DeleteTripDialog({ trip, busy, error, onClose, onDelete }: {
  trip: Trip; busy: boolean; error: string; onClose: () => void; onDelete: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = dialog.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return <dialog ref={dialog} className="delete-trip-dialog" aria-labelledby="delete-trip-title" aria-describedby="delete-trip-impact"
    onCancel={e => { e.preventDefault(); if (!busy) onClose(); }}>
    <h2 id="delete-trip-title">Delete “{trip.title}”?</h2>
    <p id="delete-trip-impact">This permanently deletes this trip’s Atlas photos, including its trash, and its recaps. Recaps spanning trips keep their other photos.</p>
    {error && <p role="alert">{error}</p>}
    <div className="drawer-actions">
      <button className="secondary" type="button" autoFocus disabled={busy} onClick={onClose}>Cancel</button>
      <button className="trip-delete-confirm" type="button" disabled={busy} onClick={onDelete}>{busy ? "Deleting…" : "Delete trip"}</button>
    </div>
  </dialog>;
}
