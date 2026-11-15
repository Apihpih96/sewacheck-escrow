import { sha256Bytes } from "./hash";
import { toHex } from "./codec";
import { USDC_DECIMALS } from "./constants";

/**
 * Evidence packs: an itemised move-out claim whose fingerprint is what goes on-chain.
 *
 * The landlord lists deduction items (e.g. "Broken wardrobe door — RM 350") and attaches photos or
 * invoices to each. Every file is hashed on the device; the files never leave it. The pack is a
 * small canonical JSON manifest (lease address, items, amounts, file names + SHA-256s), and
 * SHA-256(manifest bytes) is the `evidence_hash` passed to `propose_deduction`.
 *
 * Anyone holding the manifest and the files (tenant, arbiter) can later prove on the lease page
 * that they are exactly what the landlord committed to on-chain: one changed pixel, one swapped
 * photo or one edited amount breaks the match. No program change is needed: the on-chain field is
 * the same 32 bytes as before, so single-file evidence from earlier leases still verifies.
 */

export const EVIDENCE_PACK_KIND = "sewacheck-evidence-pack";
export const EVIDENCE_PACK_VERSION = 1;
export const MAX_ITEMS = 20;
export const MAX_FILES = 60;
const MAX_LABEL = 120;

export interface PackFile {
  name: string;
  size: number;
  /** lowercase hex SHA-256 of the file bytes */
  sha256: string;
}

export interface PackItem {
  label: string;
  /** USDC base units (6 decimals) as a decimal string, so the manifest stays exact */
  amount: string;
  files: PackFile[];
}

export interface EvidencePack {
  kind: typeof EVIDENCE_PACK_KIND;
  version: typeof EVIDENCE_PACK_VERSION;
  /** lease account address (base58); binds the pack to one lease so it can't be replayed */
  lease: string;
  currency: "USDC";
  decimals: number;
  /** sum of item amounts, base units */
  total: string;
  /** ISO timestamp chosen by the landlord's device; informational, but covered by the hash */
  createdAt: string;
  items: PackItem[];
}

export interface DraftItem {
  label: string;
  amount: bigint;
  files: PackFile[];
}

function cleanLabel(s: string): string {
  // Truncate by code point, not UTF-16 unit, so an emoji at the limit is not split into a lone
  // surrogate (which would show as "\ufffd" and serialise as an escaped half-character).
  return Array.from(s.replace(/\s+/g, " ").trim()).slice(0, MAX_LABEL).join("").trim();
}

function isSize(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}

function isHex32(s: unknown): s is string {
  return typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
}

/** Builds a pack from draft items. Throws a user-readable Error when the draft is not valid. */
export function buildPack(lease: string, items: DraftItem[], maxTotal: bigint, createdAt = new Date().toISOString()): EvidencePack {
  if (items.length === 0) throw new Error("Add at least one deduction item.");
  if (items.length > MAX_ITEMS) throw new Error(`At most ${MAX_ITEMS} items per claim.`);
  let total = 0n;
  let fileCount = 0;
  const out: PackItem[] = items.map((it, i) => {
    const label = cleanLabel(it.label);
    if (!label) throw new Error(`Item ${i + 1}: describe what the deduction is for.`);
    if (it.amount <= 0n) throw new Error(`Item ${i + 1}: amount must be greater than zero.`);
    if (it.files.length === 0) throw new Error(`Item ${i + 1}: attach at least one photo or invoice.`);
    fileCount += it.files.length;
    total += it.amount;
    return {
      label,
      amount: it.amount.toString(),
      files: it.files.map((f) => {
        if (!isHex32(f.sha256)) throw new Error(`Item ${i + 1}: bad file fingerprint.`);
        return { name: f.name, size: f.size, sha256: f.sha256 };
      }),
    };
  });
  if (fileCount > MAX_FILES) throw new Error(`At most ${MAX_FILES} files per claim.`);
  if (total > maxTotal) throw new Error("The items add up to more than the deposit held.");
  return {
    kind: EVIDENCE_PACK_KIND,
    version: EVIDENCE_PACK_VERSION,
    lease,
    currency: "USDC",
    decimals: USDC_DECIMALS,
    total: total.toString(),
    createdAt,
    items: out,
  };
}

/**
 * Canonical bytes of a pack: fixed key order, no whitespace, UTF-8. Re-serialising a parsed pack
 * gives the same bytes, so the hash does not depend on how the JSON file was pretty-printed.
 */
export function canonicalPackBytes(p: EvidencePack): Uint8Array {
  const ordered = {
    kind: p.kind,
    version: p.version,
    lease: p.lease,
    currency: p.currency,
    decimals: p.decimals,
    total: p.total,
    createdAt: p.createdAt,
    items: p.items.map((it) => ({
      label: it.label,
      amount: it.amount,
      files: it.files.map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
    })),
  };
  return new TextEncoder().encode(JSON.stringify(ordered));
}

export async function packHash(p: EvidencePack): Promise<Uint8Array> {
  return sha256Bytes(canonicalPackBytes(p));
}

/** Parses an uploaded pack file. Returns null when the bytes are not a SewaCheck evidence pack. */
export function parsePack(bytes: Uint8Array): EvidencePack | null {
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.kind !== EVIDENCE_PACK_KIND || o.version !== EVIDENCE_PACK_VERSION) return null;
  // decimals is fixed: amounts are displayed and compared as USDC base units (6 decimals).
  if (typeof o.lease !== "string" || o.currency !== "USDC" || o.decimals !== USDC_DECIMALS) return null;
  if (typeof o.total !== "string" || !/^\d+$/.test(o.total) || typeof o.createdAt !== "string") return null;
  if (!Array.isArray(o.items) || o.items.length > MAX_ITEMS) return null;
  const items: PackItem[] = [];
  let fileCount = 0;
  for (const raw of o.items) {
    if (!raw || typeof raw !== "object") return null;
    const it = raw as Record<string, unknown>;
    if (typeof it.label !== "string" || typeof it.amount !== "string" || !/^\d+$/.test(it.amount)) return null;
    if (!Array.isArray(it.files)) return null;
    fileCount += it.files.length;
    if (fileCount > MAX_FILES) return null;
    const files: PackFile[] = [];
    for (const rf of it.files) {
      const f = rf as Record<string, unknown>;
      if (!f || typeof f.name !== "string" || !isSize(f.size) || !isHex32(f.sha256)) return null;
      files.push({ name: f.name, size: f.size, sha256: f.sha256 });
    }
    items.push({ label: it.label, amount: it.amount, files });
  }
  return {
    kind: EVIDENCE_PACK_KIND,
    version: EVIDENCE_PACK_VERSION,
    lease: o.lease,
    currency: "USDC",
    decimals: USDC_DECIMALS,
    total: o.total,
    createdAt: o.createdAt,
    items,
  };
}

/** Pretty JSON for the downloadable file; it re-canonicalises to the same hash. */
export function packFileText(p: EvidencePack): string {
  return JSON.stringify(JSON.parse(new TextDecoder().decode(canonicalPackBytes(p))), null, 2) + "\n";
}

export function packFileName(p: EvidencePack): string {
  return `sewacheck-evidence-${p.lease.slice(0, 8)}.json`;
}

// ---------------------------------------------------------------- verification

export type FileStatus = "match" | "changed" | "missing";

export interface FileCheck {
  name: string;
  expected: string;
  status: FileStatus;
  /** name of the provided file that matched (may differ from the manifest name) */
  matchedBy?: string;
}

export interface ItemCheck {
  label: string;
  amount: bigint;
  files: FileCheck[];
  ok: boolean;
}

export interface PackCheck {
  kind: "pack";
  /** SHA-256 of the canonical manifest equals the on-chain evidence_hash */
  anchored: boolean;
  computedHash: string;
  /** manifest names this lease */
  leaseMatches: boolean;
  /** item amounts sum to the manifest total */
  totalConsistent: boolean;
  total: bigint;
  /** manifest total equals the deduction claimed on-chain */
  totalMatchesClaim: boolean;
  items: ItemCheck[];
  /** provided files that are not in the pack */
  extras: string[];
  allFilesOk: boolean;
  /** everything checks out */
  verified: boolean;
}

export interface SingleCheck {
  kind: "single";
  name: string;
  computedHash: string;
  matches: boolean;
}

export interface ProvidedFile {
  name: string;
  sha256: string;
}

/**
 * Checks a pack and the files the verifier dropped in against the lease's on-chain fields.
 * Files are matched by content hash first (a renamed photo still matches); a provided file with a
 * manifest name but different content is reported as "changed".
 */
export function checkPack(
  pack: EvidencePack,
  computedHash: Uint8Array,
  provided: ProvidedFile[],
  onchain: { lease: string; evidenceHash: Uint8Array; deduction: bigint },
): PackCheck {
  const byHash = new Map<string, ProvidedFile>();
  for (const f of provided) if (!byHash.has(f.sha256)) byHash.set(f.sha256, f);
  const used = new Set<string>();
  // A provided file counts as an altered copy of a manifest entry only when its own content is not
  // anywhere in the pack: a correct file that merely shares a name (two phones' IMG_0001.jpg) must
  // not make a different entry look tampered.
  const manifestHashes = new Set(pack.items.flatMap((it) => it.files.map((f) => f.sha256)));
  const items: ItemCheck[] = pack.items.map((it) => {
    const files: FileCheck[] = it.files.map((f) => {
      const hit = byHash.get(f.sha256);
      if (hit) {
        used.add(hit.sha256);
        return { name: f.name, expected: f.sha256, status: "match", matchedBy: hit.name };
      }
      const sameName = provided.some((p) => p.name === f.name && !manifestHashes.has(p.sha256));
      return { name: f.name, expected: f.sha256, status: sameName ? "changed" : "missing" };
    });
    return { label: it.label, amount: BigInt(it.amount), files, ok: files.every((f) => f.status === "match") };
  });
  const sum = items.reduce((a, b) => a + b.amount, 0n);
  const total = BigInt(pack.total);
  const anchored = toHex(computedHash) === toHex(onchain.evidenceHash);
  const leaseMatches = pack.lease === onchain.lease;
  const totalConsistent = sum === total;
  const totalMatchesClaim = total === onchain.deduction;
  const allFilesOk = items.every((i) => i.ok);
  const extras = provided.filter((p) => !used.has(p.sha256) && !pack.items.some((i) => i.files.some((f) => f.name === p.name))).map((p) => p.name);
  return {
    kind: "pack",
    anchored,
    computedHash: toHex(computedHash),
    leaseMatches,
    totalConsistent,
    total,
    totalMatchesClaim,
    items,
    extras,
    allFilesOk,
    verified: anchored && leaseMatches && totalConsistent && totalMatchesClaim && allFilesOk,
  };
}

/** Sum of the items the reviewer accepts (arbiter ruling helper), capped at the claim. */
export function acceptedSubtotal(items: { amount: bigint }[], accepted: boolean[], cap: bigint): bigint {
  const s = items.reduce((a, it, i) => (accepted[i] ? a + it.amount : a), 0n);
  return s > cap ? cap : s;
}
