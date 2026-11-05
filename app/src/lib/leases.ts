import bs58 from "bs58";
import { Connection, PublicKey, type GetProgramAccountsFilter } from "@solana/web3.js";
import { accountDiscriminator, decodeConfig, decodeLease, type Config, type Lease } from "./codec";
import { LEASE_ACCOUNT_SIZE, LEASE_LANDLORD_OFFSET, LEASE_TENANT_OFFSET, PROGRAM_ID } from "./constants";
import { configPda } from "./pda";

export function leaseFilters(role: "landlord" | "tenant", wallet: PublicKey): GetProgramAccountsFilter[] {
  return [
    { dataSize: LEASE_ACCOUNT_SIZE },
    { memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("Lease")) } },
    {
      memcmp: {
        offset: role === "landlord" ? LEASE_LANDLORD_OFFSET : LEASE_TENANT_OFFSET,
        bytes: wallet.toBase58(),
      },
    },
  ];
}

export interface LeaseRow {
  address: PublicKey;
  lease: Lease;
  role: "landlord" | "tenant";
}

/** All open leases where the wallet is landlord or tenant (closed leases no longer exist on-chain). */
export async function fetchMyLeases(conn: Connection, wallet: PublicKey): Promise<LeaseRow[]> {
  const [asL, asT] = await Promise.all(
    (["landlord", "tenant"] as const).map((role) =>
      conn
        .getProgramAccounts(PROGRAM_ID, { commitment: "confirmed", filters: leaseFilters(role, wallet) })
        .then((accs) => accs.map((a) => ({ a, role }))),
    ),
  );
  const rows: LeaseRow[] = [];
  for (const { a, role } of [...(asL ?? []), ...(asT ?? [])]) {
    try {
      rows.push({ address: a.pubkey, lease: decodeLease(a.account.data), role });
    } catch {
      // skip undecodable accounts (e.g. created by an older program version)
    }
  }
  rows.sort((x, y) => Number(y.lease.leaseEndTs - x.lease.leaseEndTs));
  return rows;
}

export async function fetchLease(conn: Connection, address: PublicKey): Promise<Lease | null> {
  const info = await conn.getAccountInfo(address, "confirmed");
  if (!info) return null;
  if (!info.owner.equals(PROGRAM_ID)) throw new Error("That address is not a SewaCheck lease.");
  return decodeLease(info.data);
}

export async function fetchConfig(conn: Connection): Promise<Config | null> {
  const info = await conn.getAccountInfo(configPda(), "confirmed");
  return info ? decodeConfig(info.data) : null;
}

/** Chain time (unix seconds) for gating actions; falls back to the local clock. */
export async function fetchChainTime(conn: Connection): Promise<number> {
  try {
    const slot = await conn.getSlot("confirmed");
    const t = await conn.getBlockTime(slot);
    if (t) return t;
  } catch {
    /* ignore */
  }
  return Math.floor(Date.now() / 1000);
}
