"use client";

import { useEffect, useState } from "react";
import { formatUsdc, parseUsdc } from "@/lib/amount";
import { toHex } from "@/lib/codec";
import { sha256File, MAX_HASH_FILE_BYTES } from "@/lib/hash";
import { buildPack, packFileName, packFileText, packHash, MAX_ITEMS, type EvidencePack, type PackFile } from "@/lib/evidence";

interface Row {
  id: number;
  label: string;
  amount: string;
  files: PackFile[];
  /** file batches still being fingerprinted (a counter: the user can add files again meanwhile) */
  hashing: number;
  /** last file problem for this item (kept apart from `problem`, which the rebuild overwrites) */
  fileError: string | null;
}

export interface BuiltPack {
  pack: EvidencePack;
  hash: Uint8Array;
}

let nextId = 1;
const emptyRow = (): Row => ({ id: nextId++, label: "", amount: "", files: [], hashing: 0, fileError: null });

export function downloadPack(pack: EvidencePack) {
  const blob = new Blob([packFileText(pack)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = packFileName(pack);
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Itemised move-out claim. Each line has a description, an amount and its photos/invoices; files
 * are fingerprinted on this device and never uploaded. The pack's SHA-256 is what goes on-chain.
 */
export function EvidencePackBuilder({ lease, maxTotal, onChange }: { lease: string; maxTotal: bigint; onChange: (b: BuiltPack | null) => void }) {
  const [rows, setRows] = useState<Row[]>(() => [emptyRow()]);
  const [built, setBuilt] = useState<BuiltPack | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const update = (id: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function addFiles(id: number, input: HTMLInputElement) {
    const list = Array.from(input.files ?? []);
    input.value = ""; // so removing a file and picking it again fires onChange
    if (list.length === 0) return;
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, hashing: r.hashing + 1, fileError: null } : r)));
    const files: PackFile[] = [];
    let fileError: string | null = null;
    for (const f of list) {
      try {
        if (f.size > MAX_HASH_FILE_BYTES) throw new Error(`${f.name} is too large to fingerprint in the browser.`);
        files.push({ name: f.name, size: f.size, sha256: toHex(await sha256File(f)) });
      } catch (e) {
        fileError = e instanceof Error ? e.message : String(e);
      }
    }
    setRows((rs) =>
      rs.map((r) => {
        if (r.id !== id) return r;
        // the same file picked twice for one item is listed once
        const seen = new Set(r.files.map((f) => f.sha256));
        const fresh = files.filter((f) => !seen.has(f.sha256) && seen.add(f.sha256));
        return { ...r, files: [...r.files, ...fresh], hashing: r.hashing - 1, fileError };
      }),
    );
  }

  // Rebuild the pack whenever the draft changes. createdAt is fixed at build time, so the file the
  // landlord downloads and the hash sent on-chain always describe the same manifest.
  useEffect(() => {
    let cancelled = false;
    // Drop the previous pack right away: until the new hash is ready, Propose must not send a
    // manifest that no longer matches what is on screen.
    onChange(null);
    const touched = rows.some((r) => r.label || r.amount || r.files.length);
    if (!touched) {
      setBuilt(null);
      setProblem(null);
      return;
    }
    (async () => {
      try {
        if (rows.some((r) => r.hashing > 0)) throw new Error("Fingerprinting files…");
        const items = rows.map((r, i) => {
          let amount: bigint;
          try {
            amount = parseUsdc(r.amount || "0");
          } catch {
            throw new Error(`Item ${i + 1}: enter an amount like 350 or 120.50`);
          }
          return { label: r.label, amount, files: r.files };
        });
        const pack = buildPack(lease, items, maxTotal);
        const hash = await packHash(pack);
        if (cancelled) return;
        const b = { pack, hash };
        setBuilt(b);
        setProblem(null);
        onChange(b);
      } catch (e) {
        if (cancelled) return;
        setBuilt(null);
        setProblem(e instanceof Error ? e.message : String(e));
        onChange(null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // onChange is a stable setter from the parent
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, lease, maxTotal]);

  return (
    <div className="pack">
      <p className="muted small">
        List each deduction with its photos or invoices. Files are fingerprinted on your device and never uploaded; only
        the pack&apos;s SHA-256 goes on-chain. Max total {formatUsdc(maxTotal)} USDC.
      </p>
      {rows.map((r, i) => (
        <fieldset key={r.id} className="pack-item">
          <legend>Item {i + 1}</legend>
          <label>
            What for
            <input value={r.label} placeholder="e.g. Broken wardrobe door" onChange={(e) => update(r.id, { label: e.target.value })} />
          </label>
          <label>
            Amount (USDC)
            <input value={r.amount} inputMode="decimal" placeholder="350" onChange={(e) => update(r.id, { amount: e.target.value })} />
          </label>
          <label>
            <span>
              Photos / invoices <span className="hint">(hashed on your device)</span>
            </span>
            <input type="file" multiple accept="image/*,application/pdf" onChange={(e) => addFiles(r.id, e.currentTarget)} />
          </label>
          {r.hashing > 0 && <small className="muted">Fingerprinting…</small>}
          {r.fileError && (
            <small className="error" role="alert">
              {r.fileError}
            </small>
          )}
          {r.files.length > 0 && (
            <ul className="pack-files">
              {r.files.map((f) => (
                <li key={f.sha256}>
                  <span className="mono small">{f.sha256.slice(0, 10)}…</span> {f.name}{" "}
                  <button
                    type="button"
                    className="linkish"
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setRows((rs) => rs.map((x) => (x.id === r.id ? { ...x, files: x.files.filter((g) => g.sha256 !== f.sha256) } : x)))}
                  >
                    remove
                  </button>
                </li>
              ))}
            </ul>
          )}
          {rows.length > 1 && (
            <button
              type="button"
              className="btn small ghost"
              aria-label={`Remove item ${i + 1}`}
              onClick={() => setRows((rs) => rs.filter((x) => x.id !== r.id))}
            >
              Remove item
            </button>
          )}
        </fieldset>
      ))}
      {rows.length < MAX_ITEMS && (
        <button type="button" className="btn small ghost" onClick={() => setRows((rs) => [...rs, emptyRow()])}>
          + Add item
        </button>
      )}
      <p className="muted small" role="status" aria-live="polite">
        {problem}
      </p>
      {built && (
        <div className="pack-summary">
          <div>
            Total deduction: <strong>{formatUsdc(BigInt(built.pack.total))} USDC</strong> · {built.pack.items.length} item
            {built.pack.items.length === 1 ? "" : "s"} · {built.pack.items.reduce((a, it) => a + it.files.length, 0)} file(s)
          </div>
          <div className="mono small break">Pack SHA-256 {toHex(built.hash)}</div>
          <button type="button" className="btn small" onClick={() => downloadPack(built.pack)}>
            Download evidence pack (.json)
          </button>
          <small className="muted">Keep this file and the photos. Share them with the tenant and arbiter so they can verify the claim on this page.</small>
        </div>
      )}
    </div>
  );
}
