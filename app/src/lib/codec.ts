import { PublicKey } from "@solana/web3.js";
import idl from "../idl/sewacheck_escrow.json";
import { LEASE_ACCOUNT_SIZE } from "./constants";

export const U64_MAX = (1n << 64n) - 1n;
export const I64_MAX = (1n << 63n) - 1n;
export const I64_MIN = -(1n << 63n);

type IxName =
  | "create_lease"
  | "fund_deposit"
  | "cancel_lease"
  | "auto_refund"
  | "propose_deduction"
  | "accept_deduction"
  | "dispute"
  | "resolve_dispute"
  | "auto_accept"
  | "arbiter_timeout"
  | "mutual_release"
  | "initialize_config"
  | "update_config";

const ixDisc = new Map<string, Uint8Array>(
  idl.instructions.map((i) => [i.name, Uint8Array.from(i.discriminator)]),
);
const accDisc = new Map<string, Uint8Array>(
  idl.accounts.map((a) => [a.name, Uint8Array.from(a.discriminator)]),
);

export function ixDiscriminator(name: IxName): Uint8Array {
  const d = ixDisc.get(name);
  if (!d) throw new Error(`Unknown instruction ${name}`);
  return d;
}
export function accountDiscriminator(name: "Lease" | "Config"): Uint8Array {
  const d = accDisc.get(name);
  if (!d) throw new Error(`Unknown account ${name}`);
  return d;
}

export function u64le(v: bigint | number): Uint8Array {
  const n = BigInt(v);
  if (n < 0n || n > U64_MAX) throw new RangeError(`u64 out of range: ${n}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}
export function i64le(v: bigint | number): Uint8Array {
  const n = BigInt(v);
  if (n < I64_MIN || n > I64_MAX) throw new RangeError(`i64 out of range: ${n}`);
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigInt64(0, n, true);
  return b;
}
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export const LEASE_STATUSES = [
  "Created",
  "Active",
  "DeductionProposed",
  "Disputed",
  "Settled",
  "Cancelled",
] as const;
export type LeaseStatus = (typeof LEASE_STATUSES)[number];

export interface Lease {
  landlord: PublicKey;
  tenant: PublicKey;
  arbiter: PublicKey;
  mint: PublicKey;
  leaseId: bigint;
  amount: bigint;
  funded: bigint;
  leaseEndTs: bigint;
  claimWindowSecs: bigint;
  responseWindowSecs: bigint;
  arbiterWindowSecs: bigint;
  termsHash: Uint8Array;
  status: LeaseStatus;
  deduction: bigint;
  evidenceHash: Uint8Array;
  proposedTs: bigint;
  disputedTs: bigint;
  bump: number;
  vaultBump: number;
}

export interface Config {
  admin: PublicKey;
  usdcMint: PublicKey;
  bump: number;
}

/** Decodes a Lease account (Borsh, Anchor discriminator). Throws on anything else. */
export function decodeLease(data: Uint8Array): Lease {
  if (data.length < LEASE_ACCOUNT_SIZE) throw new Error("Not a lease account (too short)");
  if (!bytesEqual(data.subarray(0, 8), accountDiscriminator("Lease")))
    throw new Error("Not a lease account (discriminator)");
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let o = 8;
  const pk = () => {
    const p = new PublicKey(data.subarray(o, o + 32));
    o += 32;
    return p;
  };
  const u64 = () => {
    const v = dv.getBigUint64(o, true);
    o += 8;
    return v;
  };
  const i64 = () => {
    const v = dv.getBigInt64(o, true);
    o += 8;
    return v;
  };
  const bytes32 = () => {
    const v = Uint8Array.from(data.subarray(o, o + 32));
    o += 32;
    return v;
  };
  const landlord = pk();
  const tenant = pk();
  const arbiter = pk();
  const mint = pk();
  const leaseId = u64();
  const amount = u64();
  const funded = u64();
  const leaseEndTs = i64();
  const claimWindowSecs = i64();
  const responseWindowSecs = i64();
  const arbiterWindowSecs = i64();
  const termsHash = bytes32();
  const statusIdx = data[o++] ?? 255;
  const status = LEASE_STATUSES[statusIdx];
  if (!status) throw new Error(`Unknown lease status ${statusIdx}`);
  const deduction = u64();
  const evidenceHash = bytes32();
  const proposedTs = i64();
  const disputedTs = i64();
  const bump = data[o++] ?? 0;
  const vaultBump = data[o++] ?? 0;
  return {
    landlord,
    tenant,
    arbiter,
    mint,
    leaseId,
    amount,
    funded,
    leaseEndTs,
    claimWindowSecs,
    responseWindowSecs,
    arbiterWindowSecs,
    termsHash,
    status,
    deduction,
    evidenceHash,
    proposedTs,
    disputedTs,
    bump,
    vaultBump,
  };
}

/** Encodes a Lease (used by tests to build fixtures; mirrors decodeLease). */
export function encodeLease(l: Lease): Uint8Array {
  return concatBytes(
    accountDiscriminator("Lease"),
    l.landlord.toBytes(),
    l.tenant.toBytes(),
    l.arbiter.toBytes(),
    l.mint.toBytes(),
    u64le(l.leaseId),
    u64le(l.amount),
    u64le(l.funded),
    i64le(l.leaseEndTs),
    i64le(l.claimWindowSecs),
    i64le(l.responseWindowSecs),
    i64le(l.arbiterWindowSecs),
    l.termsHash,
    Uint8Array.of(LEASE_STATUSES.indexOf(l.status)),
    u64le(l.deduction),
    l.evidenceHash,
    i64le(l.proposedTs),
    i64le(l.disputedTs),
    Uint8Array.of(l.bump, l.vaultBump),
  );
}

export function decodeConfig(data: Uint8Array): Config {
  if (data.length < 73 || !bytesEqual(data.subarray(0, 8), accountDiscriminator("Config")))
    throw new Error("Not a config account");
  return {
    admin: new PublicKey(data.subarray(8, 40)),
    usdcMint: new PublicKey(data.subarray(40, 72)),
    bump: data[72] ?? 0,
  };
}

export function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}
export function isZero(b: Uint8Array): boolean {
  return b.every((x) => x === 0);
}
