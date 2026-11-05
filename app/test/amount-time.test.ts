import { describe, expect, it, beforeAll } from "vitest";
import { formatUsdc, parseDaysToSecs, parseUsdc } from "../src/lib/amount";
import { formatDuration, localInputToUnix, unixToLocalInput } from "../src/lib/time";

describe("USDC amounts (6 decimals, no floats)", () => {
  it("parses exactly", () => {
    expect(parseUsdc("1")).toBe(1_000_000n);
    expect(parseUsdc("5400")).toBe(5_400_000_000n);
    expect(parseUsdc("0.1")).toBe(100_000n);
    expect(parseUsdc("0.000001")).toBe(1n);
    expect(parseUsdc("1,234.5")).toBe(1_234_500_000n);
    // 0.1 + 0.2 style float traps
    expect(parseUsdc("0.3")).toBe(300_000n);
    expect(parseUsdc("18446744073709.551615")).toBe((1n << 64n) - 1n);
  });
  it("rejects bad input", () => {
    for (const bad of ["", "abc", "-1", "1e6", "0", "0.0000001", "1.2.3", "18446744073709.551616", " . "]) {
      expect(() => parseUsdc(bad), bad).toThrow();
    }
  });
  it("formats", () => {
    expect(formatUsdc(1_000_000n)).toBe("1.00");
    expect(formatUsdc(250_000n)).toBe("0.25");
    expect(formatUsdc(1n)).toBe("0.000001");
    expect(formatUsdc(5_400_000_000n)).toBe("5,400.00");
    expect(formatUsdc((1n << 64n) - 1n)).toBe("18,446,744,073,709.551615");
  });
  it("days to seconds; empty/0 = program default", () => {
    expect(parseDaysToSecs("")).toBe(0n);
    expect(parseDaysToSecs("0")).toBe(0n);
    expect(parseDaysToSecs("14")).toBe(1_209_600n);
    expect(parseDaysToSecs("0.5")).toBe(43_200n);
    expect(() => parseDaysToSecs("-1")).toThrow();
    expect(() => parseDaysToSecs("0.000000001")).toThrow(/too small/);
  });
});

describe("timezones", () => {
  beforeAll(() => {
    process.env.TZ = "Asia/Kuala_Lumpur";
  });
  it("datetime-local is interpreted in the browser's zone (MYT = UTC+8)", () => {
    // 2026-12-31 18:00 MYT == 2026-12-31 10:00 UTC
    expect(localInputToUnix("2026-12-31T18:00")).toBe(BigInt(Date.UTC(2026, 11, 31, 10, 0) / 1000));
    expect(unixToLocalInput(Date.UTC(2026, 11, 31, 10, 0) / 1000)).toBe("2026-12-31T18:00");
  });
  it("round-trips in a DST zone too", () => {
    process.env.TZ = "America/New_York";
    const t = localInputToUnix("2026-07-01T09:30");
    expect(t).toBe(BigInt(Date.UTC(2026, 6, 1, 13, 30) / 1000)); // EDT = UTC-4
    expect(unixToLocalInput(Number(t))).toBe("2026-07-01T09:30");
    process.env.TZ = "Asia/Kuala_Lumpur";
  });
  it("rejects malformed values", () => {
    expect(() => localInputToUnix("31/12/2026")).toThrow();
    expect(() => localInputToUnix("")).toThrow();
  });
  it("formats durations", () => {
    expect(formatDuration(0)).toBe("now");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(65)).toBe("1m 05s");
    expect(formatDuration(3 * 86400 + 4 * 3600)).toBe("3d 4h");
  });
});
