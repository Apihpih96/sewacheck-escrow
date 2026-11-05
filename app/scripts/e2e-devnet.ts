/**
 * Headless devnet end-to-end run of the app's own transaction builders (src/lib/*).
 * No browser: local keypairs stand in for the wallets. Keys are read from WALLET_DIR
 * (landlord.json, tenant.json, keeper.json) and are never printed.
 *
 *   WALLET_DIR=/path/to/wallets APP_URL=http://localhost:3000 npx tsx scripts/e2e-devnet.ts <flow>
 *
 * Flows:
 *   pay_dispute_resolve  create (named arbiter) -> fund via the app's Solana Pay POST endpoint ->
 *                        propose (evidence hash) -> dispute -> arbiter resolve_dispute (split)
 *   mutual               create -> fund -> landlord signs mutual_release -> link fragment ->
 *                        tenant validates + co-signs + sends
 *   cancel               create -> partial fund -> tenant cancels (partial refund)
 *   auto_refund          create (short claim window) -> fund -> wait -> keeper cranks auto_refund
 *   auto_accept          create -> fund -> propose -> wait response window -> keeper auto_accept
 *   arbiter_timeout      create (no arbiter) -> fund -> propose -> dispute -> wait -> keeper arbiter_timeout
 *   negatives            program errors are mapped to readable messages (simulation only)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { Connection, Keypair, PublicKey, Transaction, type TransactionInstruction } from "@solana/web3.js";
import { RPC_URL, explorerTx } from "../src/lib/constants";
import { createLeaseIx, buildActionIxs, type ActionKind, type ActionParams } from "../src/lib/tx";
import { randomLeaseId, usdcAta, vaultPda } from "../src/lib/pda";
import { fetchLease, fetchMyLeases, fetchChainTime, fetchConfig } from "../src/lib/leases";
import { mapError } from "../src/lib/errors";
import { availableActions } from "../src/lib/actions";
import { buildMutualRelease, encodeMutualFragment, parseMutualFragment, validateMutualRelease } from "../src/lib/mutual";
import { fundRequestLink, transactionRequestUrl } from "../src/lib/solanaPay";
import { sha256Bytes } from "../src/lib/hash";
import { simulateOrThrow } from "../src/lib/send";
import type { Lease } from "../src/lib/codec";

const WALLET_DIR = process.env.WALLET_DIR;
if (!WALLET_DIR) throw new Error("Set WALLET_DIR to a folder with landlord.json, tenant.json, keeper.json");
const APP_URL = process.env.APP_URL ?? "http://localhost:3000";
const OUT_DIR = process.env.OUT_DIR ?? "/tmp/sewacheck-e2e";
const conn = new Connection(process.env.RPC_URL ?? RPC_URL, "confirmed");
const kp = (n: string) => Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(join(WALLET_DIR, `${n}.json`), "utf8"))));
const landlord = kp("landlord");
const tenant = kp("tenant");
const keeper = kp("keeper"); // arbiter for flow 1 and permissionless cranker
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DEPOSIT = 100_000n; // 0.1 USDC

const log: { step: string; sig?: string; url?: string; note?: string }[] = [];
const checks: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string) {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}

async function send(step: string, ixs: TransactionInstruction[], signers: Keypair[]): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signers[0]!.publicKey, blockhash, lastValidBlockHeight }).add(...ixs);
  await simulateOrThrow(conn, tx); // same pre-flight the UI does
  tx.sign(...signers);
  const sig = await conn.sendRawTransaction(tx.serialize());
  const res = await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  if (res.value.err) throw new Error(`${step} failed: ${JSON.stringify(res.value.err)}`);
  log.push({ step, sig, url: explorerTx(sig) });
  console.log(step, explorerTx(sig));
  await sleep(800); // be gentle with the public devnet RPC (429s)
  return sig;
}

const usdc = async (owner: PublicKey) => {
  try {
    return BigInt((await conn.getTokenAccountBalance(usdcAta(owner))).value.amount);
  } catch {
    return 0n;
  }
};

async function waitChain(t: number) {
  for (let i = 0; i < 90; i++) {
    if ((await fetchChainTime(conn)) > t) return;
    await sleep(2000);
  }
  throw new Error(`chain time never passed ${t}`);
}

async function mustLease(addr: PublicKey): Promise<Lease> {
  for (let i = 0; i < 5; i++) {
    const l = await fetchLease(conn, addr);
    if (l) return l;
    await sleep(1500);
  }
  throw new Error("lease not found");
}

async function create(opts: { endIn: number; claim: number; resp: number; arb: number; arbiter?: PublicKey; amount?: bigint }) {
  const now = await fetchChainTime(conn);
  const leaseId = randomLeaseId();
  const { ix, lease } = createLeaseIx({
    landlord: landlord.publicKey,
    tenant: tenant.publicKey,
    leaseId,
    amount: opts.amount ?? DEPOSIT,
    leaseEndTs: BigInt(now + opts.endIn),
    arbiter: opts.arbiter ?? null,
    termsHash: await sha256Bytes(new TextEncoder().encode("SewaCheck week3 e2e tenancy agreement")),
    claimWindowSecs: BigInt(opts.claim),
    responseWindowSecs: BigInt(opts.resp),
    arbiterWindowSecs: BigInt(opts.arb),
  });
  await send("create_lease", [ix], [landlord]);
  const l = await mustLease(lease);
  check("lease decodes as Created", l.status === "Created" && l.amount === (opts.amount ?? DEPOSIT));
  return { lease, l };
}

async function act(kind: ActionKind, l: Lease, signer: Keypair, p: ActionParams = {}) {
  return send(kind, buildActionIxs(kind, l, signer.publicKey, p), [signer]);
}

async function expectRejected(name: string, kind: ActionKind, l: Lease, signer: Keypair, p: ActionParams, want: RegExp) {
  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: blockhash }).add(...buildActionIxs(kind, l, signer.publicKey, p));
  try {
    await simulateOrThrow(conn, tx);
    check(name, false, "unexpectedly succeeded");
  } catch (e) {
    const m = mapError(e);
    check(name, want.test(`${m.name ?? ""} ${m.message}`), `${m.name ?? m.code ?? ""}: ${m.message}`);
  }
}

async function closed(lease: PublicKey) {
  await sleep(1500);
  const gone = !(await conn.getAccountInfo(lease)) && !(await conn.getAccountInfo(vaultPda(lease)));
  check("lease + vault closed", gone);
}

const flows: Record<string, () => Promise<void>> = {
  async pay_dispute_resolve() {
    const { lease } = await create({ endIn: 25, claim: 300, resp: 300, arb: 300, arbiter: keeper.publicKey });
    const link = fundRequestLink(APP_URL, lease);
    log.push({ step: "solana_pay_url", note: transactionRequestUrl(link) });
    // Solana Pay GET then POST (what a wallet does after scanning the QR)
    const g = await (await fetch(link)).json();
    check("Solana Pay GET returns label + icon", typeof g.label === "string" && /^https?:\/\/.+\/icon\.png$/.test(g.icon));
    const bad = await fetch(link, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: landlord.publicKey.toBase58() }) });
    check("Solana Pay POST refuses a non-tenant (403)", bad.status === 403);
    const res = await fetch(link, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ account: tenant.publicKey.toBase58() }) });
    const body = await res.json();
    check("Solana Pay POST returns a tx", res.status === 200 && typeof body.transaction === "string", body.message);
    const tx = Transaction.from(Buffer.from(body.transaction, "base64"));
    check("Pay tx fee payer is the tenant", !!tx.feePayer?.equals(tenant.publicKey));
    tx.partialSign(tenant); // the wallet signs as-is
    const sig = await conn.sendRawTransaction(tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash: tx.recentBlockhash!, lastValidBlockHeight: tx.lastValidBlockHeight ?? (await conn.getBlockHeight()) + 150 }, "confirmed");
    log.push({ step: "fund_deposit (Solana Pay)", sig, url: explorerTx(sig) });
    console.log("fund_deposit (Solana Pay)", explorerTx(sig));
    let l = await mustLease(lease);
    check("funded via Solana Pay -> Active", l.status === "Active" && l.funded === DEPOSIT);
    const mine = await fetchMyLeases(conn, landlord.publicKey);
    check("list my leases (landlord memcmp) finds it", mine.some((r) => r.address.equals(lease) && r.role === "landlord"));
    const mineT = await fetchMyLeases(conn, tenant.publicKey);
    check("list my leases (tenant memcmp) finds it", mineT.some((r) => r.address.equals(lease) && r.role === "tenant"));
    await expectRejected("propose before lease end -> LeaseNotEnded", "propose", l, landlord, { deduction: 1n, evidenceHash: new Uint8Array(32).fill(1) }, /LeaseNotEnded/);
    await waitChain(Number(l.leaseEndTs));
    const evidence = await sha256Bytes(new TextEncoder().encode("move-out photos + cleaning invoice (never uploaded)"));
    await act("propose", l, landlord, { deduction: 40_000n, evidenceHash: evidence });
    l = await mustLease(lease);
    check("DeductionProposed with evidence hash", l.status === "DeductionProposed" && l.deduction === 40_000n && Buffer.from(l.evidenceHash).equals(Buffer.from(evidence)));
    await act("dispute", l, tenant);
    l = await mustLease(lease);
    check("Disputed", l.status === "Disputed");
    const cfg = await fetchConfig(conn);
    const acts = availableActions(l, keeper.publicKey, await fetchChainTime(conn), cfg?.admin ?? null);
    check("UI offers resolve to the named arbiter", !!acts.find((a) => a.kind === "resolve")?.enabled);
    await expectRejected("ruling above the claim -> ExceedsClaim", "resolve", l, keeper, { toLandlord: 40_001n }, /ExceedsClaim/);
    const [l0, t0] = [await usdc(landlord.publicKey), await usdc(tenant.publicKey)];
    await act("resolve", l, keeper, { toLandlord: 20_000n });
    const [l1, t1] = [await usdc(landlord.publicKey), await usdc(tenant.publicKey)];
    check("arbiter split: landlord +0.02, tenant +0.08", l1 - l0 === 20_000n && t1 - t0 === 80_000n, `landlord ${l1 - l0}, tenant ${t1 - t0}`);
    await closed(lease);
  },

  async mutual() {
    const { lease, l: created } = await create({ endIn: 3600, claim: 300, resp: 300, arb: 300 });
    await act("fund", created, tenant, { amount: DEPOSIT });
    const l = await mustLease(lease);
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("finalized");
    const tx = buildMutualRelease(l, landlord.publicKey, 30_000n, blockhash, lastValidBlockHeight);
    await simulateOrThrow(conn, tx);
    tx.partialSign(landlord);
    const frag = encodeMutualFragment(tx, lastValidBlockHeight);
    const url = `${APP_URL}/lease/${lease.toBase58()}#${frag}`;
    log.push({ step: "mutual co-sign link", note: `${url.slice(0, 120)}… (${url.length} chars)` });
    const draft = parseMutualFragment(`#${frag}`)!;
    const v = validateMutualRelease(draft.tx, l, lease, tenant.publicKey);
    check("tenant validates split from link", v.toLandlord === 30_000n && v.toTenant === 70_000n);
    draft.tx.partialSign(tenant);
    const [l0, t0] = [await usdc(landlord.publicKey), await usdc(tenant.publicKey)];
    const sig = await conn.sendRawTransaction(draft.tx.serialize());
    await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
    log.push({ step: "mutual_release (2 signers)", sig, url: explorerTx(sig) });
    console.log("mutual_release", explorerTx(sig));
    const [l1, t1] = [await usdc(landlord.publicKey), await usdc(tenant.publicKey)];
    check("mutual split: landlord +0.03, tenant +0.07", l1 - l0 === 30_000n && t1 - t0 === 70_000n, `landlord ${l1 - l0}, tenant ${t1 - t0}`);
    await closed(lease);
  },

  async cancel() {
    const { lease, l } = await create({ endIn: 3600, claim: 300, resp: 300, arb: 300 });
    await expectRejected("overfund -> Overfund", "fund", l, tenant, { amount: DEPOSIT + 1n }, /Overfund/);
    await act("fund", l, tenant, { amount: 50_000n });
    const p = await mustLease(lease);
    check("partial fund stays Created", p.status === "Created" && p.funded === 50_000n);
    await expectRejected("outsider cancel -> Unauthorized", "cancel", p, keeper, {}, /Unauthorized/);
    const t0 = await usdc(tenant.publicKey);
    await act("cancel", p, tenant);
    check("partial funding refunded", (await usdc(tenant.publicKey)) - t0 === 50_000n);
    await closed(lease);
  },

  async auto_refund() {
    const { lease, l } = await create({ endIn: 15, claim: 10, resp: 300, arb: 300 });
    await act("fund", l, tenant, { amount: DEPOSIT });
    const a = await mustLease(lease);
    await expectRejected("auto_refund too early -> DeadlineNotReached", "auto_refund", a, keeper, {}, /DeadlineNotReached/);
    await waitChain(Number(a.leaseEndTs + a.claimWindowSecs) + 1);
    const t0 = await usdc(tenant.publicKey);
    await act("auto_refund", a, keeper);
    check("tenant refunded 100%", (await usdc(tenant.publicKey)) - t0 === DEPOSIT);
    await closed(lease);
  },

  async auto_accept() {
    const { lease, l } = await create({ endIn: 15, claim: 300, resp: 10, arb: 300 });
    await act("fund", l, tenant, { amount: DEPOSIT });
    let a = await mustLease(lease);
    await waitChain(Number(a.leaseEndTs));
    await act("propose", a, landlord, { deduction: 20_000n, evidenceHash: await sha256Bytes(new TextEncoder().encode("evidence")) });
    a = await mustLease(lease);
    await expectRejected("auto_accept inside window -> DeadlineNotReached", "auto_accept", a, keeper, {}, /DeadlineNotReached/);
    await waitChain(Number(a.proposedTs + a.responseWindowSecs) + 1);
    await expectRejected("dispute after window -> ResponseWindowClosed", "dispute", a, tenant, {}, /ResponseWindowClosed/);
    const [l0, t0] = [await usdc(landlord.publicKey), await usdc(tenant.publicKey)];
    await act("auto_accept", a, keeper);
    const [l1, t1] = [await usdc(landlord.publicKey), await usdc(tenant.publicKey)];
    check("silence = acceptance: landlord +0.02, tenant +0.08", l1 - l0 === 20_000n && t1 - t0 === 80_000n);
    await closed(lease);
  },

  async arbiter_timeout() {
    const { lease, l } = await create({ endIn: 15, claim: 300, resp: 300, arb: 10 });
    await act("fund", l, tenant, { amount: DEPOSIT });
    let a = await mustLease(lease);
    await waitChain(Number(a.leaseEndTs));
    await act("propose", a, landlord, { deduction: 50_000n, evidenceHash: await sha256Bytes(new TextEncoder().encode("evidence 2")) });
    a = await mustLease(lease);
    await act("dispute", a, tenant);
    a = await mustLease(lease);
    await waitChain(Number(a.disputedTs + a.arbiterWindowSecs) + 1);
    const t0 = await usdc(tenant.publicKey);
    await act("arbiter_timeout", a, keeper);
    check("no ruling in time: tenant gets 100%", (await usdc(tenant.publicKey)) - t0 === DEPOSIT);
    await closed(lease);
  },

  /** Settles any lease left open by an interrupted run (both parties' keys are local). */
  async cleanup() {
    const rows = await fetchMyLeases(conn, landlord.publicKey);
    for (const r of rows.filter((x) => x.lease.tenant.equals(tenant.publicKey))) {
      const l = r.lease;
      console.log("open lease", r.address.toBase58(), l.status, l.funded);
      if (l.status === "Created") await act("cancel", l, tenant);
      else {
        const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
        const tx = buildMutualRelease(l, landlord.publicKey, 0n, blockhash, lastValidBlockHeight);
        tx.sign(landlord, tenant);
        const sig = await conn.sendRawTransaction(tx.serialize());
        await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
        log.push({ step: "cleanup mutual_release (all to tenant)", sig, url: explorerTx(sig) });
      }
      await closed(r.address);
    }
    check("no open e2e leases left", (await fetchMyLeases(conn, landlord.publicKey)).filter((x) => x.lease.tenant.equals(tenant.publicKey)).length === 0);
  },

  async negatives() {
    // create_lease with arbiter == tenant should map to ArbiterIsParty (simulation only)
    const now = await fetchChainTime(conn);
    const { ix } = createLeaseIx({ landlord: landlord.publicKey, tenant: tenant.publicKey, leaseId: randomLeaseId(), amount: 1n, leaseEndTs: BigInt(now + 3600), arbiter: tenant.publicKey });
    const { blockhash } = await conn.getLatestBlockhash();
    try {
      await simulateOrThrow(conn, new Transaction({ feePayer: landlord.publicKey, recentBlockhash: blockhash }).add(ix));
      check("arbiter == tenant rejected", false);
    } catch (e) {
      check("arbiter == tenant -> ArbiterIsParty (mapped)", mapError(e).name === "ArbiterIsParty", mapError(e).message);
    }
    const { ix: past } = createLeaseIx({ landlord: landlord.publicKey, tenant: tenant.publicKey, leaseId: randomLeaseId(), amount: 1n, leaseEndTs: BigInt(now - 10) });
    try {
      await simulateOrThrow(conn, new Transaction({ feePayer: landlord.publicKey, recentBlockhash: blockhash }).add(past));
      check("past end rejected", false);
    } catch (e) {
      check("lease end in past -> LeaseEndInPast (mapped)", mapError(e).name === "LeaseEndInPast", mapError(e).message);
    }
    const bad = await fetch(`${APP_URL}/api/pay/fund?lease=%3Cscript%3E`, { method: "POST", body: "{}" });
    check("pay endpoint rejects a malformed lease param (400)", bad.status === 400);
    const junk = await fetch(fundRequestLink(APP_URL, Keypair.generate().publicKey), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account: tenant.publicKey.toBase58() }),
    });
    check("pay endpoint 404s an unknown lease", junk.status === 404);
  },
};

(async () => {
  const name = process.argv[2] ?? "";
  const flow = flows[name];
  if (!flow) throw new Error(`Unknown flow "${name}". One of: ${Object.keys(flows).join(", ")}`);
  const started = new Date().toISOString();
  let error: string | undefined;
  try {
    await flow();
  } catch (e) {
    error = mapError(e).message;
    console.error("ERROR", error, (e as { logs?: string[] }).logs ?? "");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const out = { flow: name, started, finished: new Date().toISOString(), ok: !error && checks.every((c) => c.ok), error, checks, txs: log };
  writeFileSync(join(OUT_DIR, `${name}.json`), JSON.stringify(out, null, 1));
  console.log(`${out.ok ? "FLOW OK" : "FLOW FAILED"} ${name} (${checks.filter((c) => c.ok).length}/${checks.length} checks)`);
  process.exit(out.ok ? 0 : 1);
})();
