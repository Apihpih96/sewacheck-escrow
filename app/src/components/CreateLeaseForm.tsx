"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { PublicKey } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { parseDaysToSecs, parseUsdc, formatUsdc } from "@/lib/amount";
import { localInputToUnix, unixToLocalInput, formatTs } from "@/lib/time";
import { parsePubkey, fundRequestLink, transactionRequestUrl } from "@/lib/solanaPay";
import { createLeaseIx } from "@/lib/tx";
import { randomLeaseId } from "@/lib/pda";
import { sha256File, MAX_HASH_FILE_BYTES } from "@/lib/hash";
import { toHex } from "@/lib/codec";
import { simulateThenSend } from "@/lib/send";
import { mapError } from "@/lib/errors";
import { explorerTx } from "@/lib/constants";
import { Qr } from "./Qr";
import { CopyField } from "./CopyField";

interface Created {
  lease: PublicKey;
  sig: string;
  amount: bigint;
  end: bigint;
}

export function CreateLeaseForm() {
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [tenant, setTenant] = useState("");
  const [amount, setAmount] = useState("");
  const [end, setEnd] = useState(() => unixToLocalInput(Math.floor(Date.now() / 1000) + 365 * 86400));
  const [claimDays, setClaimDays] = useState("14");
  const [responseDays, setResponseDays] = useState("7");
  const [arbiterDays, setArbiterDays] = useState("14");
  const [arbiter, setArbiter] = useState("");
  const [terms, setTerms] = useState<{ name: string; hash: Uint8Array } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Created | null>(null);
  const tz = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, []);

  async function onTerms(f: File | undefined) {
    setTerms(null);
    if (!f) return;
    if (f.size > MAX_HASH_FILE_BYTES) return setError("File is too large to fingerprint in the browser.");
    setTerms({ name: f.name, hash: await sha256File(f) });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!publicKey) return setError("Connect the landlord wallet first.");
    try {
      const tenantPk = parsePubkey(tenant.trim());
      if (!tenantPk) throw new Error("Enter the tenant's Solana wallet address.");
      if (tenantPk.equals(publicKey)) throw new Error("The tenant must be a different wallet from yours.");
      const arbiterPk = arbiter.trim() ? parsePubkey(arbiter.trim()) : null;
      if (arbiter.trim() && !arbiterPk) throw new Error("The arbiter address is not a valid Solana address.");
      if (arbiterPk && (arbiterPk.equals(publicKey) || arbiterPk.equals(tenantPk)))
        throw new Error("The arbiter must be someone other than you or the tenant.");
      const amt = parseUsdc(amount);
      const endTs = localInputToUnix(end);
      if (endTs <= BigInt(Math.floor(Date.now() / 1000))) throw new Error("The lease end must be in the future.");
      const leaseId = randomLeaseId();
      const { ix, lease } = createLeaseIx({
        landlord: publicKey,
        tenant: tenantPk,
        leaseId,
        amount: amt,
        leaseEndTs: endTs,
        arbiter: arbiterPk,
        termsHash: terms?.hash ?? null,
        claimWindowSecs: parseDaysToSecs(claimDays),
        responseWindowSecs: parseDaysToSecs(responseDays),
        arbiterWindowSecs: parseDaysToSecs(arbiterDays),
      });
      setBusy(true);
      const sig = await simulateThenSend(connection, publicKey, [ix], sendTransaction);
      setCreated({ lease, sig, amount: amt, end: endTs });
    } catch (err) {
      setError(mapError(err).message);
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    const origin = window.location.origin;
    const leaseUrl = `${origin}/lease/${created.lease.toBase58()}`;
    const payUrl = transactionRequestUrl(fundRequestLink(origin, created.lease));
    return (
      <section className="card">
        <h2>Lease created</h2>
        <p>
          Deposit of <strong>{formatUsdc(created.amount)} USDC</strong>, lease ends {formatTs(created.end)}.{" "}
          <a href={explorerTx(created.sig)} target="_blank" rel="noreferrer noopener">
            View transaction
          </a>
        </p>
        <p>Send this link to your tenant. They can fund from the page, or scan the Solana Pay code with a mobile wallet.</p>
        <CopyField label="Tenant link" value={leaseUrl} />
        <div className="qr-row">
          <Qr value={leaseUrl} label="Lease page" />
          <Qr value={payUrl} label="Solana Pay: fund deposit" />
        </div>
        {!origin.startsWith("https://") && (
          <p className="note warn">
            Mobile wallets only accept Solana Pay links served over https. On localhost, use the page&apos;s
            &quot;Connect wallet and fund&quot; button instead.
          </p>
        )}
        <Link className="btn" href={`/lease/${created.lease.toBase58()}`}>
          Open lease page
        </Link>
      </section>
    );
  }

  return (
    <form className="card form" onSubmit={submit} noValidate>
      <h2>Create a lease</h2>
      <p className="muted">You are the landlord. The tenant locks the deposit in USDC; it is released by the rules below.</p>
      <label>
        Tenant wallet address
        <input value={tenant} onChange={(e) => setTenant(e.target.value)} placeholder="e.g. JCFc…uBvf" autoComplete="off" spellCheck={false} required />
      </label>
      <label>
        Deposit (USDC)
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="5400" required />
      </label>
      <label>
        Lease end <span className="muted">({tz})</span>
        <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} required />
      </label>
      <fieldset>
        <legend>Windows (days; 0 = program default)</legend>
        <div className="grid3">
          <label>
            Claim
            <input value={claimDays} onChange={(e) => setClaimDays(e.target.value)} inputMode="decimal" />
            <small>Landlord can claim after lease end</small>
          </label>
          <label>
            Response
            <input value={responseDays} onChange={(e) => setResponseDays(e.target.value)} inputMode="decimal" />
            <small>Tenant can dispute a claim</small>
          </label>
          <label>
            Arbiter
            <input value={arbiterDays} onChange={(e) => setArbiterDays(e.target.value)} inputMode="decimal" />
            <small>Arbiter rules on a dispute</small>
          </label>
        </div>
      </fieldset>
      <label>
        Arbiter wallet <span className="muted">(optional)</span>
        <input value={arbiter} onChange={(e) => setArbiter(e.target.value)} placeholder="Leave empty to use the SewaCheck fallback arbiter" autoComplete="off" spellCheck={false} />
      </label>
      <label>
        Tenancy agreement <span className="muted">(optional, fingerprinted on your device, never uploaded)</span>
        <input type="file" onChange={(e) => onTerms(e.target.files?.[0])} />
        {terms && (
          <small className="mono">
            SHA-256 {toHex(terms.hash).slice(0, 16)}… of {terms.name}
          </small>
        )}
      </label>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <button className="btn primary" type="submit" disabled={busy}>
        {busy ? "Creating…" : publicKey ? "Create lease" : "Connect wallet to create"}
      </button>
    </form>
  );
}
