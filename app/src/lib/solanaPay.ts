import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { decodeLease, type Lease } from "./codec";
import { PROGRAM_ID, USDC_MINT } from "./constants";
import { formatUsdc } from "./amount";
import { buildActionIxs } from "./tx";

/**
 * Solana Pay transaction-request link (spec: https://docs.solanapay.com/spec):
 *   solana:<link>
 * The link must be an absolute https URL; when it has a query string it must be
 * URL-encoded so the wallet doesn't confuse its params with Solana Pay's own.
 */
export function transactionRequestUrl(link: string): string {
  const u = new URL(link);
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("link must be http(s)");
  const s = u.toString();
  return `solana:${u.search ? encodeURIComponent(s) : s}`;
}

/** The API endpoint wallets call for a lease. */
export function fundRequestLink(origin: string, lease: PublicKey): string {
  const u = new URL("/api/pay/fund", origin);
  u.searchParams.set("lease", lease.toBase58());
  return u.toString();
}

/** Strict base58 public key parse for untrusted input (query params, JSON bodies). */
export function parsePubkey(v: unknown): PublicKey | null {
  if (typeof v !== "string" || v.length < 32 || v.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(v)) return null;
  try {
    const pk = new PublicKey(v);
    return pk.toBase58() === v ? pk : null;
  } catch {
    return null;
  }
}

export class PayError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

/** Loads and validates a lease owned by the program. */
export async function loadLease(conn: Connection, lease: PublicKey): Promise<Lease> {
  const info = await conn.getAccountInfo(lease, "confirmed");
  if (!info) throw new PayError("Lease not found on devnet (it may be closed).", 404);
  if (!info.owner.equals(PROGRAM_ID)) throw new PayError("That address is not a SewaCheck lease.");
  try {
    return decodeLease(info.data);
  } catch {
    throw new PayError("That address is not a SewaCheck lease.");
  }
}

/**
 * Builds the unsigned fund_deposit transaction a wallet will sign for the Solana Pay POST.
 * Funds the whole remaining deposit. Fee payer = the tenant (`account`).
 */
export async function buildFundTransaction(
  conn: Connection,
  leaseAddr: PublicKey,
  account: PublicKey,
): Promise<{ transaction: string; message: string; lease: Lease }> {
  const lease = await loadLease(conn, leaseAddr);
  if (!lease.mint.equals(USDC_MINT)) throw new PayError("Lease mint is not the configured USDC mint.");
  if (lease.status !== "Created") throw new PayError("This deposit is already funded or closed.");
  if (!account.equals(lease.tenant))
    throw new PayError(`Only the tenant wallet ${short(lease.tenant)} can fund this deposit.`, 403);
  const remaining = lease.amount - lease.funded;
  if (remaining <= 0n) throw new PayError("Nothing left to fund.");

  const tx = new Transaction();
  tx.add(...buildActionIxs("fund", lease, account, { amount: remaining }));
  tx.feePayer = account;
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
  const transaction = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  return {
    transaction,
    message: `Lock ${formatUsdc(remaining)} USDC deposit in SewaCheck escrow`,
    lease,
  };
}

export function short(pk: PublicKey | string): string {
  const s = typeof pk === "string" ? pk : pk.toBase58();
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}
