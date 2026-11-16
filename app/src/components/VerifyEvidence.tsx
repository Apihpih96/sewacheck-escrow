"use client";

import { useRef, useState } from "react";
import type { Lease } from "@/lib/codec";
import { isZero, toHex } from "@/lib/codec";
import { formatUsdc } from "@/lib/amount";
import { sha256Bytes, MAX_HASH_FILE_BYTES } from "@/lib/hash";
import { acceptedSubtotal, checkPack, packHash, parsePack, type PackCheck, type ProvidedFile } from "@/lib/evidence";

interface Result {
  pack: PackCheck | null;
  /** loose files that match the agreement or single-file evidence fingerprints */
  agreement: string[];
  singleEvidence: string[];
  unmatched: string[];
  packCount: number;
}

const STATUS_ICON = { match: "✓", changed: "✗", missing: "?" } as const;
const STATUS_TEXT = { match: "matches", changed: "different file — content changed", missing: "not provided" } as const;

/**
 * Lets the tenant, arbiter, or anyone check documents against the fingerprints stored on the
 * lease: the evidence pack (manifest + photos/invoices), single-file evidence from older claims,
 * and the signed agreement. Everything runs in the browser; nothing is uploaded.
 */
export function VerifyEvidence({
  lease,
  address,
  canRule,
  onUseAward,
}: {
  lease: Lease;
  address: string;
  canRule: boolean;
  onUseAward: (usdc: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [accepted, setAccepted] = useState<boolean[]>([]);
  const runId = useRef(0);
  const hasEvidence = !isZero(lease.evidenceHash);
  const hasTerms = !isZero(lease.termsHash);

  async function onFiles(input: HTMLInputElement) {
    const list = Array.from(input.files ?? []);
    input.value = ""; // re-picking the same files (e.g. after swapping one on disk) re-runs the check
    const run = ++runId.current; // a slower earlier check must not overwrite a newer one
    setErr(null);
    setRes(null);
    if (list.length === 0) return;
    setBusy(true);
    try {
      const evidenceHex = toHex(lease.evidenceHash);
      const termsHex = toHex(lease.termsHash);
      const loose: ProvidedFile[] = [];
      let pack: PackCheck | null = null;
      let packCount = 0;
      const packs: { bytes: Uint8Array; name: string }[] = [];
      for (const f of list) {
        if (f.size > MAX_HASH_FILE_BYTES) throw new Error(`${f.name} is too large to check in the browser.`);
        const bytes = new Uint8Array(await f.arrayBuffer());
        if (f.name.toLowerCase().endsWith(".json") && parsePack(bytes)) {
          packs.push({ bytes, name: f.name });
          continue;
        }
        loose.push({ name: f.name, sha256: toHex(await sha256Bytes(bytes)) });
      }
      packCount = packs.length;
      if (packs.length > 0) {
        // Prefer the pack whose fingerprint is the one on-chain, if several were dropped in.
        let chosen: PackCheck | null = null;
        for (const p of packs) {
          const parsed = parsePack(p.bytes)!;
          const c = checkPack(parsed, await packHash(parsed), loose, { lease: address, evidenceHash: lease.evidenceHash, deduction: lease.deduction });
          if (!chosen || (c.anchored && !chosen.anchored)) chosen = c;
        }
        pack = chosen;
      }
      const inPack = new Set(pack ? pack.items.flatMap((i) => i.files.filter((f) => f.status === "match").map((f) => f.matchedBy!)) : []);
      const agreement = hasTerms ? loose.filter((f) => f.sha256 === termsHex).map((f) => f.name) : [];
      const singleEvidence = hasEvidence ? loose.filter((f) => f.sha256 === evidenceHex).map((f) => f.name) : [];
      const unmatched = loose
        .filter((f) => !inPack.has(f.name) && !agreement.includes(f.name) && !singleEvidence.includes(f.name))
        .filter((f) => !pack || pack.extras.includes(f.name))
        .map((f) => f.name);
      if (run !== runId.current) return;
      setRes({ pack, agreement, singleEvidence, unmatched, packCount });
      // Items with missing or changed files start unticked; so does everything in a pack that is not the
      // one anchored for this lease (its amounts are not the landlord's committed claim).
      const trusted = !!pack && pack.anchored && pack.leaseMatches;
      setAccepted(pack ? pack.items.map((i) => trusted && i.ok) : []);
    } catch (e) {
      if (run === runId.current) setErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (run === runId.current) setBusy(false);
    }
  }

  const p = res?.pack ?? null;
  const subtotal = p ? acceptedSubtotal(p.items, accepted, lease.deduction) : 0n;

  return (
    <section className="card" id="verify">
      <h3>Verify documents</h3>
      <p className="muted small">
        {hasEvidence ? "Drop in the landlord's evidence pack (.json) with its photos and invoices" : "Drop in documents"}
        {hasTerms ? ", or the signed agreement," : ""} to check them against the fingerprints stored on this lease. Checked
        on your device; nothing is uploaded.
      </p>
      <input type="file" multiple aria-label="Documents to verify" onChange={(e) => onFiles(e.currentTarget)} />
      {busy && <p className="muted small">Checking…</p>}
      {err && <p className="error small">{err}</p>}

      {res && (
        <div className="verify-results">
          {res.agreement.length > 0 && <p className="success small">✓ Agreement matches the on-chain fingerprint ({res.agreement.join(", ")}).</p>}
          {res.singleEvidence.length > 0 && <p className="success small">✓ Evidence file matches the on-chain fingerprint ({res.singleEvidence.join(", ")}).</p>}

          {p && (
            <>
              <p className={p.verified ? "success" : "error"} role="status">
                {p.verified ? (
                  <>✓ Evidence verified: this pack and every file are exactly what the landlord committed on-chain.</>
                ) : !p.anchored ? (
                  <>✗ This pack is not the one committed on-chain for this lease. It was changed or belongs to another claim.</>
                ) : (
                  <>✗ The pack is the committed one, but some files are missing or changed.</>
                )}
              </p>
              <ul className="checks small">
                <li>{p.anchored ? "✓" : "✗"} Pack fingerprint {p.anchored ? "matches" : "does not match"} the lease&apos;s evidence SHA-256</li>
                <li>{p.leaseMatches ? "✓" : "✗"} Pack is for this lease</li>
                <li>
                  {p.totalMatchesClaim && p.totalConsistent ? "✓" : "✗"} Items total {formatUsdc(p.total)} USDC
                  {p.totalMatchesClaim ? " = claimed deduction" : ` vs ${formatUsdc(lease.deduction)} USDC claimed`}
                  {p.totalConsistent ? "" : " (items don't add up to the pack total)"}
                </li>
              </ul>
              <table className="pack-table">
                <thead>
                  <tr>
                    <th scope="col">Accept</th>
                    <th scope="col">Item</th>
                    <th scope="col" className="num">USDC</th>
                    <th scope="col">Files</th>
                  </tr>
                </thead>
                <tbody>
                  {p.items.map((it, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          type="checkbox"
                          aria-label={`Accept ${it.label}`}
                          checked={accepted[i] ?? false}
                          onChange={(e) => setAccepted((a) => a.map((v, k) => (k === i ? e.target.checked : v)))}
                        />
                      </td>
                      <td>{it.label}</td>
                      <td className="num">{formatUsdc(it.amount)}</td>
                      <td>
                        <ul className="pack-files">
                          {it.files.map((f, j) => (
                            <li key={j} className={`fs-${f.status}`} title={f.expected}>
                              {STATUS_ICON[f.status]} {f.name}
                              {f.matchedBy && f.matchedBy !== f.name ? ` (as ${f.matchedBy})` : ""} — {STATUS_TEXT[f.status]}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="pack-summary">
                <div>
                  Items you accept: <strong>{formatUsdc(subtotal)} USDC</strong> to the landlord, {formatUsdc(lease.funded - subtotal)} USDC back to
                  the tenant.
                </div>
                {canRule && !(p.anchored && p.leaseMatches) && (
                  <small className="muted">Only the pack committed on-chain for this lease can prefill a ruling.</small>
                )}
                {canRule && p.anchored && p.leaseMatches && (
                  <button type="button" className="btn small primary" onClick={() => onUseAward(formatUsdc(subtotal).replace(/,/g, ""))}>
                    Use {formatUsdc(subtotal)} USDC as my ruling
                  </button>
                )}
              </div>
            </>
          )}

          {!p && res.packCount === 0 && res.agreement.length === 0 && res.singleEvidence.length === 0 && (
            <p className="error small">✗ None of these files match the fingerprints on this lease.</p>
          )}
          {res.unmatched.length > 0 && <p className="muted small">Not part of this lease&apos;s records: {res.unmatched.join(", ")}</p>}
        </div>
      )}
    </section>
  );
}
