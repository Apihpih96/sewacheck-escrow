import { afterEach, describe, expect, it, vi } from "vitest";
import { Keypair } from "@solana/web3.js";
import { sha256Bytes } from "../src/lib/hash";
import { toHex } from "../src/lib/codec";
import {
  acceptedSubtotal,
  buildPack,
  canonicalPackBytes,
  checkPack,
  packFileText,
  packHash,
  parsePack,
  type DraftItem,
  type ProvidedFile,
} from "../src/lib/evidence";
import { MAX_FILES, MAX_ITEMS } from "../src/lib/evidence";
import { formatUsdc, parseUsdcOrZero } from "../src/lib/amount";

const enc = (s: string) => new TextEncoder().encode(s);
const LEASE = Keypair.generate().publicKey.toBase58();
const AT = "2026-11-20T10:00:00.000Z";

async function fileOf(name: string, body: string): Promise<ProvidedFile & { size: number }> {
  return { name, size: body.length, sha256: toHex(await sha256Bytes(enc(body))) };
}

async function demo() {
  const door = await fileOf("wardrobe.jpg", "photo-of-broken-door");
  const invoice = await fileOf("carpenter-invoice.pdf", "invoice RM350");
  const paint = await fileOf("wall.jpg", "photo-of-wall-stains");
  const items: DraftItem[] = [
    { label: "  Broken wardrobe door  ", amount: 350_000_000n, files: [door, invoice] },
    { label: "Repaint bedroom wall", amount: 200_000_000n, files: [paint] },
  ];
  const pack = buildPack(LEASE, items, 5_400_000_000n, AT);
  const hash = await packHash(pack);
  return { pack, hash, files: [door, invoice, paint] };
}

describe("evidence pack", () => {
  it("builds an itemised, exact manifest", async () => {
    const { pack } = await demo();
    expect(pack.total).toBe("550000000");
    expect(pack.items[0]!.label).toBe("Broken wardrobe door");
    expect(pack.items[0]!.files).toHaveLength(2);
    expect(pack.lease).toBe(LEASE);
  });

  it("rejects invalid drafts with readable errors", async () => {
    const f = await fileOf("a.jpg", "a");
    expect(() => buildPack(LEASE, [], 1n)).toThrow(/at least one/);
    expect(() => buildPack(LEASE, [{ label: "", amount: 1n, files: [f] }], 10n)).toThrow(/describe/);
    expect(() => buildPack(LEASE, [{ label: "x", amount: 0n, files: [f] }], 10n)).toThrow(/greater than zero/);
    expect(() => buildPack(LEASE, [{ label: "x", amount: 1n, files: [] }], 10n)).toThrow(/attach/);
    expect(() => buildPack(LEASE, [{ label: "x", amount: 11n, files: [f] }], 10n)).toThrow(/more than the deposit/);
  });

  it("hash is stable across pretty-printing and parse round-trip", async () => {
    const { pack, hash } = await demo();
    const pretty = enc(packFileText(pack));
    const parsed = parsePack(pretty)!;
    expect(parsed).not.toBeNull();
    expect(toHex(await packHash(parsed))).toBe(toHex(hash));
    expect(toHex(canonicalPackBytes(parsed))).toBe(toHex(canonicalPackBytes(pack)));
  });

  it("any edit to the manifest changes the hash", async () => {
    const { pack, hash } = await demo();
    const edited = { ...pack, items: pack.items.map((it, i) => (i === 0 ? { ...it, amount: "360000000" } : it)) };
    expect(toHex(await packHash(edited))).not.toBe(toHex(hash));
    const renamed = { ...pack, items: pack.items.map((it, i) => (i === 1 ? { ...it, label: "Repaint whole flat" } : it)) };
    expect(toHex(await packHash(renamed))).not.toBe(toHex(hash));
  });

  it("parsePack ignores non-pack files", () => {
    expect(parsePack(enc("not json"))).toBeNull();
    expect(parsePack(enc(JSON.stringify({ kind: "other" })))).toBeNull();
    expect(parsePack(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
  });

  it("verifies a complete, untampered pack", async () => {
    const { pack, hash, files } = await demo();
    const r = checkPack(pack, hash, files, { lease: LEASE, evidenceHash: hash, deduction: 550_000_000n });
    expect(r.verified).toBe(true);
    expect(r.items.every((i) => i.ok)).toBe(true);
    expect(r.extras).toEqual([]);
  });

  it("matches renamed files by content", async () => {
    const { pack, hash, files } = await demo();
    const renamed = files.map((f, i) => ({ ...f, name: `IMG_000${i}.jpg` }));
    const r = checkPack(pack, hash, renamed, { lease: LEASE, evidenceHash: hash, deduction: 550_000_000n });
    expect(r.verified).toBe(true);
    expect(r.items[0]!.files[0]!.matchedBy).toBe("IMG_0000.jpg");
  });

  it("flags a swapped photo, a missing file, and an extra file", async () => {
    const { pack, hash, files } = await demo();
    const swapped = await fileOf("wardrobe.jpg", "a-different-photo");
    const extra = await fileOf("selfie.jpg", "unrelated");
    const r = checkPack(pack, hash, [swapped, files[2]!, extra], { lease: LEASE, evidenceHash: hash, deduction: 550_000_000n });
    expect(r.verified).toBe(false);
    expect(r.anchored).toBe(true);
    expect(r.items[0]!.files.map((f) => f.status)).toEqual(["changed", "missing"]);
    expect(r.items[1]!.ok).toBe(true);
    expect(r.extras).toEqual(["selfie.jpg"]);
  });

  it("fails when the manifest isn't the one anchored, or is for another lease, or the claim differs", async () => {
    const { pack, hash, files } = await demo();
    const other = new Uint8Array(32).fill(9);
    expect(checkPack(pack, hash, files, { lease: LEASE, evidenceHash: other, deduction: 550_000_000n }).anchored).toBe(false);
    const r2 = checkPack(pack, hash, files, { lease: Keypair.generate().publicKey.toBase58(), evidenceHash: hash, deduction: 550_000_000n });
    expect(r2.leaseMatches).toBe(false);
    expect(r2.verified).toBe(false);
    const r3 = checkPack(pack, hash, files, { lease: LEASE, evidenceHash: hash, deduction: 600_000_000n });
    expect(r3.totalMatchesClaim).toBe(false);
    expect(r3.verified).toBe(false);
  });

  it("detects an inconsistent total in a hand-edited manifest", async () => {
    const { pack, files } = await demo();
    const bad = { ...pack, total: "999000000" };
    const h = await packHash(bad);
    const r = checkPack(bad, h, files, { lease: LEASE, evidenceHash: h, deduction: 999_000_000n });
    expect(r.totalConsistent).toBe(false);
    expect(r.verified).toBe(false);
  });

  it("accepted subtotal for an arbiter ruling is capped at the claim", () => {
    const items = [{ amount: 350n }, { amount: 200n }];
    expect(acceptedSubtotal(items, [true, false], 550n)).toBe(350n);
    expect(acceptedSubtotal(items, [true, true], 500n)).toBe(500n);
    expect(acceptedSubtotal(items, [false, false], 550n)).toBe(0n);
  });

  // ---- review fixes (week 3) ----

  it("canonical bytes ignore key order, whitespace and unknown keys in the pack file", async () => {
    const { pack, hash } = await demo();
    const o = JSON.parse(packFileText(pack));
    const shuffled = {
      note: "ignored",
      items: o.items.map((it: Record<string, unknown>) => ({ files: it.files, amount: it.amount, label: it.label })),
      createdAt: o.createdAt,
      total: o.total,
      decimals: o.decimals,
      currency: o.currency,
      lease: o.lease,
      version: o.version,
      kind: o.kind,
    };
    const parsed = parsePack(enc(JSON.stringify(shuffled, null, "\t")))!;
    expect(toHex(await packHash(parsed))).toBe(toHex(hash));
  });

  it("unicode labels and file names round-trip to the same hash", async () => {
    const f = await fileOf("dinding é 😀.jpg", "x");
    const pack = buildPack(LEASE, [{ label: "Cat semula dinding — kotor 😀 café", amount: 1n, files: [f] }], 10n, AT);
    const parsed = parsePack(enc(packFileText(pack)))!;
    expect(parsed.items[0]!.label).toBe("Cat semula dinding — kotor 😀 café");
    expect(toHex(await packHash(parsed))).toBe(toHex(await packHash(pack)));
  });

  it("label truncation never splits an emoji into a lone surrogate", async () => {
    const f = await fileOf("a.jpg", "a");
    const pack = buildPack(LEASE, [{ label: "a".repeat(119) + "😀😀", amount: 1n, files: [f] }], 10n, AT);
    const label = pack.items[0]!.label;
    expect(Array.from(label)).toHaveLength(120);
    expect(label.endsWith("😀")).toBe(true);
    expect(/[\ud800-\udbff](?![\udc00-\udfff])/.test(label)).toBe(false);
  });

  it("amounts stay exact integers in base units up to u64 max", async () => {
    const f = await fileOf("a.jpg", "a");
    const max = (1n << 64n) - 1n;
    const pack = buildPack(LEASE, [{ label: "x", amount: max - 1n, files: [f] }, { label: "y", amount: 1n, files: [f] }], max, AT);
    expect(pack.total).toBe("18446744073709551615");
    const parsed = parsePack(enc(packFileText(pack)))!;
    expect(parsed.total).toBe("18446744073709551615");
    const r = checkPack(parsed, await packHash(parsed), [f], { lease: LEASE, evidenceHash: await packHash(pack), deduction: max });
    expect(r.verified).toBe(true);
  });

  it("parsePack rejects wrong decimals, bad sizes and over-limit packs", async () => {
    const { pack } = await demo();
    const o = JSON.parse(packFileText(pack));
    expect(parsePack(enc(JSON.stringify({ ...o, decimals: 2 })))).toBeNull();
    const badSize = (size: unknown) => ({ ...o, items: [{ ...o.items[0], files: [{ ...o.items[0].files[0], size }] }] });
    expect(parsePack(enc(JSON.stringify(badSize(1.5))))).toBeNull();
    expect(parsePack(enc(JSON.stringify(badSize(-1))))).toBeNull();
    expect(parsePack(enc(JSON.stringify(badSize("12"))))).toBeNull();
    expect(parsePack(enc(JSON.stringify(badSize(0))))).not.toBeNull();
    const many = { ...o, items: Array.from({ length: MAX_ITEMS + 1 }, () => o.items[1]) };
    expect(parsePack(enc(JSON.stringify(many)))).toBeNull();
    const file = o.items[0].files[0];
    const manyFiles = { ...o, items: [{ ...o.items[0], files: Array.from({ length: MAX_FILES + 1 }, () => file) }] };
    expect(parsePack(enc(JSON.stringify(manyFiles)))).toBeNull();
  });

  it("a correct file sharing a name with another entry does not make that entry look tampered", async () => {
    // two phones both produced IMG_0001.jpg; only the first one was provided
    const a = await fileOf("IMG_0001.jpg", "photo from phone A");
    const b = await fileOf("IMG_0001.jpg", "photo from phone B");
    const pack = buildPack(LEASE, [{ label: "Door", amount: 1n, files: [a] }, { label: "Wall", amount: 1n, files: [b] }], 10n, AT);
    const h = await packHash(pack);
    const r = checkPack(pack, h, [a], { lease: LEASE, evidenceHash: h, deduction: 2n });
    expect(r.items[0]!.files[0]!.status).toBe("match");
    expect(r.items[1]!.files[0]!.status).toBe("missing");
    // an edited copy with that name is still reported as changed
    const edited = await fileOf("IMG_0001.jpg", "edited");
    const r2 = checkPack(pack, h, [a, edited], { lease: LEASE, evidenceHash: h, deduction: 2n });
    expect(r2.items[1]!.files[0]!.status).toBe("changed");
    // providing both verifies
    expect(checkPack(pack, h, [a, b], { lease: LEASE, evidenceHash: h, deduction: 2n }).verified).toBe(true);
  });

  it("one file used as evidence for two items matches both, and duplicates are not extras", async () => {
    const shared = await fileOf("invoice.pdf", "one invoice for two repairs");
    const pack = buildPack(LEASE, [{ label: "A", amount: 1n, files: [shared] }, { label: "B", amount: 2n, files: [shared] }], 10n, AT);
    const h = await packHash(pack);
    const r = checkPack(pack, h, [shared, { ...shared, name: "copy of invoice.pdf" }], { lease: LEASE, evidenceHash: h, deduction: 3n });
    expect(r.verified).toBe(true);
    expect(r.extras).toEqual([]);
  });

  it("an all-rejected ruling (0.00 prefilled) parses as zero", () => {
    const items = [{ amount: 350n }, { amount: 200n }];
    const prefill = formatUsdc(acceptedSubtotal(items, [false, false], 550n)).replace(/,/g, "");
    expect(prefill).toBe("0.00");
    expect(parseUsdcOrZero(prefill)).toBe(0n);
    expect(parseUsdcOrZero("0")).toBe(0n);
    expect(parseUsdcOrZero(" 0. ")).toBe(0n);
    expect(parseUsdcOrZero("200.00")).toBe(200_000_000n);
    for (const bad of ["", ".", "abc", "-0", "-1"]) expect(() => parseUsdcOrZero(bad), bad).toThrow();
  });
});

describe("sha256 outside a secure context", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("fails with a readable message when crypto.subtle is unavailable (http on a LAN IP)", async () => {
    vi.stubGlobal("crypto", {});
    await expect(sha256Bytes(enc("x"))).rejects.toThrow(/secure \(https\) page/);
  });
});
