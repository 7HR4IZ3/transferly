"use client";

import type { ReactNode } from "react";
import { ArrowDown, ArrowUp } from "./icons";

/** One file in a list: optional checkbox, direction badge, name, details, progress and an action. */
export function FileRow({
  direction,
  name,
  detail,
  progress,
  failed,
  selectable,
  selected,
  onSelect,
  action,
}: {
  direction: "in" | "out";
  name: string;
  detail: ReactNode;
  /** 0–100 while active; omitted otherwise. */
  progress?: number;
  failed?: boolean;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (selected: boolean) => void;
  action?: ReactNode;
}) {
  const incoming = direction === "in";
  return (
    <li className={"row" + (failed ? " row-failed" : "") + (selected ? " row-selected" : "")}>
      {selectable ? (
        <input
          aria-label={"Select " + name}
          checked={Boolean(selected)}
          className="check"
          onChange={(event) => onSelect?.(event.target.checked)}
          type="checkbox"
        />
      ) : (
        <span className="check-space" aria-hidden />
      )}
      <span className={"badge" + (incoming ? " badge-in" : "")} aria-label={incoming ? "Received" : "Sent"}>
        {incoming ? <ArrowDown size={15} /> : <ArrowUp size={15} />}
      </span>
      <div className="row-body">
        <p className="row-name" title={name}>
          {name}
        </p>
        <p className="muted small row-detail">{detail}</p>
        {progress !== undefined ? (
          <div className="bar">
            <div className="bar-fill" style={{ width: Math.min(100, progress) + "%" }} />
          </div>
        ) : null}
      </div>
      {action ? <div className="row-action">{action}</div> : null}
    </li>
  );
}
