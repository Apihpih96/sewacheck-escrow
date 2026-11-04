import * as anchor from "@anchor-lang/core";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  getAccount,
  getOrCreateAssociatedTokenAccount,
  mintTo,
} from "@solana/spl-token";
import { assert } from "chai";

const BN = anchor.BN;
const DECIMALS = 6;
const DEPOSIT = 3_000_000_000; // 3,000 "USDC" with 6 decimals

describe("sewacheck_escrow: week 1 core escrow", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const connection = provider.connection;
  const program: any = anchor.workspace.SewacheckEscrow;
  const payer = (provider.wallet as any).payer as Keypair;

  const landlord = Keypair.generate();
  const tenant = Keypair.generate();
  const outsider = Keypair.generate();
  const arbiter = Keypair.generate();
  const termsHash = Array.from({ length: 32 }, (_, i) => i);

  let mint: PublicKey;
  let tenantToken: PublicKey;
  let outsiderToken: PublicKey;
  let nextLeaseId = 1;

  // ---------- helpers ----------
  const leasePda = (id: number) =>
    PublicKey.findProgramAddressSync(
      [
        Buffer.from("lease"),
        landlord.publicKey.toBuffer(),
        tenant.publicKey.toBuffer(),
        new BN(id).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    )[0];

  const vaultPda = (lease: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("vault"), lease.toBuffer()],
      program.programId
    )[0];

  async function chainNow(): Promise<number> {
    const slot = await connection.getSlot("confirmed");
    const t = await connection.getBlockTime(slot);
    return t ?? Math.floor(Date.now() / 1000);
  }

  async function airdrop(pk: PublicKey, sol = 10) {
    const sig = await connection.requestAirdrop(pk, sol * LAMPORTS_PER_SOL);
    const bh = await connection.getLatestBlockhash();
    await connection.confirmTransaction({ signature: sig, ...bh }, "confirmed");
  }

  async function expectError(p: Promise<unknown>, code: string) {
    try {
      await p;
    } catch (e: any) {
      const text = [
        e?.error?.errorCode?.code,
        e?.message,
        String(e),
        ...(e?.logs ?? []),
        ...(e?.transactionLogs ?? []),
      ]
        .filter(Boolean)
        .join("\n");
      assert.include(text, code, `expected error ${code}, got:\n${text}`);
      return;
    }
    assert.fail(`expected error ${code}, but the transaction succeeded`);
  }

  async function createLease(opts: {
    amount?: number;
    endInSecs?: number;
    claimWindow?: number;
  } = {}) {
    const id = nextLeaseId++;
    const lease = leasePda(id);
    const vault = vaultPda(lease);
    const end = (await chainNow()) + (opts.endInSecs ?? 30 * 24 * 3600);
    await program.methods
      .createLease(
        new BN(id),
        new BN(opts.amount ?? DEPOSIT),
        new BN(end),
        arbiter.publicKey,
        termsHash,
        new BN(opts.claimWindow ?? 0)
      )
      .accountsStrict({
        landlord: landlord.publicKey,
        tenant: tenant.publicKey,
        mint,
        lease,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([landlord])
      .rpc();
    return { id, lease, vault, end };
  }

  function fund(lease: PublicKey, vault: PublicKey, amount: number, signer = tenant, from = tenantToken) {
    return program.methods
      .fundDeposit(new BN(amount))
      .accountsStrict({
        tenant: signer.publicKey,
        lease,
        mint,
        tenantToken: from,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([signer])
      .rpc();
  }

  function closeOutAccounts(caller: Keypair, lease: PublicKey, vault: PublicKey) {
    return {
      caller: caller.publicKey,
      lease,
      landlord: landlord.publicKey,
      mint,
      tenantToken,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    };
  }

  const cancel = (caller: Keypair, lease: PublicKey, vault: PublicKey) =>
    program.methods
      .cancelLease()
      .accountsStrict(closeOutAccounts(caller, lease, vault))
      .signers([caller])
      .rpc();

  const autoRefund = (caller: Keypair, lease: PublicKey, vault: PublicKey) =>
    program.methods
      .autoRefund()
      .accountsStrict(closeOutAccounts(caller, lease, vault))
      .signers([caller])
      .rpc();

  const tokenBalance = async (pk: PublicKey) =>
    Number((await getAccount(connection, pk)).amount);

  // ---------- setup ----------
  before(async () => {
    await Promise.all([
      airdrop(landlord.publicKey),
      airdrop(tenant.publicKey),
      airdrop(outsider.publicKey),
    ]);
    mint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
    tenantToken = (
      await getOrCreateAssociatedTokenAccount(connection, payer, mint, tenant.publicKey)
    ).address;
    outsiderToken = (
      await getOrCreateAssociatedTokenAccount(connection, payer, mint, outsider.publicKey)
    ).address;
    await mintTo(connection, payer, mint, tenantToken, payer, 100 * DEPOSIT);
    await mintTo(connection, payer, mint, outsiderToken, payer, DEPOSIT);
  });

  // ---------- create_lease ----------
  it("create_lease: stores terms, status Created, empty vault owned by the lease", async () => {
    const { lease, vault, end } = await createLease();
    const acc: any = await program.account.lease.fetch(lease);
    assert.ok(acc.landlord.equals(landlord.publicKey));
    assert.ok(acc.tenant.equals(tenant.publicKey));
    assert.ok(acc.arbiter.equals(arbiter.publicKey));
    assert.ok(acc.mint.equals(mint));
    assert.equal(acc.amount.toNumber(), DEPOSIT);
    assert.equal(acc.funded.toNumber(), 0);
    assert.equal(acc.leaseEndTs.toNumber(), end);
    assert.equal(acc.claimWindowSecs.toNumber(), 14 * 24 * 3600, "default 14 days when 0 passed");
    assert.deepEqual(Array.from(acc.termsHash), termsHash);
    assert.property(acc.status, "created");
    const v = await getAccount(connection, vault);
    assert.ok(v.owner.equals(lease));
    assert.ok(v.mint.equals(mint));
    assert.equal(Number(v.amount), 0);
  });

  it("create_lease: rejects amount 0", async () => {
    await expectError(createLease({ amount: 0 }), "InvalidAmount");
  });

  it("create_lease: rejects lease end in the past", async () => {
    await expectError(createLease({ endInSecs: -60 }), "LeaseEndInPast");
  });

  it("create_lease: rejects negative claim window", async () => {
    await expectError(createLease({ claimWindow: -1 }), "InvalidClaimWindow");
  });

  // ---------- fund_deposit ----------
  it("fund_deposit: partial then full funding moves Created -> Active", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, DEPOSIT / 3);
    let acc: any = await program.account.lease.fetch(lease);
    assert.equal(acc.funded.toNumber(), DEPOSIT / 3);
    assert.property(acc.status, "created");

    await fund(lease, vault, DEPOSIT - DEPOSIT / 3);
    acc = await program.account.lease.fetch(lease);
    assert.equal(acc.funded.toNumber(), DEPOSIT);
    assert.property(acc.status, "active");
    assert.equal(await tokenBalance(vault), DEPOSIT, "vault == funded");
  });

  it("fund_deposit: rejects overfunding", async () => {
    const { lease, vault } = await createLease();
    await expectError(fund(lease, vault, DEPOSIT + 1), "Overfund");
    await fund(lease, vault, DEPOSIT - 10);
    await expectError(fund(lease, vault, 11), "Overfund");
    const acc: any = await program.account.lease.fetch(lease);
    assert.equal(acc.funded.toNumber(), DEPOSIT - 10);
    assert.equal(await tokenBalance(vault), DEPOSIT - 10);
  });

  it("fund_deposit: rejects a signer who is not the tenant", async () => {
    const { lease, vault } = await createLease();
    await expectError(fund(lease, vault, 1_000, outsider, outsiderToken), "Unauthorized");
  });

  it("fund_deposit: rejects funding once Active", async () => {
    const { lease, vault } = await createLease({ amount: 1_000 });
    await fund(lease, vault, 1_000);
    await expectError(fund(lease, vault, 1), "InvalidStatus");
  });

  // ---------- cancel_lease ----------
  it("cancel_lease (tenant): refunds partial funding, closes vault and lease, rent to landlord", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, 500_000_000);
    const tenantBefore = await tokenBalance(tenantToken);
    const landlordLamportsBefore = await connection.getBalance(landlord.publicKey);
    const rent =
      (await connection.getBalance(lease)) + (await connection.getBalance(vault));

    await cancel(tenant, lease, vault);

    assert.equal(await tokenBalance(tenantToken), tenantBefore + 500_000_000);
    assert.isNull(await connection.getAccountInfo(lease), "lease closed");
    assert.isNull(await connection.getAccountInfo(vault), "vault closed");
    assert.equal(
      await connection.getBalance(landlord.publicKey),
      landlordLamportsBefore + rent,
      "landlord gets back both rents (tenant paid the fee)"
    );
  });

  it("cancel_lease (landlord): works with nothing funded", async () => {
    const { lease, vault } = await createLease();
    await cancel(landlord, lease, vault);
    assert.isNull(await connection.getAccountInfo(lease));
    assert.isNull(await connection.getAccountInfo(vault));
  });

  it("cancel_lease: rejects a signer who is neither landlord nor tenant", async () => {
    const { lease, vault } = await createLease();
    await expectError(cancel(outsider, lease, vault), "Unauthorized");
  });

  it("cancel_lease: rejects cancel after the lease is Active", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, DEPOSIT);
    await expectError(cancel(landlord, lease, vault), "InvalidStatus");
    await expectError(cancel(tenant, lease, vault), "InvalidStatus");
  });

  // ---------- auto_refund ----------
  it("auto_refund: rejected before lease end + claim window", async () => {
    const { lease, vault } = await createLease({ endInSecs: 3600, claimWindow: 1 });
    await fund(lease, vault, DEPOSIT);
    await expectError(autoRefund(outsider, lease, vault), "DeadlineNotReached");
  });

  it("auto_refund: rejected while still Created (not fully funded)", async () => {
    const { lease, vault } = await createLease({ endInSecs: 10, claimWindow: 1 });
    await fund(lease, vault, 1_000);
    await expectError(autoRefund(outsider, lease, vault), "InvalidStatus");
  });

  it("auto_refund: anyone can crank after the deadline; tenant gets 100%", async () => {
    const { lease, vault, end } = await createLease({ endInSecs: 4, claimWindow: 1 });
    await fund(lease, vault, DEPOSIT);
    const tenantBefore = await tokenBalance(tenantToken);
    const landlordLamportsBefore = await connection.getBalance(landlord.publicKey);
    const rent =
      (await connection.getBalance(lease)) + (await connection.getBalance(vault));

    // Wait until the validator clock is past lease_end_ts + claim_window_secs.
    const deadline = end + 1;
    for (let i = 0; i < 60 && (await chainNow()) <= deadline + 1; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    await autoRefund(outsider, lease, vault);

    assert.equal(await tokenBalance(tenantToken), tenantBefore + DEPOSIT);
    assert.isNull(await connection.getAccountInfo(lease), "lease closed");
    assert.isNull(await connection.getAccountInfo(vault), "vault closed");
    assert.equal(
      await connection.getBalance(landlord.publicKey),
      landlordLamportsBefore + rent,
      "rent back to landlord"
    );
  });
});
