"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { FileRow } from "./file-row";
import { ArrowLeft, Download, Trash } from "./icons";
import { openStored, saveFiles, type Saveable } from "../lib/files";
import { dayLabel, formatBytes, formatTime, spacedCode } from "../lib/format";
import { KEEP_DAYS, history, type HistoryEntry } from "../lib/history";

const NONE: HistoryEntry[] = [];
const stored = (entry: HistoryEntry) => entry.direction === "in" && entry.status === "done" && entry.storage === "opfs" && Boolean(entry.location);

const asSaveable = (entry: HistoryEntry): Saveable => ({
  name: entry.name,
  size: entry.size,
  crc: entry.crc,
  getBlob: () => openStored(entry.location!),
});

export function HistoryPanel({ onBack }: { onBack: () => void }) {
  const entries = useSyncExternalStore(history.subscribe, history.list, () => NONE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const keepable = useMemo(() => entries.filter(stored), [entries]);
  const storedBytes = keepable.reduce((total, entry) => total + entry.size, 0);
  const chosen = entries.filter((entry) => selected.has(entry.key));
  const chosenStored = chosen.filter(stored);

  const groups = useMemo(() => {
    const map = new Map<string, HistoryEntry[]>();
    for (const entry of entries) {
      const label = dayLabel(entry.at);
      map.set(label, [...(map.get(label) ?? []), entry]);
    }
    return [...map.entries()];
  }, [entries]);

  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const save = async (items: HistoryEntry[]) => {
    setBusy(true);
    setNotice("");
    try {
      const summary = await saveFiles(items.map(asSaveable));
      if (summary) setNotice(summary);
    } catch {
      setNotice("Couldn't save those files.");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (keys: string[]) => {
    await history.remove(keys);
    setSelected((current) => new Set([...current].filter((key) => !keys.includes(key))));
  };

  return (
    <div className="panel">
      <div className="connected-head">
        <div>
          <p className="peer">History</p>
          <p className="muted small">
            Received files stay on this device for {KEEP_DAYS} days{storedBytes ? ` · ${formatBytes(storedBytes)} stored` : ""}.
          </p>
        </div>
        <button className="ghost-button" onClick={onBack} type="button">
          <ArrowLeft size={14} /> Back
        </button>
      </div>

      {entries.length ? (
        <>
          <div className="list-head">
            <p className="label">
              {entries.length} transfer{entries.length === 1 ? "" : "s"}
            </p>
            <div className="list-actions">
              <button
                className="link-button"
                onClick={() => setSelected(selected.size === entries.length ? new Set() : new Set(entries.map((entry) => entry.key)))}
                type="button"
              >
                {selected.size === entries.length ? "Clear selection" : "Select all"}
              </button>
              <button
                className="link-button danger"
                onClick={() => {
                  if (window.confirm("Clear all history and delete stored files from this device?")) void history.clear();
                }}
                type="button"
              >
                Clear all
              </button>
            </div>
          </div>

          {groups.map(([label, items]) => (
            <section className="list-section" key={label}>
              <p className="group-label">{label}</p>
              <ul className="rows">
                {items.map((entry) => (
                  <FileRow
                    action={
                      <div className="row-buttons">
                        {stored(entry) ? (
                          <button className="icon-button small-icon" aria-label={"Save " + entry.name} onClick={() => void save([entry])} type="button">
                            <Download size={16} />
                          </button>
                        ) : null}
                        <button className="icon-button small-icon" aria-label={"Delete " + entry.name} onClick={() => void remove([entry.key])} type="button">
                          <Trash size={16} />
                        </button>
                      </div>
                    }
                    detail={describe(entry)}
                    direction={entry.direction}
                    failed={entry.status === "failed"}
                    key={entry.key}
                    name={entry.name}
                    onSelect={(on) => toggle(entry.key, on)}
                    selectable
                    selected={selected.has(entry.key)}
                  />
                ))}
              </ul>
            </section>
          ))}
        </>
      ) : (
        <div className="empty">
          <p className="request-title">Nothing here yet</p>
          <p className="muted small">Files you send or receive will show up here.</p>
        </div>
      )}

      {notice ? <p className="status notice">{notice}</p> : null}

      {chosen.length ? (
        <div className="toolbar">
          <span className="muted small">{chosen.length} selected</span>
          <div className="toolbar-buttons">
            <button className="ghost-button" onClick={() => void remove(chosen.map((entry) => entry.key))} type="button">
              <Trash size={15} /> Delete
            </button>
            <button className="primary-button" disabled={busy || !chosenStored.length} onClick={() => void save(chosenStored)} type="button">
              <Download size={15} /> Save{chosenStored.length && chosenStored.length !== chosen.length ? ` ${chosenStored.length}` : ""}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function describe(entry: HistoryEntry) {
  const parts = [formatBytes(entry.size)];
  if (entry.peer) parts.push((entry.direction === "in" ? "from " : "to ") + spacedCode(entry.peer));
  parts.push(formatTime(entry.at));
  if (entry.status === "failed") parts.push("failed");
  else if (entry.direction === "in") {
    if (entry.storage === "folder") parts.push("saved to " + (entry.location ?? "a folder"));
    else if (entry.storage !== "opfs") parts.push("no longer stored");
  }
  return parts.join(" · ");
}
