# SewaCheck Escrow

Rental deposits held in a Solana program vault (USDC), released by rules both landlord and tenant signed — not by the landlord's mood.

Extends [SewaCheck](https://github.com/Apihpih96/Sewacheck), the Malaysian tenancy agreement checker.

**Status:** in active development for Colosseum Eternal (Nov 2026). Built so far: the core escrow (create_lease, fund_deposit, cancel_lease, auto_refund, USDC only), move-out deductions with evidence hashes, tenant disputes, an arbiter with a deadline, mutual release, and a Next.js app with a Solana Pay funding link and QR code. 60 Anchor tests run in CI on solana-test-validator. Week 1 update video: https://youtu.be/U2NvCo5oEXI

**Live demo (devnet):** https://sewacheck-escrow.vercel.app

## Layout
- `programs/sewacheck_escrow/` — Anchor program (Rust)
- `tests/` — Anchor TypeScript tests incl. invariant tests
- `app/` — Next.js app + Solana Pay deposit link
