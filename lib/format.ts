export function formatBytes(bytes: number) {
  if (bytes < 1024) return bytes + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return (value >= 10 ? value.toFixed(0) : value.toFixed(1)) + " " + units[unit];
}

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  if (seconds < 60) return Math.max(1, Math.round(seconds)) + "s";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m " + String(Math.round(seconds % 60)).padStart(2, "0") + "s";
  return Math.floor(seconds / 3600) + "h " + String(Math.floor((seconds % 3600) / 60)).padStart(2, "0") + "m";
}

/** "2.1 MB/s · 12s left", from bytes so far and when the transfer started. */
export function formatRate(bytes: number, size: number, startedAt: number | undefined, now: number) {
  if (!startedAt) return "";
  const elapsed = (now - startedAt) / 1000;
  if (elapsed < 0.5 || bytes <= 0) return "";
  const rate = bytes / elapsed;
  return formatBytes(rate) + "/s · " + formatDuration((size - bytes) / rate) + " left";
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function dayLabel(at: number) {
  const date = new Date(at);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString([], { weekday: "long", day: "numeric", month: "short" });
}

/** "123456" → "123 456" */
export const spacedCode = (code: string) => (code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : code);
