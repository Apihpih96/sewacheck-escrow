import { USDC_DECIMALS } from "./constants";
import { U64_MAX } from "./codec";

/**
 * Parses a human USDC amount ("12", "12.5", "0.000001") into base units (6 decimals) with
 * exact string arithmetic — never via floating point. Throws a user-readable Error.
 */
export function parseUsdc(input: string, decimals = USDC_DECIMALS): bigint {
  const s = input.trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Enter an amount like 1500 or 1500.50");
  const [whole = "0", frac = ""] = s.split(".");
  if (frac.length > decimals) throw new Error(`USDC has at most ${decimals} decimal places`);
  const v = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (v <= 0n) throw new Error("Amount must be greater than zero");
  if (v > U64_MAX) throw new Error("Amount is too large");
  return v;
}

/**
 * Like parseUsdc but also accepts zero ("0", "0.00"), for payouts where nothing to one side is a
 * valid choice (arbiter ruling, mutual release). Prefilled values come from formatUsdc, which
 * renders zero as "0.00".
 */
export function parseUsdcOrZero(input: string, decimals = USDC_DECIMALS): bigint {
  if (/^0*(\.0*)?$/.test(input.trim()) && /\d/.test(input)) return 0n;
  return parseUsdc(input, decimals);
}

/** Formats base units as a USDC string, trimming trailing zeros but keeping 2 decimals. */
export function formatUsdc(base: bigint, decimals = USDC_DECIMALS): string {
  const neg = base < 0n;
  const v = neg ? -base : base;
  const d = 10n ** BigInt(decimals);
  const whole = (v / d).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  let frac = (v % d).toString().padStart(decimals, "0").replace(/0+$/, "");
  if (frac.length < 2) frac = frac.padEnd(2, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** Parses a duration in days (decimals allowed) into whole seconds; "" or "0" => 0n (program default). */
export function parseDaysToSecs(input: string): bigint {
  const s = input.trim();
  if (s === "" || s === "0") return 0n;
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Windows are in days, e.g. 14 or 0.5");
  const secs = Math.round(Number(s) * 86400);
  if (!Number.isSafeInteger(secs) || secs < 0) throw new Error("Window is too large");
  if (secs === 0) throw new Error("Window is too small (minimum 1 second)");
  return BigInt(secs);
}
