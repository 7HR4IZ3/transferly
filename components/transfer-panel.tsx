"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { FileRow } from "./file-row";
import { Check, Download, FolderIcon, Plus, XIcon } from "./icons";
import { saveFiles, type Saveable } from "../lib/files";
import { formatBytes, formatRate } from "../lib/format";
import type { Route, Transfer } from "../lib/peer";

type Props = {
  live: boolean;
  peerLabel: string;
  route: Route | null;
  relayMaxBytes: number;
  transfers: Transfer[];
  onSend: (files: File[]) => void;
  onLeave: () => void;
  canPickFolder: boolean;
  folderName: string | null;
  onPickFolder: () => void;
  onClearFolder: () => void;
};

const savable = (item: Transfer) => item.direction === "in" && item.status === "done" && Boolean(item.blob) && item.storage !== "folder";

const asSaveable = (item: Transfer): Saveable => ({
  name: item.name,
  size: item.size,
  crc: item.crc,
  getBlob: async () => item.blob ?? null,
});

export function TransferPanel(props: Props) {
  const { live, transfers } = props;
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dragging, setDragging] = useState(false);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const active = transfers.some((item) => item.status === "active");
  // Tick once a second while something is moving, for speed / time left.
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const saveableItems = useMemo(() => transfers.filter(savable), [transfers]);
  const chosen = saveableItems.filter((item) => selected.has(item.id));
  const chosenBytes = chosen.reduce((total, item) => total + item.size, 0);
  const allChosen = saveableItems.length > 0 && chosen.length === saveableItems.length;

  const totals = useMemo(() => {
    const moving = transfers.filter((item) => item.status === "active" || item.status === "queued");
    return { count: moving.length, bytes: moving.reduce((sum, item) => sum + item.size - item.bytes, 0) };
  }, [transfers]);

  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const save = async (items: Transfer[]) => {
    setBusy(true);
    setNotice("");
    try {
      const summary = await saveFiles(items.map(asSaveable));
      if (summary) setNotice(summary);
      setSelected(new Set());
    } catch {
      setNotice("Couldn't save those files.");
    } finally {
      setBusy(false);
    }
  };

  const pick = (list: FileList | null) => {
    if (list?.length && live) props.onSend(Array.from(list));
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    pick(event.dataTransfer.files);
  };

  const hasFiles = transfers.length > 0;

  return (
    <div
      className="panel"
      onDragEnter={(event) => {
        event.preventDefault();
        if (live) setDragging(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={onDrop}
    >
      <div className="connected-head">
        <div>
          <p className="peer">
            <span className={"dot" + (live ? " dot-live" : "")} />
            {live ? "Connected" : "Disconnected"}
          </p>
          <p className="muted small">
            {live
              ? props.peerLabel + (props.route === "relay" ? " · through a relay" : props.route === "direct" ? " · direct" : "")
              : "The other device left. Received files are still here."}
          </p>
        </div>
        <button className="ghost-button" onClick={props.onLeave} type="button">
          {live ? "Disconnect" : "New connection"}
        </button>
      </div>

      {live ? (
        <button
          className={"drop" + (hasFiles ? " drop-compact" : "") + (dragging ? " drop-active" : "")}
          onClick={() => fileInputRef.current?.click()}
          type="button"
        >
          <span className="drop-icon">
            <Plus size={hasFiles ? 16 : 20} />
          </span>
          <span>
            <strong>{hasFiles ? "Send more files" : "Drop files to send"}</strong>
            <span className="drop-hint">{hasFiles ? " — or drop them anywhere here" : " or click to choose"}</span>
          </span>
          <input
            hidden
            multiple
            onChange={(event) => {
              pick(event.target.files);
              event.target.value = "";
            }}
            ref={fileInputRef}
            type="file"
          />
        </button>
      ) : null}

      {live ? (
        <div className="destination">
          <FolderIcon className="destination-icon" size={15} />
          {props.folderName ? (
            <span className="destination-text">
              Incoming files go straight into <strong>{props.folderName}</strong>
            </span>
          ) : (
            <span className="destination-text">Incoming files are saved to this device as they arrive</span>
          )}
          {props.canPickFolder ? (
            props.folderName ? (
              <button className="link-button" onClick={props.onClearFolder} type="button">
                Stop
              </button>
            ) : (
              <button className="link-button" onClick={props.onPickFolder} type="button">
                Choose a folder
              </button>
            )
          ) : null}
        </div>
      ) : null}

      {live && props.route === "relay" ? (
        <p className="muted small relay-note">
          Your networks couldn&apos;t connect directly, so this goes through a free relay. Files up to {formatBytes(props.relayMaxBytes)} can
          be sent. Use the same Wi-Fi for bigger files.
        </p>
      ) : null}

      {hasFiles ? (
        <section className="list-section">
          <div className="list-head">
            <p className="label">
              This session
              {totals.count ? (
                <span className="muted">
                  {" "}
                  · {totals.count} in progress, {formatBytes(totals.bytes)} to go
                </span>
              ) : null}
            </p>
            {saveableItems.length ? (
              <button className="link-button" onClick={() => setSelected(allChosen ? new Set() : new Set(saveableItems.map((item) => item.id)))} type="button">
                {allChosen ? "Clear selection" : "Select all"}
              </button>
            ) : null}
          </div>

          <ul className="rows">
            {transfers.map((item) => (
              <TransferItem
                item={item}
                key={item.direction + item.id}
                now={now}
                onSave={() => void save([item])}
                onSelect={(on) => toggle(item.id, on)}
                selected={selected.has(item.id)}
              />
            ))}
          </ul>
        </section>
      ) : live ? (
        <p className="muted small center">Files you send or receive will appear here.</p>
      ) : null}

      {notice ? <p className="status notice">{notice}</p> : null}

      {saveableItems.length > 1 || chosen.length ? (
        <div className="toolbar">
          <span className="muted small">
            {chosen.length ? `${chosen.length} selected · ${formatBytes(chosenBytes)}` : `${saveableItems.length} received files`}
          </span>
          <button className="primary-button" disabled={busy} onClick={() => void save(chosen.length ? chosen : saveableItems)} type="button">
            <Download size={15} /> {chosen.length ? "Save selected" : "Save all"}
          </button>
        </div>
      ) : null}

      {dragging ? <div className="drop-overlay">Drop to send</div> : null}
    </div>
  );
}

function TransferItem({
  item,
  now,
  selected,
  onSelect,
  onSave,
}: {
  item: Transfer;
  now: number;
  selected: boolean;
  onSelect: (on: boolean) => void;
  onSave: () => void;
}) {
  const incoming = item.direction === "in";
  const percent = item.size ? (item.bytes / item.size) * 100 : 100;

  let detail: string;
  if (item.status === "failed") detail = (item.note ?? "Failed") + " · " + formatBytes(item.size);
  else if (item.status === "queued") detail = "Waiting · " + formatBytes(item.size);
  else if (item.status === "active") {
    const rate = formatRate(item.bytes, item.size, item.startedAt, now || item.startedAt || 0);
    detail = formatBytes(item.bytes) + " of " + formatBytes(item.size) + (rate ? " · " + rate : "");
  } else if (incoming) {
    detail = formatBytes(item.size) + (item.storage === "folder" ? " · saved to " + (item.location ?? "folder") : "");
  } else detail = formatBytes(item.size) + " · Delivered";

  let action = null;
  if (item.status === "failed") action = <XIcon className="bad" size={18} />;
  else if (item.status === "active") action = <span className="muted small">{Math.floor(percent)}%</span>;
  else if (item.status === "done" && incoming && savable(item)) {
    action = (
      <button aria-label={"Save " + item.name} className="save" onClick={onSave} type="button">
        <Download size={15} /> <span className="save-label">Save</span>
      </button>
    );
  } else if (item.status === "done") action = <Check className="ok" size={18} />;

  return (
    <FileRow
      action={action}
      detail={detail}
      direction={item.direction}
      failed={item.status === "failed"}
      name={item.name}
      onSelect={onSelect}
      progress={item.status === "active" ? percent : undefined}
      selectable={savable(item)}
      selected={selected}
    />
  );
}
