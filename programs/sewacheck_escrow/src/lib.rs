//! SewaCheck Escrow: a tenancy deposit held in a program-owned SPL token vault.
//!
//! Week 1 scope (SPEC.md section 10): create_lease, fund_deposit, cancel_lease,
//! plus auto_refund (tenant gets 100% when the landlord misses the claim window).
//! Deductions, disputes and mutual release arrive in Week 2.
use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Mint, Token, TokenAccount, TransferChecked};

declare_id!("9Uu5DcNxbueKnS2UdYuAQnQCBwHH6QnBo8RtNNQ91mrQ");

/// Default claim window when 0 is passed: 14 days.
pub const DEFAULT_CLAIM_WINDOW_SECS: i64 = 14 * 24 * 60 * 60;
pub const LEASE_SEED: &[u8] = b"lease";
pub const VAULT_SEED: &[u8] = b"vault";

#[program]
pub mod sewacheck_escrow {
    use super::*;

    /// Landlord opens a lease. The tenant pubkey and terms are fixed here.
    pub fn create_lease(
        ctx: Context<CreateLease>,
        lease_id: u64,
        amount: u64,
        lease_end_ts: i64,
        arbiter: Pubkey,
        terms_hash: [u8; 32],
        claim_window_secs: i64,
    ) -> Result<()> {
        require!(amount > 0, EscrowError::InvalidAmount);
        require!(claim_window_secs >= 0, EscrowError::InvalidClaimWindow);
        let now = Clock::get()?.unix_timestamp;
        require!(lease_end_ts > now, EscrowError::LeaseEndInPast);
        let landlord = ctx.accounts.landlord.key();
        let tenant = ctx.accounts.tenant.key();
        require_keys_neq!(landlord, tenant, EscrowError::SameParty);

        let claim_window = if claim_window_secs == 0 {
            DEFAULT_CLAIM_WINDOW_SECS
        } else {
            claim_window_secs
        };
        // Make sure the deadline arithmetic can never overflow later.
        lease_end_ts
            .checked_add(claim_window)
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
#[instruction(lease_id: u64)]
pub struct CreateLease<'info> {
    #[account(mut)]
    pub landlord: Signer<'info>,

    /// CHECK: only the tenant's pubkey is recorded; the tenant signs later when funding.
    pub tenant: UncheckedAccount<'info>,

    /// Deposit mint (USDC on devnet/mainnet; a test mint locally).
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
}
