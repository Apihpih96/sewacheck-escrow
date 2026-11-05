"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { fetchMyLeases, type LeaseRow } from "@/lib/leases";
import { formatUsdc } from "@/lib/amount";
import { formatTs } from "@/lib/time";
import { mapError } from "@/lib/errors";
import { short } from "@/lib/solanaPay";
import { OpenByAddress } from "./OpenByAddress";

export function MyLeases() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [rows, setRows] = useState<LeaseRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!publicKey) return setRows(null);
    setError(null);
    try {
      setRows(await fetchMyLeases(connection, publicKey));
    } catch (e) {
      setError(mapError(e).message);
    }
  }, [connection, publicKey]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="card" id="my-leases">
      <div className="status-row">
        <h2>My leases</h2>
        {publicKey && (
          <button className="btn small ghost" type="button" onClick={load}>
            Refresh
          </button>
        )}
      </div>
      {!publicKey && <p className="muted">Connect a wallet to see leases where you are the landlord or tenant.</p>}
      {error && <p className="error">{error}</p>}
      {publicKey && rows && rows.length === 0 && (
        <p className="muted">
          No open leases for this wallet. <Link href="/create">Create one</Link>.
        </p>
      )}
      {rows && rows.length > 0 && (
        <ul className="lease-list">
          {rows.map((r) => (
            <li key={r.address.toBase58()}>
              <Link href={`/lease/${r.address.toBase58()}`}>
                <span className={`status status-${r.lease.status}`}>{r.lease.status}</span>
                <span className="grow">
                  <strong>{formatUsdc(r.lease.amount)} USDC</strong>
                  <span className="muted small">
                    {" "}
                    · you are {r.role} · {r.role === "landlord" ? "tenant" : "landlord"}{" "}
                    {short(r.role === "landlord" ? r.lease.tenant : r.lease.landlord)}
                  </span>
                  <span className="muted small block">ends {formatTs(r.lease.leaseEndTs)}</span>
                </span>
                <span aria-hidden>›</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <OpenByAddress />
    </section>
  );
}
