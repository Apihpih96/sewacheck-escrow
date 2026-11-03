// Pre-sprint scaffold only: proves the CI toolchain builds and tests.
// The escrow logic (lease, vault, deductions, disputes) is built during the sprint per SPEC.md.
use anchor_lang::prelude::*;

declare_id!("11111111111111111111111111111111");

#[program]
pub mod sewacheck_escrow {
    use super::*;

    pub fn ping(_ctx: Context<Ping>) -> Result<()> {
        msg!("sewacheck_escrow: ok");
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Ping {}
