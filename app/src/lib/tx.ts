import { Buffer } from "buffer";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction } from "@solana/spl-token";
import {
  PROGRAM_ID,
  USDC_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "./constants";
import { concatBytes, i64le, ixDiscriminator, u64le, type Lease } from "./codec";
import { configPda, leasePda, usdcAta, vaultPda } from "./pda";

const w = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: true });
const r = (pubkey: PublicKey, isSigner = false): AccountMeta => ({ pubkey, isSigner, isWritable: false });
const ix = (keys: AccountMeta[], data: Uint8Array) =>
  new TransactionInstruction({ programId: PROGRAM_ID, keys, data: Buffer.from(data) });

/** The lease fields every instruction needs to derive its accounts. */
export type LeaseRef = Pick<Lease, "landlord" | "tenant" | "leaseId" | "mint">;

export function leaseAddresses(l: LeaseRef) {
  const lease = leasePda(l.landlord, l.tenant, l.leaseId);
  return {
    lease,
    vault: vaultPda(lease),
    landlordToken: usdcAta(l.landlord, l.mint),
    tenantToken: usdcAta(l.tenant, l.mint),
  };
}

/** Idempotent ATA creation so payouts never fail on a missing recipient token account. */
export function ensureAtaIx(payer: PublicKey, owner: PublicKey, mint: PublicKey = USDC_MINT) {
  return createAssociatedTokenAccountIdempotentInstruction(
    payer,
    usdcAta(owner, mint),
    owner,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );
}

export interface CreateLeaseArgs {
  landlord: PublicKey;
  tenant: PublicKey;
  leaseId: bigint;
  amount: bigint;
  leaseEndTs: bigint;
  arbiter?: PublicKey | null;
  termsHash?: Uint8Array | null;
  claimWindowSecs?: bigint;
  responseWindowSecs?: bigint;
  arbiterWindowSecs?: bigint;
  mint?: PublicKey;
}

export function createLeaseIx(a: CreateLeaseArgs): { ix: TransactionInstruction; lease: PublicKey } {
  const mint = a.mint ?? USDC_MINT;
  const terms = a.termsHash ?? new Uint8Array(32);
  if (terms.length !== 32) throw new Error("terms hash must be 32 bytes");
  const lease = leasePda(a.landlord, a.tenant, a.leaseId);
  const data = concatBytes(
    ixDiscriminator("create_lease"),
    u64le(a.leaseId),
    u64le(a.amount),
    i64le(a.leaseEndTs),
    (a.arbiter ?? PublicKey.default).toBytes(),
    terms,
    i64le(a.claimWindowSecs ?? 0n),
    i64le(a.responseWindowSecs ?? 0n),
    i64le(a.arbiterWindowSecs ?? 0n),
  );
  return {
    lease,
    ix: ix(
      [
        w(a.landlord, true),
        r(a.tenant),
        r(configPda()),
        r(mint),
        w(lease),
        w(vaultPda(lease)),
        r(TOKEN_PROGRAM_ID),
        r(SystemProgram.programId),
      ],
      data,
    ),
  };
}

export function fundDepositIx(l: LeaseRef, amount: bigint) {
  const a = leaseAddresses(l);
  return ix(
    [r(l.tenant, true), w(a.lease), r(l.mint), w(a.tenantToken), w(a.vault), r(TOKEN_PROGRAM_ID)],
    concatBytes(ixDiscriminator("fund_deposit"), u64le(amount)),
  );
}

type CloseOutName = "cancel_lease" | "auto_refund" | "arbiter_timeout";
function closeOutIx(name: CloseOutName, l: LeaseRef, caller: PublicKey) {
  const a = leaseAddresses(l);
  return ix(
    [r(caller, true), w(a.lease), w(l.landlord), r(l.mint), w(a.tenantToken), w(a.vault), r(TOKEN_PROGRAM_ID)],
    ixDiscriminator(name),
  );
}
export const cancelLeaseIx = (l: LeaseRef, caller: PublicKey) => closeOutIx("cancel_lease", l, caller);
export const autoRefundIx = (l: LeaseRef, caller: PublicKey) => closeOutIx("auto_refund", l, caller);
export const arbiterTimeoutIx = (l: LeaseRef, caller: PublicKey) => closeOutIx("arbiter_timeout", l, caller);

export function proposeDeductionIx(l: LeaseRef, deduction: bigint, evidenceHash: Uint8Array) {
  if (evidenceHash.length !== 32) throw new Error("evidence hash must be 32 bytes");
  const a = leaseAddresses(l);
  return ix(
    [r(l.landlord, true), w(a.lease)],
    concatBytes(ixDiscriminator("propose_deduction"), u64le(deduction), evidenceHash),
  );
}

export function disputeIx(l: LeaseRef) {
  const a = leaseAddresses(l);
  return ix([r(l.tenant, true), w(a.lease)], ixDiscriminator("dispute"));
}

type SettleName = "accept_deduction" | "auto_accept";
function settleIx(name: SettleName, l: LeaseRef, caller: PublicKey) {
  const a = leaseAddresses(l);
  return ix(
    [
      r(caller, true),
      w(a.lease),
      w(l.landlord),
      r(l.mint),
      w(a.landlordToken),
      w(a.tenantToken),
      w(a.vault),
      r(TOKEN_PROGRAM_ID),
    ],
    ixDiscriminator(name),
  );
}
export const acceptDeductionIx = (l: LeaseRef) => settleIx("accept_deduction", l, l.tenant);
export const autoAcceptIx = (l: LeaseRef, caller: PublicKey) => settleIx("auto_accept", l, caller);

export function resolveDisputeIx(l: LeaseRef, arbiter: PublicKey, toLandlord: bigint) {
  const a = leaseAddresses(l);
  return ix(
    [
      r(arbiter, true),
      r(configPda()),
      w(a.lease),
      w(l.landlord),
      r(l.mint),
      w(a.landlordToken),
      w(a.tenantToken),
      w(a.vault),
      r(TOKEN_PROGRAM_ID),
    ],
    concatBytes(ixDiscriminator("resolve_dispute"), u64le(toLandlord)),
  );
}

export function mutualReleaseIx(l: LeaseRef, toLandlord: bigint) {
  const a = leaseAddresses(l);
  return ix(
    [
      w(l.landlord, true),
      r(l.tenant, true),
      w(a.lease),
      r(l.mint),
      w(a.landlordToken),
      w(a.tenantToken),
      w(a.vault),
      r(TOKEN_PROGRAM_ID),
    ],
    concatBytes(ixDiscriminator("mutual_release"), u64le(toLandlord)),
  );
}

// ---------------------------------------------------------------------------------------
// Full instruction lists per user action (what the UI and the e2e script actually send).
// Every payout first makes sure each recipient's USDC ATA exists (payer = the signer), so a
// landlord or tenant who never held devnet USDC can still be paid.
// ---------------------------------------------------------------------------------------

export type ActionKind =
  | "fund"
  | "cancel"
  | "propose"
  | "accept"
  | "dispute"
  | "resolve"
  | "auto_accept"
  | "auto_refund"
  | "arbiter_timeout"
  | "mutual_release";

export interface ActionParams {
  amount?: bigint; // fund
  deduction?: bigint; // propose
  evidenceHash?: Uint8Array; // propose
  toLandlord?: bigint; // resolve / mutual_release
}

export function buildActionIxs(
  kind: ActionKind,
  l: LeaseRef,
  signer: PublicKey,
  p: ActionParams = {},
): TransactionInstruction[] {
  const tenantAta = ensureAtaIx(signer, l.tenant, l.mint);
  const landlordAta = ensureAtaIx(signer, l.landlord, l.mint);
  const need = <T>(v: T | undefined, what: string): T => {
    if (v === undefined) throw new Error(`Missing ${what}`);
    return v;
  };
  switch (kind) {
    case "fund":
      // Idempotent create: a tenant with no USDC account gets a clear "insufficient funds"
      // error from the token program instead of an opaque AccountNotInitialized.
      return [tenantAta, fundDepositIx(l, need(p.amount, "amount"))];
    case "cancel":
      return [tenantAta, cancelLeaseIx(l, signer)];
    case "auto_refund":
      return [tenantAta, autoRefundIx(l, signer)];
    case "arbiter_timeout":
      return [tenantAta, arbiterTimeoutIx(l, signer)];
    case "propose":
      return [proposeDeductionIx(l, need(p.deduction, "deduction"), need(p.evidenceHash, "evidence hash"))];
    case "dispute":
      return [disputeIx(l)];
    case "accept":
      return [landlordAta, tenantAta, acceptDeductionIx(l)];
    case "auto_accept":
      return [landlordAta, tenantAta, autoAcceptIx(l, signer)];
    case "resolve":
      return [landlordAta, tenantAta, resolveDisputeIx(l, signer, need(p.toLandlord, "ruling"))];
    case "mutual_release":
      return [landlordAta, tenantAta, mutualReleaseIx(l, need(p.toLandlord, "split"))];
  }
}
