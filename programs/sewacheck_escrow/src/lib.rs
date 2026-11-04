//! SewaCheck Escrow: a tenancy deposit held in a program-owned SPL token vault.
//!
//! Week 1 (SPEC.md section 10): create_lease, fund_deposit, cancel_lease, auto_refund.
//! Week 2: move-out deductions and disputes: propose_deduction, accept_deduction,
//! dispute, resolve_dispute, auto_accept, mutual_release.
//!
//! Invariants: every payout is exactly the vault balance split between the lease's
//! landlord and tenant token accounts (never more than funded, never anyone else),
//! and every terminal path closes both the vault and the Lease (rent to landlord).
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

declare_id!("9Uu5DcNxbueKnS2UdYuAQnQCBwHH6QnBo8RtNNQ91mrQ");

/// Default claim window when 0 is passed: 14 days.
pub const DEFAULT_CLAIM_WINDOW_SECS: i64 = 14 * 24 * 60 * 60;
/// Default tenant response window (dispute or silence = acceptance) when 0 is passed: 7 days.
pub const DEFAULT_RESPONSE_WINDOW_SECS: i64 = 7 * 24 * 60 * 60;
pub const LEASE_SEED: &[u8] = b"lease";
pub const VAULT_SEED: &[u8] = b"vault";
pub const CONFIG_SEED: &[u8] = b"config";
/// BPF upgradeable loader; owns this program's ProgramData account.
pub const BPF_LOADER_UPGRADEABLE_ID: Pubkey =
    pubkey!("BPFLoaderUpgradeab1e11111111111111111111111");
/// Circle USDC mints (https://developers.circle.com/stablecoins/usdc-contract-addresses).
/// Reference only: the allowed mint lives in the Config account, set at init.
pub const USDC_MINT_MAINNET: Pubkey = pubkey!("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
pub const USDC_MINT_DEVNET: Pubkey = pubkey!("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");

#[program]
pub mod sewacheck_escrow {
    use super::*;

    /// One-time setup by the program's upgrade authority: records the admin and
    /// the only mint leases may use (USDC on devnet/mainnet, a test mint locally).
    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Admin can rotate the admin key or change the allowed mint.
    /// Existing leases keep the mint they were created with.
    pub fn update_config(ctx: Context<UpdateConfig>, new_admin: Pubkey) -> Result<()> {
        let config = &mut ctx.accounts.config;
        config.admin = new_admin;
        config.usdc_mint = ctx.accounts.usdc_mint.key();
        Ok(())
    }

    /// Landlord opens a lease. The tenant pubkey and terms are fixed here.
    pub fn create_lease(
        ctx: Context<CreateLease>,
        lease_id: u64,
        amount: u64,
        lease_end_ts: i64,
        arbiter: Pubkey,
        terms_hash: [u8; 32],
        claim_window_secs: i64,
        response_window_secs: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(claim_window_secs >= 0, EscrowError::InvalidClaimWindow);
        require!(response_window_secs >= 0, EscrowError::InvalidResponseWindow);
        let now = Clock::get()?.unix_timestamp;
        require!(lease_end_ts > now, EscrowError::LeaseEndInPast);
        let landlord = ctx.accounts.landlord.key();
        let tenant = ctx.accounts.tenant.key();
        require_keys_neq!(landlord, tenant, EscrowError::SameParty);
        // Pubkey::default() = no arbiter. A named arbiter must be a third party.
        require!(
            arbiter != landlord && arbiter != tenant,
            EscrowError::ArbiterIsParty
        );

        let claim_window = if claim_window_secs == 0 {
            DEFAULT_CLAIM_WINDOW_SECS
        } else {
            claim_window_secs
        };
        let response_window = if response_window_secs == 0 {
            DEFAULT_RESPONSE_WINDOW_SECS
        } else {
            response_window_secs
        };
        // Make sure the deadline arithmetic can never overflow later
        // (latest proposal is at end + claim window; its response deadline adds the response window).
        lease_end_ts
            .checked_add(claim_window)
            .and_then(|t| t.checked_add(response_window))
            .ok_or(EscrowError::MathOverflow)?;

        let lease = &mut ctx.accounts.lease;
        lease.landlord = landlord;
        lease.tenant = tenant;
        lease.arbiter = arbiter;
        lease.mint = ctx.accounts.mint.key();
        lease.lease_id = lease_id;
        lease.amount = amount;
        lease.funded = 0;
        lease.lease_end_ts = lease_end_ts;
        lease.claim_window_secs = claim_window;
        lease.response_window_secs = response_window;
        lease.terms_hash = terms_hash;
        lease.status = LeaseStatus::Created;
        lease.deduction = 0;
        lease.evidence_hash = [0u8; 32];
        lease.proposed_ts = 0;
        lease.bump = ctx.bumps.lease;
        lease.vault_bump = ctx.bumps.vault;
        Ok(())
    }

    /// Tenant funds the deposit, fully or in parts. Created -> Active when funded == amount.
    pub fn fund_deposit(ctx: Context<FundDeposit>, amount: u64) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        let lease = &ctx.accounts.lease;
        require!(lease.status == LeaseStatus::Created, EscrowError::InvalidStatus);
        let new_funded = lease
            .funded
            .checked_add(amount)
            .ok_or(EscrowError::MathOverflow)?;
        require!(new_funded <= lease.amount, EscrowError::Overfund);

        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                TransferChecked {
                    from: ctx.accounts.tenant_token.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.tenant.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.mint.decimals,
        )?;

        let lease = &mut ctx.accounts.lease;
        lease.funded = new_funded;
        if lease.funded == lease.amount {
            lease.status = LeaseStatus::Active;
        }
        Ok(())
    }

    /// Landlord or tenant cancels before the deposit is fully funded.
    /// Any partial funding goes back to the tenant; vault and lease rent go to the landlord.
    pub fn cancel_lease(ctx: Context<CloseOut>) -> Result<()> {
        let signer = ctx.accounts.caller.key();
        let lease = &ctx.accounts.lease;
        require!(
            signer == lease.landlord || signer == lease.tenant,
            EscrowError::Unauthorized
        );
        require!(lease.status == LeaseStatus::Created, EscrowError::InvalidStatus);
        let funded = lease.funded;
        payout_and_close(&ctx, funded)?;
        ctx.accounts.lease.funded = 0;
        ctx.accounts.lease.status = LeaseStatus::Cancelled;
        Ok(())
    }

    /// Anyone can crank: once the claim window has passed with no claim, the tenant gets 100%.
    pub fn auto_refund(ctx: Context<CloseOut>) -> Result<()> {
        let lease = &ctx.accounts.lease;
        require!(lease.status == LeaseStatus::Active, EscrowError::InvalidStatus);
        require!(lease.deduction == 0, EscrowError::ClaimExists);
        let deadline = lease
            .lease_end_ts
            .checked_add(lease.claim_window_secs)
            .ok_or(EscrowError::MathOverflow)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now > deadline, EscrowError::DeadlineNotReached);
        let funded = lease.funded;
        payout_and_close(&ctx, funded)?;
        ctx.accounts.lease.funded = 0;
        ctx.accounts.lease.status = LeaseStatus::Settled;
        Ok(())
    }

    /// Landlord claims a move-out deduction with an evidence hash (photos/invoices on
    /// Arweave/IPFS). Only after lease end and up to lease end + claim window.
    pub fn propose_deduction(
        ctx: Context<ProposeDeduction>,
        deduction: u64,
        evidence_hash: [u8; 32],
    ) -> Result<()> {
        let lease = &ctx.accounts.lease;
        require!(lease.status == LeaseStatus::Active, EscrowError::InvalidStatus);
        require!(deduction > 0, EscrowError::InvalidAmount);
        require!(deduction <= lease.funded, EscrowError::DeductionTooLarge);
        require!(evidence_hash != [0u8; 32], EscrowError::MissingEvidence);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= lease.lease_end_ts, EscrowError::LeaseNotEnded);
        let claim_deadline = lease
            .lease_end_ts
            .checked_add(lease.claim_window_secs)
            .ok_or(EscrowError::MathOverflow)?;
        require!(now <= claim_deadline, EscrowError::ClaimWindowClosed);

        let lease = &mut ctx.accounts.lease;
        lease.deduction = deduction;
        lease.evidence_hash = evidence_hash;
        lease.proposed_ts = now;
        lease.status = LeaseStatus::DeductionProposed;
        Ok(())
    }

    /// Tenant accepts the claim: deduction to the landlord, the rest to the tenant.
    pub fn accept_deduction(ctx: Context<Settle>) -> Result<()> {
        let lease = &ctx.accounts.lease;
        require_keys_eq!(ctx.accounts.caller.key(), lease.tenant, EscrowError::Unauthorized);
        require!(
            lease.status == LeaseStatus::DeductionProposed,
            EscrowError::InvalidStatus
        );
        let to_landlord = lease.deduction;
        ctx.accounts.pay_out_and_close(to_landlord)
    }

    /// Tenant disputes the claim within the response window. Funds stay in the vault.
    pub fn dispute(ctx: Context<Dispute>) -> Result<()> {
        let lease = &ctx.accounts.lease;
        require!(
            lease.status == LeaseStatus::DeductionProposed,
            EscrowError::InvalidStatus
        );
        let response_deadline = lease
            .proposed_ts
            .checked_add(lease.response_window_secs)
            .ok_or(EscrowError::MathOverflow)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now <= response_deadline, EscrowError::ResponseWindowClosed);
        ctx.accounts.lease.status = LeaseStatus::Disputed;
        Ok(())
    }

    /// Arbiter rules on a dispute: `to_landlord` (capped at the claimed deduction) to the
    /// landlord, the rest to the tenant. If the lease has no arbiter, the Config admin
    /// is the fallback arbiter (same cap, funds still only to landlord/tenant).
    pub fn resolve_dispute(ctx: Context<ResolveDispute>, to_landlord: u64) -> Result<()> {
        let lease = &ctx.accounts.lease;
        let expected = if lease.arbiter == Pubkey::default() {
            ctx.accounts.config.admin
        } else {
            lease.arbiter
        };
        require_keys_eq!(ctx.accounts.arbiter.key(), expected, EscrowError::Unauthorized);
        require!(lease.status == LeaseStatus::Disputed, EscrowError::InvalidStatus);
        require!(to_landlord <= lease.deduction, EscrowError::ExceedsClaim);
        let a = &ctx.accounts;
        split_and_close(
            &a.lease,
            &a.vault,
            &a.mint,
            &a.landlord_token,
            &a.tenant_token,
            a.landlord.to_account_info(),
            a.token_program.key(),
            to_landlord,
        )?;
        let lease = &mut ctx.accounts.lease;
        lease.funded = 0;
        lease.status = LeaseStatus::Settled;
        Ok(())
    }

    /// Anyone can crank: the tenant did not dispute within the response window,
    /// so silence = acceptance.
    pub fn auto_accept(ctx: Context<Settle>) -> Result<()> {
        let lease = &ctx.accounts.lease;
        require!(
            lease.status == LeaseStatus::DeductionProposed,
            EscrowError::InvalidStatus
        );
        let response_deadline = lease
            .proposed_ts
            .checked_add(lease.response_window_secs)
            .ok_or(EscrowError::MathOverflow)?;
        let now = Clock::get()?.unix_timestamp;
        require!(now > response_deadline, EscrowError::DeadlineNotReached);
        let to_landlord = lease.deduction;
        ctx.accounts.pay_out_and_close(to_landlord)
    }

    /// Landlord and tenant both sign one transaction for an agreed split.
    /// Allowed once funded (Active), and also to settle a pending claim or dispute.
    pub fn mutual_release(ctx: Context<MutualRelease>, to_landlord: u64) -> Result<()> {
        let lease = &ctx.accounts.lease;
        require!(
            matches!(
                lease.status,
                LeaseStatus::Active | LeaseStatus::DeductionProposed | LeaseStatus::Disputed
            ),
            EscrowError::InvalidStatus
        );
        require!(to_landlord <= lease.funded, EscrowError::Overpay);
        let a = &ctx.accounts;
        split_and_close(
            &a.lease,
            &a.vault,
            &a.mint,
            &a.landlord_token,
            &a.tenant_token,
            a.landlord.to_account_info(),
            a.token_program.key(),
            to_landlord,
        )?;
        let lease = &mut ctx.accounts.lease;
        lease.funded = 0;
        lease.status = LeaseStatus::Settled;
        Ok(())
    }
}

impl<'info> Settle<'info> {
    fn pay_out_and_close(&mut self, to_landlord: u64) -> Result<()> {
        split_and_close(
            &self.lease,
            &self.vault,
            &self.mint,
            &self.landlord_token,
            &self.tenant_token,
            self.landlord.to_account_info(),
            self.token_program.key(),
            to_landlord,
        )?;
        self.lease.funded = 0;
        self.lease.status = LeaseStatus::Settled;
        Ok(())
    }
}

/// Splits the whole vault: `to_landlord` to the landlord's token account, the rest to the
/// tenant's, then closes the vault (rent to the landlord). Callers close the Lease via
/// the `close = landlord` constraint. Refuses if the vault doesn't hold exactly `funded`.
#[allow(clippy::too_many_arguments)]
fn split_and_close<'info>(
    lease: &Account<'info, Lease>,
    vault: &Account<'info, TokenAccount>,
    mint: &Account<'info, Mint>,
    landlord_token: &Account<'info, TokenAccount>,
    tenant_token: &Account<'info, TokenAccount>,
    rent_to: AccountInfo<'info>,
    token_program: Pubkey,
    to_landlord: u64,
) -> Result<()> {
    require!(vault.amount == lease.funded, EscrowError::VaultMismatch);
    require!(to_landlord <= lease.funded, EscrowError::Overpay);
    let to_tenant = lease
        .funded
        .checked_sub(to_landlord)
        .ok_or(EscrowError::MathOverflow)?;

    let lease_id_bytes = lease.lease_id.to_le_bytes();
    let bump = [lease.bump];
    let seeds: &[&[u8]] = &[
        LEASE_SEED,
        lease.landlord.as_ref(),
        lease.tenant.as_ref(),
        &lease_id_bytes,
        &bump,
    ];
    let signer_seeds = &[seeds];

    for (dest, amt) in [
        (landlord_token.to_account_info(), to_landlord),
        (tenant_token.to_account_info(), to_tenant),
    ] {
        if amt > 0 {
            token::transfer_checked(
                CpiContext::new_with_signer(
                    token_program,
                    TransferChecked {
                        from: vault.to_account_info(),
                        mint: mint.to_account_info(),
                        to: dest,
                        authority: lease.to_account_info(),
                    },
                    signer_seeds,
                ),
                amt,
                mint.decimals,
            )?;
        }
    }

    token::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: vault.to_account_info(),
            destination: rent_to,
            authority: lease.to_account_info(),
        },
        signer_seeds,
    ))?;
    Ok(())
}

/// Pays `to_tenant` from the vault to the tenant, then closes the vault (rent to landlord).
/// The Lease account itself is closed to the landlord by the `close` constraint.
fn payout_and_close(ctx: &Context<CloseOut>, to_tenant: u64) -> Result<()> {
    let lease = &ctx.accounts.lease;
    require!(
        ctx.accounts.vault.amount == lease.funded,
        EscrowError::VaultMismatch
    );
    require!(to_tenant <= lease.funded, EscrowError::Overpay);

    let lease_id_bytes = lease.lease_id.to_le_bytes();
    let bump = [lease.bump];
    let seeds: &[&[u8]] = &[
        LEASE_SEED,
        lease.landlord.as_ref(),
        lease.tenant.as_ref(),
        &lease_id_bytes,
        &bump,
    ];
    let signer_seeds = &[seeds];
    let token_program = ctx.accounts.token_program.key();

    if to_tenant > 0 {
        token::transfer_checked(
            CpiContext::new_with_signer(
                token_program,
                TransferChecked {
                    from: ctx.accounts.vault.to_account_info(),
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.tenant_token.to_account_info(),
                    authority: ctx.accounts.lease.to_account_info(),
                },
                signer_seeds,
            ),
            to_tenant,
            ctx.accounts.mint.decimals,
        )?;
    }

    token::close_account(CpiContext::new_with_signer(
        token_program,
        CloseAccount {
            account: ctx.accounts.vault.to_account_info(),
            destination: ctx.accounts.landlord.to_account_info(),
            authority: ctx.accounts.lease.to_account_info(),
        },
        signer_seeds,
    ))?;
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,

    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,

    /// This program's ProgramData; only its upgrade authority may initialize Config.
    #[account(
        seeds = [crate::ID.as_ref()],
        bump,
        seeds::program = BPF_LOADER_UPGRADEABLE_ID,
        constraint = program_data.upgrade_authority_address == Some(admin.key()) @ EscrowError::Unauthorized
    )]
    pub program_data: Account<'info, ProgramData>,

    pub usdc_mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateConfig<'info> {
    pub admin: Signer<'info>,

    #[account(
        mut,
        seeds = [CONFIG_SEED],
        bump = config.bump,
        has_one = admin @ EscrowError::Unauthorized
    )]
    pub config: Account<'info, Config>,

    pub usdc_mint: Account<'info, Mint>,
}

#[derive(Accounts)]
#[instruction(lease_id: u64)]
pub struct CreateLease<'info> {
    #[account(mut)]
    pub landlord: Signer<'info>,

    /// CHECK: only the tenant's pubkey is recorded; the tenant signs later when funding.
    pub tenant: UncheckedAccount<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    /// Deposit mint: must be the USDC mint recorded in Config.
    #[account(address = config.usdc_mint @ EscrowError::MintNotAllowed)]
    pub mint: Account<'info, Mint>,

    #[account(
        init,
        payer = landlord,
        space = 8 + Lease::INIT_SPACE,
        seeds = [LEASE_SEED, landlord.key().as_ref(), tenant.key().as_ref(), &lease_id.to_le_bytes()],
        bump
    )]
    pub lease: Account<'info, Lease>,

    #[account(
        init,
        payer = landlord,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump,
        token::mint = mint,
        token::authority = lease,
        token::token_program = token_program
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundDeposit<'info> {
    pub tenant: Signer<'info>,

    #[account(
        mut,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), lease.tenant.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump,
        constraint = lease.tenant == tenant.key() @ EscrowError::Unauthorized
    )]
    pub lease: Account<'info, Lease>,

    #[account(address = lease.mint @ EscrowError::WrongMint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = tenant_token.mint == lease.mint @ EscrowError::WrongMint,
        constraint = tenant_token.owner == tenant.key() @ EscrowError::WrongTokenOwner
    )]
    pub tenant_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump = lease.vault_bump,
        constraint = vault.mint == lease.mint @ EscrowError::WrongMint
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Shared accounts for every instruction that pays out and closes the lease.
#[derive(Accounts)]
pub struct CloseOut<'info> {
    /// Landlord or tenant for cancel_lease; anyone for auto_refund.
    pub caller: Signer<'info>,

    #[account(
        mut,
        close = landlord,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), lease.tenant.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,

    /// CHECK: must be the lease's landlord; receives the rent from the vault and the lease.
    #[account(mut, address = lease.landlord @ EscrowError::WrongLandlord)]
    pub landlord: UncheckedAccount<'info>,

    #[account(address = lease.mint @ EscrowError::WrongMint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = tenant_token.mint == lease.mint @ EscrowError::WrongMint,
        constraint = tenant_token.owner == lease.tenant @ EscrowError::WrongTokenOwner
    )]
    pub tenant_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump = lease.vault_bump,
        constraint = vault.mint == lease.mint @ EscrowError::WrongMint
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ProposeDeduction<'info> {
    pub landlord: Signer<'info>,

    #[account(
        mut,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), lease.tenant.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump,
        constraint = lease.landlord == landlord.key() @ EscrowError::Unauthorized
    )]
    pub lease: Account<'info, Lease>,
}

#[derive(Accounts)]
pub struct Dispute<'info> {
    pub tenant: Signer<'info>,

    #[account(
        mut,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), lease.tenant.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump,
        constraint = lease.tenant == tenant.key() @ EscrowError::Unauthorized
    )]
    pub lease: Account<'info, Lease>,
}

/// Accounts for every Week 2 payout that splits the vault between landlord and tenant.
#[derive(Accounts)]
pub struct Settle<'info> {
    /// Tenant for accept_deduction; anyone for auto_accept; arbiter checks live in ResolveDispute.
    pub caller: Signer<'info>,

    #[account(
        mut,
        close = landlord,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), lease.tenant.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,

    /// CHECK: must be the lease's landlord; receives the rent from the vault and the lease.
    #[account(mut, address = lease.landlord @ EscrowError::WrongLandlord)]
    pub landlord: UncheckedAccount<'info>,

    #[account(address = lease.mint @ EscrowError::WrongMint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = landlord_token.mint == lease.mint @ EscrowError::WrongMint,
        constraint = landlord_token.owner == lease.landlord @ EscrowError::WrongTokenOwner
    )]
    pub landlord_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = tenant_token.mint == lease.mint @ EscrowError::WrongMint,
        constraint = tenant_token.owner == lease.tenant @ EscrowError::WrongTokenOwner
    )]
    pub tenant_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump = lease.vault_bump,
        constraint = vault.mint == lease.mint @ EscrowError::WrongMint
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct ResolveDispute<'info> {
    /// The lease's arbiter, or the Config admin when the lease has none.
    pub arbiter: Signer<'info>,

    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        close = landlord,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), lease.tenant.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,

    /// CHECK: must be the lease's landlord; receives the rent from the vault and the lease.
    #[account(mut, address = lease.landlord @ EscrowError::WrongLandlord)]
    pub landlord: UncheckedAccount<'info>,

    #[account(address = lease.mint @ EscrowError::WrongMint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = landlord_token.mint == lease.mint @ EscrowError::WrongMint,
        constraint = landlord_token.owner == lease.landlord @ EscrowError::WrongTokenOwner
    )]
    pub landlord_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = tenant_token.mint == lease.mint @ EscrowError::WrongMint,
        constraint = tenant_token.owner == lease.tenant @ EscrowError::WrongTokenOwner
    )]
    pub tenant_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump = lease.vault_bump,
        constraint = vault.mint == lease.mint @ EscrowError::WrongMint
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct MutualRelease<'info> {
    #[account(mut, address = lease.landlord @ EscrowError::Unauthorized)]
    pub landlord: Signer<'info>,

    #[account(address = lease.tenant @ EscrowError::Unauthorized)]
    pub tenant: Signer<'info>,

    #[account(
        mut,
        close = landlord,
        seeds = [LEASE_SEED, lease.landlord.as_ref(), lease.tenant.as_ref(), &lease.lease_id.to_le_bytes()],
        bump = lease.bump
    )]
    pub lease: Account<'info, Lease>,

    #[account(address = lease.mint @ EscrowError::WrongMint)]
    pub mint: Account<'info, Mint>,

    #[account(
        mut,
        constraint = landlord_token.mint == lease.mint @ EscrowError::WrongMint,
        constraint = landlord_token.owner == lease.landlord @ EscrowError::WrongTokenOwner
    )]
    pub landlord_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        constraint = tenant_token.mint == lease.mint @ EscrowError::WrongMint,
        constraint = tenant_token.owner == lease.tenant @ EscrowError::WrongTokenOwner
    )]
    pub tenant_token: Account<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lease.key().as_ref()],
        bump = lease.vault_bump,
        constraint = vault.mint == lease.mint @ EscrowError::WrongMint
    )]
    pub vault: Account<'info, TokenAccount>,

    pub token_program: Program<'info, Token>,
}

/// Global settings, PDA `["config"]`.
#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    /// The only mint `create_lease` accepts.
    pub usdc_mint: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Lease {
    pub landlord: Pubkey,
    pub tenant: Pubkey,
    /// Opt-in arbiter; Pubkey::default() means none.
    pub arbiter: Pubkey,
    pub mint: Pubkey,
    /// Part of the PDA seeds, stored so the program can sign for the vault.
    pub lease_id: u64,
    pub amount: u64,
    pub funded: u64,
    pub lease_end_ts: i64,
    pub claim_window_secs: i64,
    /// Time the tenant has after a proposal to dispute; after it, anyone can auto_accept.
    pub response_window_secs: i64,
    /// SHA-256 of the signed agreement PDF (from SewaCheck).
    pub terms_hash: [u8; 32],
    pub status: LeaseStatus,
    pub deduction: u64,
    pub evidence_hash: [u8; 32],
    pub proposed_ts: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum LeaseStatus {
    Created,
    Active,
    DeductionProposed,
    Disputed,
    Settled,
    Cancelled,
}

#[error_code]
pub enum EscrowError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Lease end must be in the future")]
    LeaseEndInPast,
    #[msg("Claim window must not be negative")]
    InvalidClaimWindow,
    #[msg("Landlord and tenant must be different wallets")]
    SameParty,
    #[msg("Lease is not in the required status for this action")]
    InvalidStatus,
    #[msg("Funding would exceed the required deposit")]
    Overfund,
    #[msg("Signer is not allowed to perform this action")]
    Unauthorized,
    #[msg("Claim window has not ended yet")]
    DeadlineNotReached,
    #[msg("A deduction claim exists on this lease")]
    ClaimExists,
    #[msg("Mint does not match the lease mint")]
    WrongMint,
    #[msg("Token account is not owned by the expected wallet")]
    WrongTokenOwner,
    #[msg("Landlord account does not match the lease")]
    WrongLandlord,
    #[msg("Vault balance does not match the funded amount")]
    VaultMismatch,
    #[msg("Payout would exceed the funded amount")]
    Overpay,
    #[msg("Arithmetic overflow")]
    MathOverflow,
    #[msg("Mint is not the allowed USDC mint")]
    MintNotAllowed,
    #[msg("Response window must not be negative")]
    InvalidResponseWindow,
    #[msg("Arbiter must not be the landlord or the tenant")]
    ArbiterIsParty,
    #[msg("Deduction exceeds the funded deposit")]
    DeductionTooLarge,
    #[msg("Evidence hash is required")]
    MissingEvidence,
    #[msg("Lease has not ended yet")]
    LeaseNotEnded,
    #[msg("Claim window has closed")]
    ClaimWindowClosed,
    #[msg("Response window has closed")]
    ResponseWindowClosed,
    #[msg("Ruling exceeds the claimed deduction")]
    ExceedsClaim,
}
