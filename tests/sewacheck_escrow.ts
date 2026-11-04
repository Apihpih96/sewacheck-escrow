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
  transfer,
} from "@solana/spl-token";
import { assert } from "chai";

const BN = anchor.BN;
const DECIMALS = 6;
const DEPOSIT = 3_000_000_000; // 3,000 "USDC" with 6 decimals

describe("sewacheck_escrow", () => {
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

  const configPda = PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    program.programId
  )[0];
  const BPF_LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
  const programData = PublicKey.findProgramAddressSync(
    [program.programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE
  )[0];

  let mint: PublicKey;
  let wrongMint: PublicKey;
  let tenantToken: PublicKey;
  let outsiderToken: PublicKey;
  let landlordToken: PublicKey;
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
    responseWindow?: number;
    arbiterWindow?: number;
    arbiter?: PublicKey;
    mint?: PublicKey;
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
        opts.arbiter ?? arbiter.publicKey,
        termsHash,
        new BN(opts.claimWindow ?? 0),
        new BN(opts.responseWindow ?? 0),
        new BN(opts.arbiterWindow ?? 0)
      )
      .accountsStrict({
        landlord: landlord.publicKey,
        tenant: tenant.publicKey,
        config: configPda,
        mint: opts.mint ?? mint,
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
    landlordToken = (
      await getOrCreateAssociatedTokenAccount(connection, payer, mint, landlord.publicKey)
    ).address;
    await mintTo(connection, payer, mint, tenantToken, payer, 100 * DEPOSIT);
    await mintTo(connection, payer, mint, outsiderToken, payer, DEPOSIT);
    wrongMint = await createMint(connection, payer, payer.publicKey, null, DECIMALS);
  });

  const initConfig = (admin: Keypair, usdcMint: PublicKey) =>
    program.methods
      .initializeConfig()
      .accountsStrict({
        admin: admin.publicKey,
        config: configPda,
        programData,
        usdcMint,
        systemProgram: SystemProgram.programId,
      })
      .signers([admin])
      .rpc();

  const updateConfig = (admin: Keypair, newAdmin: PublicKey, usdcMint: PublicKey) =>
    program.methods
      .updateConfig(newAdmin)
      .accountsStrict({ admin: admin.publicKey, config: configPda, usdcMint })
      .signers([admin])
      .rpc();

  // ---------- config / USDC-only ----------
  it("initialize_config: rejects a signer who is not the upgrade authority", async () => {
    await expectError(initConfig(outsider, mint), "Unauthorized");
  });

  it("initialize_config: upgrade authority records admin and the allowed mint", async () => {
    await initConfig(payer, mint);
    const cfg: any = await program.account.config.fetch(configPda);
    assert.ok(cfg.admin.equals(payer.publicKey));
    assert.ok(cfg.usdcMint.equals(mint));
  });

  it("create_lease: rejects a mint other than the configured USDC mint", async () => {
    await expectError(createLease({ mint: wrongMint }), "MintNotAllowed");
  });

  it("update_config: rejects a non-admin signer", async () => {
    await expectError(updateConfig(outsider, outsider.publicKey, wrongMint), "Unauthorized");
  });

  it("update_config: admin switches the allowed mint; old mint is then rejected", async () => {
    await updateConfig(payer, payer.publicKey, wrongMint);
    await expectError(createLease(), "MintNotAllowed");
    await updateConfig(payer, payer.publicKey, mint);
    const cfg: any = await program.account.config.fetch(configPda);
    assert.ok(cfg.usdcMint.equals(mint));
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
    assert.equal(acc.responseWindowSecs.toNumber(), 7 * 24 * 3600, "default 7 days when 0 passed");
    assert.equal(acc.arbiterWindowSecs.toNumber(), 14 * 24 * 3600, "default 14 days when 0 passed");
    assert.equal(acc.disputedTs.toNumber(), 0);
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
  // =====================================================================
  // Week 2: move-out deductions, disputes, auto_accept, mutual_release
  // =====================================================================
  const evidence = Array.from({ length: 32 }, (_, i) => 255 - i);
  const ZERO32 = Array.from({ length: 32 }, () => 0);
  const DEDUCTION = 800_000_000; // RM-ish 800 of a 3,000 deposit

  async function waitUntilChainPast(ts: number) {
    for (let i = 0; i < 90 && (await chainNow()) <= ts + 1; i++) {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  /** Fully funded lease whose lease_end_ts has already passed (claim window open). */
  async function endedLease(
    opts: { claimWindow?: number; responseWindow?: number; arbiterWindow?: number; arbiter?: PublicKey } = {}
  ) {
    const l = await createLease({
      endInSecs: 3,
      claimWindow: opts.claimWindow ?? 3600,
      responseWindow: opts.responseWindow ?? 3600,
      arbiterWindow: opts.arbiterWindow ?? 3600,
      arbiter: opts.arbiter,
    });
    await fund(l.lease, l.vault, DEPOSIT);
    await waitUntilChainPast(l.end);
    return l;
  }

  const propose = (lease: PublicKey, amount = DEDUCTION, hash = evidence, signer = landlord) =>
    program.methods
      .proposeDeduction(new BN(amount), hash)
      .accountsStrict({ landlord: signer.publicKey, lease })
      .signers([signer])
      .rpc();

  const disputeIx = (lease: PublicKey, signer = tenant) =>
    program.methods
      .dispute()
      .accountsStrict({ tenant: signer.publicKey, lease })
      .signers([signer])
      .rpc();

  function settleAccounts(lease: PublicKey, vault: PublicKey, over: Record<string, PublicKey> = {}) {
    return {
      lease,
      landlord: landlord.publicKey,
      mint,
      landlordToken,
      tenantToken,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
      ...over,
    };
  }

  const accept = (caller: Keypair, lease: PublicKey, vault: PublicKey, over = {}) =>
    program.methods
      .acceptDeduction()
      .accountsStrict({ caller: caller.publicKey, ...settleAccounts(lease, vault, over) })
      .signers([caller])
      .rpc();

  const autoAccept = (caller: Keypair, lease: PublicKey, vault: PublicKey) =>
    program.methods
      .autoAccept()
      .accountsStrict({ caller: caller.publicKey, ...settleAccounts(lease, vault) })
      .signers([caller])
      .rpc();

  const resolve = (signer: Keypair, lease: PublicKey, vault: PublicKey, toLandlord: number) =>
    program.methods
      .resolveDispute(new BN(toLandlord))
      .accountsStrict({ arbiter: signer.publicKey, config: configPda, ...settleAccounts(lease, vault) })
      .signers([signer])
      .rpc();

  const mutual = (
    lease: PublicKey,
    vault: PublicKey,
    toLandlord: number,
    l: Keypair = landlord,
    t: Keypair = tenant
  ) =>
    program.methods
      .mutualRelease(new BN(toLandlord))
      .accountsStrict({
        landlord: l.publicKey,
        tenant: t.publicKey,
        lease,
        mint,
        landlordToken,
        tenantToken,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers(l.publicKey.equals(t.publicKey) ? [l] : [l, t])
      .rpc();

  /** Snapshot balances so a payout can be checked exactly (amounts and rent). */
  async function snapshot(lease: PublicKey, vault: PublicKey) {
    return {
      landlordTok: await tokenBalance(landlordToken),
      tenantTok: await tokenBalance(tenantToken),
      landlordSol: await connection.getBalance(landlord.publicKey),
      rent: (await connection.getBalance(lease)) + (await connection.getBalance(vault)),
      vault: await tokenBalance(vault),
    };
  }

  async function assertSettled(
    before: Awaited<ReturnType<typeof snapshot>>,
    lease: PublicKey,
    vault: PublicKey,
    toLandlord: number
  ) {
    const landlordGot = (await tokenBalance(landlordToken)) - before.landlordTok;
    const tenantGot = (await tokenBalance(tenantToken)) - before.tenantTok;
    assert.equal(landlordGot, toLandlord, "landlord payout");
    assert.equal(tenantGot, DEPOSIT - toLandlord, "tenant payout");
    assert.equal(landlordGot + tenantGot, before.vault, "payout == vault, nothing more");
    assert.isNull(await connection.getAccountInfo(lease), "lease closed");
    assert.isNull(await connection.getAccountInfo(vault), "vault closed");
    assert.equal(
      await connection.getBalance(landlord.publicKey),
      before.landlordSol + before.rent,
      "rent back to landlord"
    );
  }

  // ---------- create_lease (week 2 additions) ----------
  it("create_lease: rejects an arbiter who is the landlord or the tenant", async () => {
    await expectError(createLease({ arbiter: landlord.publicKey }), "ArbiterIsParty");
    await expectError(createLease({ arbiter: tenant.publicKey }), "ArbiterIsParty");
  });

  it("create_lease: rejects a negative response window; stores a custom one", async () => {
    await expectError(createLease({ responseWindow: -1 }), "InvalidResponseWindow");
    const { lease } = await createLease({ responseWindow: 120, arbiter: PublicKey.default });
    const acc: any = await program.account.lease.fetch(lease);
    assert.equal(acc.responseWindowSecs.toNumber(), 120);
    assert.ok(acc.arbiter.equals(PublicKey.default), "no arbiter allowed");
  });

  // ---------- propose_deduction ----------
  it("propose_deduction: rejected while Created (not funded)", async () => {
    const { lease } = await createLease();
    await expectError(propose(lease), "InvalidStatus");
  });

  it("propose_deduction: rejected before lease end", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, DEPOSIT);
    await expectError(propose(lease), "LeaseNotEnded");
  });

  it("propose_deduction: rejects non-landlord, zero amount, over-funded amount, missing evidence", async () => {
    const { lease } = await endedLease();
    await expectError(propose(lease, DEDUCTION, evidence, tenant), "Unauthorized");
    await expectError(propose(lease, DEDUCTION, evidence, outsider), "Unauthorized");
    await expectError(propose(lease, 0), "InvalidAmount");
    await expectError(propose(lease, DEPOSIT + 1), "DeductionTooLarge");
    await expectError(propose(lease, DEDUCTION, ZERO32), "MissingEvidence");
    const acc: any = await program.account.lease.fetch(lease);
    assert.property(acc.status, "active", "nothing changed");
  });

  it("propose_deduction: rejected after the claim window closes", async () => {
    const { lease, end } = await endedLease({ claimWindow: 2 });
    await waitUntilChainPast(end + 2);
    await expectError(propose(lease), "ClaimWindowClosed");
  });

  it("propose_deduction: records claim + evidence; vault untouched; second claim rejected", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    const acc: any = await program.account.lease.fetch(lease);
    assert.property(acc.status, "deductionProposed");
    assert.equal(acc.deduction.toNumber(), DEDUCTION);
    assert.deepEqual(Array.from(acc.evidenceHash), evidence);
    assert.isAbove(acc.proposedTs.toNumber(), 0);
    assert.equal(await tokenBalance(vault), DEPOSIT, "vault == funded until settled");
    await expectError(propose(lease, 1), "InvalidStatus");
  });

  it("propose_deduction: full deposit can be claimed (deduction == funded)", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease, DEPOSIT);
    const before = await snapshot(lease, vault);
    await accept(tenant, lease, vault);
    await assertSettled(before, lease, vault, DEPOSIT);
  });

  // ---------- auto_refund still only when no claim ----------
  it("auto_refund: rejected once a claim exists, even after the claim window", async () => {
    const { lease, vault, end } = await endedLease({ claimWindow: 4 });
    await propose(lease);
    await waitUntilChainPast(end + 4);
    await expectError(autoRefund(outsider, lease, vault), "InvalidStatus");
    assert.equal(await tokenBalance(vault), DEPOSIT);
  });

  // ---------- accept_deduction ----------
  it("accept_deduction: only the tenant can accept", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    await expectError(accept(landlord, lease, vault), "Unauthorized");
    await expectError(accept(outsider, lease, vault), "Unauthorized");
  });

  it("accept_deduction: rejected without a proposal", async () => {
    const { lease, vault } = await endedLease();
    await expectError(accept(tenant, lease, vault), "InvalidStatus");
  });

  it("accept_deduction: deduction to landlord, rest to tenant, vault + lease closed", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    const before = await snapshot(lease, vault);
    await accept(tenant, lease, vault);
    await assertSettled(before, lease, vault, DEDUCTION);
  });

  it("payout accounts: funds can only go to the lease's landlord and tenant", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    await expectError(accept(tenant, lease, vault, { landlordToken: outsiderToken }), "WrongTokenOwner");
    await expectError(accept(tenant, lease, vault, { tenantToken: outsiderToken }), "WrongTokenOwner");
    await expectError(accept(tenant, lease, vault, { landlord: outsider.publicKey }), "WrongLandlord");
    // A different lease's vault does not match this lease's vault PDA.
    const other = await createLease();
    await expectError(accept(tenant, lease, other.vault), "ConstraintSeeds");
    assert.equal(await tokenBalance(vault), DEPOSIT, "nothing moved");
  });

  // ---------- dispute ----------
  it("dispute: only the tenant, only on a pending claim", async () => {
    const { lease } = await endedLease();
    await expectError(disputeIx(lease), "InvalidStatus");
    await propose(lease);
    await expectError(disputeIx(lease, landlord), "Unauthorized");
    await expectError(disputeIx(lease, outsider), "Unauthorized");
    await disputeIx(lease);
    const acc: any = await program.account.lease.fetch(lease);
    assert.property(acc.status, "disputed");
    await expectError(disputeIx(lease), "InvalidStatus");
  });

  it("dispute: rejected after the response window", async () => {
    const { lease } = await endedLease({ responseWindow: 2 });
    await propose(lease);
    const acc: any = await program.account.lease.fetch(lease);
    await waitUntilChainPast(acc.proposedTs.toNumber() + 2);
    await expectError(disputeIx(lease), "ResponseWindowClosed");
  });

  it("disputed lease: accept_deduction, auto_accept and auto_refund are all blocked", async () => {
    const { lease, vault } = await endedLease({ responseWindow: 2 });
    await propose(lease);
    await disputeIx(lease);
    const acc: any = await program.account.lease.fetch(lease);
    await waitUntilChainPast(acc.proposedTs.toNumber() + 2);
    await expectError(accept(tenant, lease, vault), "InvalidStatus");
    await expectError(autoAccept(outsider, lease, vault), "InvalidStatus");
    await expectError(autoRefund(outsider, lease, vault), "InvalidStatus");
    assert.equal(await tokenBalance(vault), DEPOSIT);
  });

  // ---------- resolve_dispute ----------
  it("resolve_dispute: arbiter cannot act unless the lease is Disputed", async () => {
    const { lease, vault } = await endedLease();
    await expectError(resolve(arbiter, lease, vault, 0), "InvalidStatus");
    await propose(lease);
    await expectError(resolve(arbiter, lease, vault, 0), "InvalidStatus");
  });

  it("resolve_dispute: rejects landlord, tenant, outsider and config admin when an arbiter is named", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    await disputeIx(lease);
    await expectError(resolve(landlord, lease, vault, DEDUCTION), "Unauthorized");
    await expectError(resolve(tenant, lease, vault, 0), "Unauthorized");
    await expectError(resolve(outsider, lease, vault, 0), "Unauthorized");
    await expectError(resolve(payer, lease, vault, 0), "Unauthorized");
  });

  it("resolve_dispute: ruling is capped at the claimed deduction", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    await disputeIx(lease);
    await expectError(resolve(arbiter, lease, vault, DEDUCTION + 1), "ExceedsClaim");
  });

  it("resolve_dispute: arbiter splits within the claim; vault + lease closed", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    await disputeIx(lease);
    const before = await snapshot(lease, vault);
    const ruling = 300_000_000;
    await resolve(arbiter, lease, vault, ruling);
    await assertSettled(before, lease, vault, ruling);
  });

  it("resolve_dispute: arbiter can rule 0 (tenant gets everything)", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    await disputeIx(lease);
    const before = await snapshot(lease, vault);
    await resolve(arbiter, lease, vault, 0);
    await assertSettled(before, lease, vault, 0);
  });

  it("resolve_dispute: with no named arbiter, the config admin is the fallback arbiter", async () => {
    const { lease, vault } = await endedLease({ arbiter: PublicKey.default });
    await propose(lease);
    await disputeIx(lease);
    await expectError(resolve(arbiter, lease, vault, 0), "Unauthorized");
    await expectError(resolve(payer, lease, vault, DEDUCTION + 1), "ExceedsClaim");
    const before = await snapshot(lease, vault);
    await resolve(payer, lease, vault, DEDUCTION);
    await assertSettled(before, lease, vault, DEDUCTION);
  });

  // ---------- auto_accept ----------
  it("auto_accept: rejected while the response window is open, and without a claim", async () => {
    const { lease, vault } = await endedLease();
    await expectError(autoAccept(outsider, lease, vault), "InvalidStatus");
    await propose(lease);
    await expectError(autoAccept(outsider, lease, vault), "DeadlineNotReached");
  });

  it("auto_accept: tenant silence = acceptance; anyone can crank", async () => {
    const { lease, vault } = await endedLease({ responseWindow: 2 });
    await propose(lease);
    const acc: any = await program.account.lease.fetch(lease);
    await waitUntilChainPast(acc.proposedTs.toNumber() + 2);
    const before = await snapshot(lease, vault);
    await autoAccept(outsider, lease, vault);
    await assertSettled(before, lease, vault, DEDUCTION);
  });

  // ---------- mutual_release ----------
  it("mutual_release: rejected while Created", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, 1_000);
    await expectError(mutual(lease, vault, 0), "InvalidStatus");
  });

  it("mutual_release: needs both landlord and tenant signatures", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, DEPOSIT);
    await expectError(mutual(lease, vault, 0, landlord, outsider), "Unauthorized");
    await expectError(mutual(lease, vault, 0, outsider, tenant), "Unauthorized");
    // Landlord alone cannot fake the tenant: the tenant account must sign.
    const tx = program.methods
      .mutualRelease(new BN(0))
      .accountsStrict({
        landlord: landlord.publicKey,
        tenant: tenant.publicKey,
        lease,
        mint,
        landlordToken,
        tenantToken,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([landlord])
      .rpc();
    await expectError(tx, "ignature");
  });

  it("mutual_release: rejects a split above the funded amount", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, DEPOSIT);
    await expectError(mutual(lease, vault, DEPOSIT + 1), "Overpay");
  });

  it("mutual_release: early exit from Active with an agreed split (before lease end)", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, DEPOSIT);
    const before = await snapshot(lease, vault);
    const split = 1_000_000_000;
    // The provider wallet pays the tx fee, so the landlord's SOL rises by exactly the rent.
    await mutual(lease, vault, split);
    await assertSettled(before, lease, vault, split);
  });

  it("mutual_release: settles a dispute without the arbiter", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    await disputeIx(lease);
    const before = await snapshot(lease, vault);
    await mutual(lease, vault, 400_000_000);
    await assertSettled(before, lease, vault, 400_000_000);
  });

  // =====================================================================
  // Arbiter deadline (arbiter_timeout) + bug-review fixes
  // =====================================================================
  const arbiterTimeout = (caller: Keypair, lease: PublicKey, vault: PublicKey) =>
    program.methods
      .arbiterTimeout()
      .accountsStrict(closeOutAccounts(caller, lease, vault))
      .signers([caller])
      .rpc();

  /** Ended lease with a pending dispute; returns the lease plus its disputed_ts. */
  async function disputedLease(opts: { arbiterWindow?: number; arbiter?: PublicKey } = {}) {
    const l = await endedLease({ arbiterWindow: opts.arbiterWindow, arbiter: opts.arbiter });
    await propose(l.lease);
    await disputeIx(l.lease);
    const acc: any = await program.account.lease.fetch(l.lease);
    return { ...l, disputedTs: acc.disputedTs.toNumber() as number };
  }

  it("create_lease: rejects a negative arbiter window; stores a custom one", async () => {
    await expectError(createLease({ arbiterWindow: -1 }), "InvalidArbiterWindow");
    const { lease } = await createLease({ arbiterWindow: 90 });
    const acc: any = await program.account.lease.fetch(lease);
    assert.equal(acc.arbiterWindowSecs.toNumber(), 90);
  });

  it("dispute: records disputed_ts (start of the arbiter window)", async () => {
    const { disputedTs, lease } = await disputedLease();
    const acc: any = await program.account.lease.fetch(lease);
    assert.isAbove(disputedTs, 0);
    assert.isAtLeast(disputedTs, acc.proposedTs.toNumber());
  });

  it("arbiter_timeout: rejected unless Disputed (Active, DeductionProposed)", async () => {
    const { lease, vault } = await endedLease({ arbiterWindow: 1 });
    await expectError(arbiterTimeout(outsider, lease, vault), "InvalidStatus");
    await propose(lease);
    await expectError(arbiterTimeout(outsider, lease, vault), "InvalidStatus");
    assert.equal(await tokenBalance(vault), DEPOSIT);
  });

  it("arbiter_timeout: rejected before disputed_ts + arbiter window", async () => {
    const { lease, vault } = await disputedLease({ arbiterWindow: 3600 });
    await expectError(arbiterTimeout(outsider, lease, vault), "DeadlineNotReached");
    await expectError(arbiterTimeout(tenant, lease, vault), "DeadlineNotReached");
    assert.equal(await tokenBalance(vault), DEPOSIT);
  });

  it("arbiter_timeout: after the deadline resolve_dispute is rejected; anyone cranks, tenant gets 100%", async () => {
    const { lease, vault, disputedTs } = await disputedLease({ arbiterWindow: 3 });
    await waitUntilChainPast(disputedTs + 3);
    await expectError(resolve(arbiter, lease, vault, DEDUCTION), "ArbiterWindowClosed");
    await expectError(resolve(arbiter, lease, vault, 0), "ArbiterWindowClosed");
    const before = await snapshot(lease, vault);
    await arbiterTimeout(outsider, lease, vault);
    // undisputed share (funded - deduction) + unruled disputed amount = whole deposit to tenant
    await assertSettled(before, lease, vault, 0);
  });

  it("arbiter_timeout: also applies to the Config-admin fallback arbiter", async () => {
    const { lease, vault, disputedTs } = await disputedLease({
      arbiterWindow: 3,
      arbiter: PublicKey.default,
    });
    await waitUntilChainPast(disputedTs + 3);
    await expectError(resolve(payer, lease, vault, DEDUCTION), "ArbiterWindowClosed");
    const before = await snapshot(lease, vault);
    await arbiterTimeout(tenant, lease, vault);
    await assertSettled(before, lease, vault, 0);
  });

  it("resolve_dispute: still works inside the arbiter window (boundary sanity)", async () => {
    const { lease, vault } = await disputedLease({ arbiterWindow: 3600 });
    const before = await snapshot(lease, vault);
    await resolve(arbiter, lease, vault, 100_000_000);
    await assertSettled(before, lease, vault, 100_000_000);
  });

  it("bugfix: Config admin cannot act as fallback arbiter on a lease where it is the landlord", async () => {
    // Make the landlord the Config admin, then dispute an arbiter-less lease.
    await updateConfig(payer, landlord.publicKey, mint);
    try {
      const { lease, vault } = await disputedLease({ arbiter: PublicKey.default });
      await expectError(resolve(landlord, lease, vault, DEDUCTION), "ArbiterIsParty");
      assert.equal(await tokenBalance(vault), DEPOSIT, "nothing moved");
      // Parties can still settle it themselves.
      const before = await snapshot(lease, vault);
      await mutual(lease, vault, 0);
      await assertSettled(before, lease, vault, 0);
    } finally {
      await updateConfig(landlord, payer.publicKey, mint);
    }
    const cfg: any = await program.account.config.fetch(configPda);
    assert.ok(cfg.admin.equals(payer.publicKey));
  });

  it("bugfix: update_config rejects the default pubkey as admin", async () => {
    await expectError(updateConfig(payer, PublicKey.default, mint), "InvalidAdmin");
    const cfg: any = await program.account.config.fetch(configPda);
    assert.ok(cfg.admin.equals(payer.publicKey));
  });

  it("bugfix: tokens donated to the vault cannot freeze a payout; surplus goes to the tenant", async () => {
    const { lease, vault } = await endedLease();
    await propose(lease);
    // Anyone can send tokens straight to the vault token account.
    await transfer(connection, payer, outsiderToken, vault, outsider, 7);
    assert.equal(await tokenBalance(vault), DEPOSIT + 7);
    const lt = await tokenBalance(landlordToken);
    const tt = await tokenBalance(tenantToken);
    await accept(tenant, lease, vault);
    assert.equal((await tokenBalance(landlordToken)) - lt, DEDUCTION, "landlord gets only the claim");
    assert.equal((await tokenBalance(tenantToken)) - tt, DEPOSIT - DEDUCTION + 7, "tenant gets rest + surplus");
    assert.isNull(await connection.getAccountInfo(vault), "vault closed");
    assert.isNull(await connection.getAccountInfo(lease), "lease closed");
  });

  it("bugfix: donated tokens cannot block cancel_lease; tenant gets partial funding + surplus", async () => {
    const { lease, vault } = await createLease();
    await fund(lease, vault, 1_000);
    await transfer(connection, payer, outsiderToken, vault, outsider, 3);
    const tt = await tokenBalance(tenantToken);
    await cancel(landlord, lease, vault);
    assert.equal((await tokenBalance(tenantToken)) - tt, 1_003);
    assert.isNull(await connection.getAccountInfo(vault), "vault closed");
  });
});
