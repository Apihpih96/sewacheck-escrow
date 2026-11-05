"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { PublicKey, Transaction } from "@solana/web3.js";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import type { Lease } from "@/lib/codec";
import { isZero, toHex } from "@/lib/codec";
import { fetchConfig, fetchLease } from "@/lib/leases";
import { ACTION_LABELS, STATUS_TEXT, availableActions, deadlines, effectiveArbiter, roleOf, type ActionState } from "@/lib/actions";
import { buildActionIxs, type ActionKind } from "@/lib/tx";
import { formatUsdc, parseUsdc } from "@/lib/amount";
import { formatDuration, formatTs, windowLabel } from "@/lib/time";
import { sha256File, MAX_HASH_FILE_BYTES } from "@/lib/hash";
import { simulateOrThrow, simulateThenSend } from "@/lib/send";
import { mapError } from "@/lib/errors";
import { explorerAddress, explorerTx } from "@/lib/constants";
import { fundRequestLink, short, transactionRequestUrl } from "@/lib/solanaPay";
import { buildMutualRelease, encodeMutualFragment, parseMutualFragment, validateMutualRelease } from "@/lib/mutual";
import { classifyLeaseLoadError, closingSignature, type LeaseLoadProblem } from "@/lib/leaseLoad";
import { useChainNow } from "./useChainNow";
import { LeaseProblem } from "./LeaseProblem";
import { Qr } from "./Qr";
import { CopyField } from "./CopyField";

type Load = { state: "loading" } | { state: "missing" } | { state: "error"; problem: LeaseLoadProblem } | { state: "ok"; lease: Lease };
/** Closing tx lookup for a missing lease: undefined = looking, null = no history / lookup failed. */
type ClosedTx = { sig: string; blockTime?: number | null } | null | undefined;

export function LeaseView({ address }: { address: PublicKey }) {
  const { connection } = useConnection();
  const { publicKey, sendTransaction, signTransaction } = useWallet();
  const now = useChainNow();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [admin, setAdmin] = useState<PublicKey | null>(null);
  const [busy, setBusy] = useState<ActionKind | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string; sig?: string } | null>(null);
  const [lastClosedSig, setLastClosedSig] = useState<string | null>(null);
  const [closedTx, setClosedTx] = useState<ClosedTx>(undefined);
  const [historyFailed, setHistoryFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const l = await fetchLease(connection, address);
      setLoad(l ? { state: "ok", lease: l } : { state: "missing" });
    } catch (e) {
      setLoad({ state: "error", problem: classifyLeaseLoadError(e) });
    }
  }, [connection, address]);

  useEffect(() => {
    refresh();
    fetchConfig(connection)
      .then((c) => setAdmin(c?.admin ?? null))
      .catch(() => setAdmin(null));
    const id = setInterval(refresh, 15000);
    return () => clearInterval(id);
  }, [refresh, connection]);

  // A missing account is either a closed lease or an address that never held one. The newest
  // successful signature on the address is the transaction that closed it.
  const missing = load.state === "missing";
  useEffect(() => {
    if (!missing || lastClosedSig) return;
    let cancelled = false;
    connection
      .getSignaturesForAddress(address, { limit: 10 }, "confirmed")
      .then((sigs) => {
        if (cancelled) return;
        const c = closingSignature(sigs);
        setClosedTx(c ? { sig: c.signature, blockTime: c.blockTime } : null);
      })
      .catch(() => {
        if (cancelled) return;
        setHistoryFailed(true);
        setClosedTx(null);
      });
    return () => {
      cancelled = true;
    };
  }, [missing, lastClosedSig, connection, address]);

  const run = useCallback(
    async (kind: ActionKind, params: Parameters<typeof buildActionIxs>[3] = {}) => {
      if (load.state !== "ok" || !publicKey) return;
      setBusy(kind);
      setMsg(null);
      try {
        const ixs = buildActionIxs(kind, load.lease, publicKey, params);
        const sig = await simulateThenSend(connection, publicKey, ixs, sendTransaction);
        const closes = !["fund", "propose", "dispute"].includes(kind);
        if (closes) setLastClosedSig(sig);
        setMsg({ kind: "ok", text: `${ACTION_LABELS[kind]}: done.`, sig });
        await refresh();
      } catch (e) {
        setMsg({ kind: "err", text: mapError(e).message });
      } finally {
        setBusy(null);
      }
    },
    [load, publicKey, connection, sendTransaction, refresh],
  );

  if (load.state === "loading") return <section className="card">Loading lease…</section>;
  if (load.state === "error") {
    if (load.problem.kind === "foreign")
      return (
        <LeaseProblem title="Not a SewaCheck lease">
          <p>
            This address exists on Solana devnet, but it isn&apos;t a SewaCheck Escrow lease. It may be a wallet or a
            token account. Ask the landlord for the lease link, or open the lease from your list.
          </p>
        </LeaseProblem>
      );
    return (
      <LeaseProblem
        title="Couldn't load this lease"
        tone="error"
        action={
          <button className="btn primary" type="button" onClick={() => refresh()}>
            Try again
          </button>
        }
      >
        <p>
          We couldn&apos;t reach Solana devnet, so the lease can&apos;t be shown right now. Nothing has changed on-chain;
          this page retries every 15 seconds.
        </p>
        <p className="small">Details: {load.problem.message}</p>
      </LeaseProblem>
    );
  }
  if (load.state === "missing") {
    const sig = lastClosedSig ?? closedTx?.sig ?? null;
    if (!sig && closedTx === undefined) return <section className="card">Loading lease…</section>;
    if (sig)
      return (
        <LeaseProblem title="Lease closed">
          <p>
            This lease was settled or cancelled and its account closed on-chain
            {closedTx?.blockTime && !lastClosedSig ? <> on {formatTs(closedTx.blockTime)}</> : null}.{" "}
            <a href={explorerTx(sig)} target="_blank" rel="noreferrer noopener">
              View the closing transaction
            </a>
            .
          </p>
        </LeaseProblem>
      );
    return (
      <LeaseProblem title={historyFailed ? "Lease closed or not found" : "Lease not found"}>
        {historyFailed ? (
          <p>
            There is no open lease at this address. Settled and cancelled leases are closed on-chain; check the{" "}
            <a href={explorerAddress(address.toBase58())} target="_blank" rel="noreferrer noopener">
              address history on Explorer
            </a>
            .
          </p>
        ) : (
          <p>
            Nothing has ever happened at this address on devnet. Check that the link is complete, or open the lease from
            your list.
          </p>
        )}
      </LeaseProblem>
    );
  }

  const lease = load.lease;
  return (
    <LeaseDetails
      address={address}
      lease={lease}
      admin={admin}
      now={now}
      wallet={publicKey}
      busy={busy}
      msg={msg}
      run={run}
      onRefresh={refresh}
      cosign={async (tx: Transaction) => {
        if (!signTransaction) throw new Error("This wallet can't sign without sending.");
        return signTransaction(tx);
      }}
      setMsg={setMsg}
      setLastClosedSig={setLastClosedSig}
    />
  );
}

interface DetailsProps {
  address: PublicKey;
  lease: Lease;
  admin: PublicKey | null;
  now: number;
  wallet: PublicKey | null;
  busy: ActionKind | null;
  msg: { kind: "ok" | "err"; text: string; sig?: string } | null;
  run: (kind: ActionKind, p?: Parameters<typeof buildActionIxs>[3]) => Promise<void>;
  onRefresh: () => Promise<void>;
  cosign: (tx: Transaction) => Promise<Transaction>;
  setMsg: (m: DetailsProps["msg"]) => void;
  setLastClosedSig: (s: string) => void;
}

function LeaseDetails(p: DetailsProps) {
  const { lease, now, wallet, admin, address } = p;
  const d = deadlines(lease);
  const actions = availableActions(lease, wallet, now, admin);
  const role = roleOf(lease, wallet, admin);
  const arb = effectiveArbiter(lease, admin);
  const noArbiter = lease.arbiter.equals(PublicKey.default);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const leaseUrl = `${origin}/lease/${address.toBase58()}`;

  const timeline: { label: string; at: number; note?: string }[] = [
    { label: "Lease ends", at: d.leaseEnd },
    { label: "Claim window closes", at: d.claimDeadline, note: "Landlord can propose a deduction until then; after it, anyone can refund the tenant." },
  ];
  if (d.responseDeadline) timeline.push({ label: "Tenant response deadline", at: d.responseDeadline, note: "Tenant can dispute until then; silence means acceptance." });
  if (d.arbiterDeadline) timeline.push({ label: "Arbiter deadline", at: d.arbiterDeadline, note: "No ruling by then: anyone can refund the tenant in full." });

  return (
    <div className="stack">
      <section className="card">
        <div className="status-row">
          <span className={`status status-${lease.status}`}>{lease.status}</span>
          {role && <span className="pill">You: {role === "anyone" ? "viewer" : role}</span>}
          <button className="btn small ghost" type="button" onClick={() => p.onRefresh()}>
            Refresh
          </button>
        </div>
        <h2>{STATUS_TEXT[lease.status]}</h2>
        <dl className="facts">
          <div>
            <dt>Deposit</dt>
            <dd>
              {formatUsdc(lease.funded)} / {formatUsdc(lease.amount)} USDC
            </dd>
          </div>
          {lease.deduction > 0n && (
            <div>
              <dt>Claimed deduction</dt>
              <dd>{formatUsdc(lease.deduction)} USDC</dd>
            </div>
          )}
          <div>
            <dt>Landlord</dt>
            <dd className="mono">{short(lease.landlord)}</dd>
          </div>
          <div>
            <dt>Tenant</dt>
            <dd className="mono">{short(lease.tenant)}</dd>
          </div>
          <div>
            <dt>Arbiter</dt>
            <dd className="mono">{noArbiter ? `SewaCheck fallback${arb ? ` (${short(arb)})` : ""}` : short(lease.arbiter)}</dd>
          </div>
          <div>
            <dt>Windows</dt>
            <dd>
              claim {windowLabel(lease.claimWindowSecs)} · response {windowLabel(lease.responseWindowSecs)} · arbiter {windowLabel(lease.arbiterWindowSecs)}
            </dd>
          </div>
          {!isZero(lease.termsHash) && (
            <div>
              <dt>Agreement SHA-256</dt>
              <dd className="mono break">{toHex(lease.termsHash)}</dd>
            </div>
          )}
          {!isZero(lease.evidenceHash) && (
            <div>
              <dt>Evidence SHA-256</dt>
              <dd className="mono break">{toHex(lease.evidenceHash)}</dd>
            </div>
          )}
        </dl>
        <p className="muted small">
          Lease{" "}
          <a href={explorerAddress(address.toBase58())} target="_blank" rel="noreferrer noopener" className="mono">
            {short(address)}
          </a>{" "}
          · times shown in your timezone
        </p>
      </section>

      <section className="card">
        <h3>Timeline</h3>
        <ol className="timeline">
          {timeline.map((t) => (
            <li key={t.label} className={now > t.at ? "past" : ""}>
              <div className="tl-head">
                <strong>{t.label}</strong>
                <span>{now > t.at ? "passed" : `in ${formatDuration(t.at - now)}`}</span>
              </div>
              <div className="muted small">{formatTs(t.at)}</div>
              {t.note && <div className="muted small">{t.note}</div>}
            </li>
          ))}
        </ol>
      </section>

      {lease.status === "Created" && (
        <section className="card">
          <h3>Fund the deposit</h3>
          <p className="muted">
            Tenant: scan with a Solana Pay wallet (Phantom, Solflare) or connect below. Remaining:{" "}
            <strong>{formatUsdc(lease.amount - lease.funded)} USDC</strong>.
          </p>
          <div className="qr-row">
            <Qr value={transactionRequestUrl(fundRequestLink(origin || "https://localhost", address))} label="Solana Pay: fund deposit" />
            <Qr value={leaseUrl} label="This lease page" />
          </div>
          <CopyField label="Share with tenant" value={leaseUrl} />
        </section>
      )}

      <section className="card">
        <h3>Actions</h3>
        {p.msg && (
          <p className={p.msg.kind === "ok" ? "success" : "error"} role={p.msg.kind === "err" ? "alert" : "status"}>
            {p.msg.text}{" "}
            {p.msg.sig && (
              <a href={explorerTx(p.msg.sig)} target="_blank" rel="noreferrer noopener">
                View transaction
              </a>
            )}
          </p>
        )}
        {actions.length === 0 && <p className="muted">No actions available.</p>}
        <div className="actions">
          {actions.map((a) => (
            <ActionCard key={a.kind} a={a} {...p} />
          ))}
        </div>
        <MutualCosign {...p} />
      </section>
    </div>
  );
}

function ActionCard(props: DetailsProps & { a: ActionState }) {
  const { a, lease, busy, run, now } = props;
  const [amount, setAmount] = useState(() => formatUsdc(lease.amount - lease.funded).replace(/,/g, ""));
  const [deduction, setDeduction] = useState("");
  const [toLandlord, setToLandlord] = useState("");
  const [evidence, setEvidence] = useState<{ name: string; hash: Uint8Array } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const isBusy = busy === a.kind;
  const label = ACTION_LABELS[a.kind];
  const disabled = !a.enabled || !!busy;
  const waiting = !a.enabled && a.opensAt && a.opensAt > now ? ` (in ${formatDuration(a.opensAt - now)})` : "";

  const go = async () => {
    setErr(null);
    try {
      switch (a.kind) {
        case "fund":
          return await run("fund", { amount: parseUsdc(amount) });
        case "propose": {
          if (!evidence) throw new Error("Choose an evidence file (photos, invoice, report).");
          return await run("propose", { deduction: parseUsdc(deduction), evidenceHash: evidence.hash });
        }
        case "resolve": {
          const v = toLandlord.trim() === "0" ? 0n : parseUsdc(toLandlord);
          if (v > lease.deduction) throw new Error("The ruling can't exceed the claimed deduction.");
          return await run("resolve", { toLandlord: v });
        }
        case "mutual_release":
          return; // handled by MutualStart
        default:
          return await run(a.kind);
      }
    } catch (e) {
      setErr(mapError(e).message);
    }
  };

  if (a.kind === "mutual_release") return <MutualStart {...props} />;

  return (
    <div className={`action ${a.enabled ? "" : "disabled"}`}>
      <div className="action-head">
        <strong>{label}</strong>
        <span className="muted small">{a.role === "anyone" ? "anyone" : a.role === "party" ? "landlord or tenant" : a.role}</span>
      </div>
      {a.kind === "fund" && a.enabled && (
        <label>
          Amount (USDC)
          <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </label>
      )}
      {a.kind === "propose" && a.enabled && (
        <>
          <label>
            Deduction (USDC, max {formatUsdc(lease.funded)})
            <input value={deduction} onChange={(e) => setDeduction(e.target.value)} inputMode="decimal" />
          </label>
          <label>
            <span>
              Evidence file <span className="hint">(hashed on your device, never uploaded)</span>
            </span>
            <input
              type="file"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                setEvidence(null);
                if (!f) return;
                if (f.size > MAX_HASH_FILE_BYTES) return setErr("File too large.");
                setEvidence({ name: f.name, hash: await sha256File(f) });
              }}
            />
            {evidence && <small className="mono">SHA-256 {toHex(evidence.hash).slice(0, 16)}… ({evidence.name})</small>}
          </label>
        </>
      )}
      {a.kind === "accept" && a.enabled && (
        <p className="small">
          Landlord gets {formatUsdc(lease.deduction)} USDC; you get the rest ({formatUsdc(lease.funded - lease.deduction)} USDC).
        </p>
      )}
      {a.kind === "resolve" && a.enabled && (
        <label>
          Award to landlord (USDC, 0 – {formatUsdc(lease.deduction)})
          <input value={toLandlord} onChange={(e) => setToLandlord(e.target.value)} inputMode="decimal" />
        </label>
      )}
      {(err || (!a.enabled && a.reason)) && <p className={err ? "error small" : "muted small"}>{err ?? `${a.reason}${waiting}`}</p>}
      <button className={`btn ${a.kind === "dispute" || a.kind === "cancel" ? "" : "primary"}`} type="button" disabled={disabled} onClick={go}>
        {isBusy ? "Waiting for wallet…" : label}
      </button>
    </div>
  );
}

/** Party A: build + sign the mutual_release and share a link with party B. */
function MutualStart(props: DetailsProps & { a: ActionState }) {
  const { a, lease, wallet, address, busy } = props;
  const { connection } = useConnection();
  const { signTransaction } = useWallet();
  const [toLandlord, setToLandlord] = useState("0");
  const [link, setLink] = useState<{ url: string; expires: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const start = async () => {
    setErr(null);
    try {
      if (!wallet || !signTransaction) throw new Error("Connect a wallet that can sign.");
      const v = toLandlord.trim() === "0" ? 0n : parseUsdc(toLandlord);
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
      const tx = buildMutualRelease(lease, wallet, v, blockhash, lastValidBlockHeight);
      await simulateOrThrow(connection, tx);
      const signed = await signTransaction(tx);
      const frag = encodeMutualFragment(signed, lastValidBlockHeight);
      setLink({ url: `${window.location.origin}/lease/${address.toBase58()}#${frag}`, expires: Date.now() + 60_000 });
    } catch (e) {
      setErr(mapError(e).message);
    }
  };

  return (
    <div className={`action ${a.enabled ? "" : "disabled"}`}>
      <div className="action-head">
        <strong>{ACTION_LABELS.mutual_release}</strong>
        <span className="muted small">landlord + tenant both sign</span>
      </div>
      {a.enabled && !link && (
        <>
          <label>
            Amount to landlord (USDC, 0 – {formatUsdc(lease.funded)}); the rest goes to the tenant
            <input value={toLandlord} onChange={(e) => setToLandlord(e.target.value)} inputMode="decimal" />
          </label>
          <p className="muted small">You sign first, then the other party opens the link and co-signs within about a minute (keep both pages open).</p>
        </>
      )}
      {link && (
        <>
          <CopyField label="Send to the other party now (valid ~60 s)" value={link.url} />
          <Qr value={link.url} label="Co-sign link" size={180} />
        </>
      )}
      {(err || (!a.enabled && a.reason)) && <p className={err ? "error small" : "muted small"}>{err ?? a.reason}</p>}
      {!link && (
        <button className="btn" type="button" disabled={!a.enabled || !!busy} onClick={start}>
          Sign and create co-sign link
        </button>
      )}
    </div>
  );
}

/** Party B: a link with #mr=… was opened; validate, show the split, co-sign and send. */
function MutualCosign(props: DetailsProps) {
  const { lease, address, wallet, cosign, setMsg, setLastClosedSig, onRefresh } = props;
  const { connection } = useConnection();
  const [hash, setHash] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const read = () => setHash(window.location.hash);
    read();
    window.addEventListener("hashchange", read);
    return () => window.removeEventListener("hashchange", read);
  }, []);
  const draft = useMemo(() => (hash.includes("mr=") ? parseMutualFragment(hash) : null), [hash]);
  const check = useMemo(() => {
    if (!draft || !wallet) return null;
    try {
      return { ok: true as const, ...validateMutualRelease(draft.tx, lease, address, wallet) };
    } catch (e) {
      return { ok: false as const, error: (e as Error).message };
    }
  }, [draft, lease, address, wallet]);

  if (!hash.includes("mr=")) return null;
  if (!draft) return <p className="error">This co-sign link is malformed.</p>;

  const clear = () => {
    history.replaceState(null, "", window.location.pathname);
    setHash("");
  };

  return (
    <div className="action highlight">
      <div className="action-head">
        <strong>Co-sign release by agreement</strong>
      </div>
      {!wallet && <p className="muted">Connect your wallet (the other party of this lease) to review.</p>}
      {check && !check.ok && <p className="error">Can&apos;t co-sign: {check.error}</p>}
      {check && check.ok && (
        <>
          <p>
            Proposed by <span className="mono">{short(check.initiator!)}</span>: landlord gets <strong>{formatUsdc(check.toLandlord)} USDC</strong>,
            tenant gets <strong>{formatUsdc(check.toTenant)} USDC</strong> (plus any extra tokens in the vault).
          </p>
          <button
            className="btn primary"
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const h = await connection.getBlockHeight("confirmed");
                if (h > draft.lastValidBlockHeight) throw new Error("This link has expired. Ask the other party to create a new one.");
                const signed = await cosign(draft.tx);
                const sig = await connection.sendRawTransaction(signed.serialize());
                const res = await connection.confirmTransaction(
                  { signature: sig, blockhash: draft.tx.recentBlockhash!, lastValidBlockHeight: draft.lastValidBlockHeight },
                  "confirmed",
                );
                if (res.value.err) throw new Error(`Transaction failed: ${JSON.stringify(res.value.err)}`);
                setLastClosedSig(sig);
                setMsg({ kind: "ok", text: "Released by agreement.", sig });
                clear();
                await onRefresh();
              } catch (e) {
                setMsg({ kind: "err", text: mapError(e).message });
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Signing…" : "Co-sign and release"}
          </button>
        </>
      )}
      <button className="btn small ghost" type="button" onClick={clear}>
        Dismiss
      </button>
    </div>
  );
}
