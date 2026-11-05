/**
 * All on-chain timestamps are Unix seconds (UTC). The UI converts at the edges only:
 * <input type="datetime-local"> values are wall-clock time in the browser's timezone.
 */

/** "2026-12-31T18:00" (browser-local wall clock) -> unix seconds. */
export function localInputToUnix(value: string): bigint {
  // Parse the parts explicitly: `new Date("YYYY-MM-DDTHH:mm")` is local time per spec, but
  // some engines have treated date-only/variant strings as UTC. Constructing from parts is
  // unambiguous.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!m) throw new Error("Pick a lease end date and time");
  const [, y, mo, d, h, mi, s] = m;
  const date = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
  const t = date.getTime();
  if (!Number.isFinite(t)) throw new Error("Invalid date");
  return BigInt(Math.floor(t / 1000));
}

/** unix seconds -> "YYYY-MM-DDTHH:mm" in the browser's local timezone (for input defaults). */
export function unixToLocalInput(unix: number): string {
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Human date in the viewer's timezone with the zone name shown. */
export function formatTs(unix: bigint | number, timeZone?: string): string {
  const d = new Date(Number(unix) * 1000);
  return d.toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
    timeZoneName: "short",
  });
}

/** "3d 4h", "12m 05s", or "now". */
export function formatDuration(secs: number): string {
  if (secs <= 0) return "now";
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

export function windowLabel(secs: bigint): string {
  const n = Number(secs);
  if (n % 86400 === 0) return `${n / 86400} day${n === 86400 ? "" : "s"}`;
  return formatDuration(n);
}
