# SewaCheck Escrow

Rental deposits held in a Solana program vault (USDC), released by rules both landlord and tenant signed — not by the landlord's mood.

Extends [SewaCheck](https://github.com/Apihpih96/Sewacheck), the Malaysian tenancy agreement checker.

Being built for **Colosseum Eternal**. Status: design only — see [SPEC.md](SPEC.md). Code lands during the 4-week sprint.

## Planned layout
- `programs/sewacheck_escrow/` — Anchor program (Rust)
- `tests/` — Anchor TypeScript tests incl. invariant tests
- `app/` — Next.js app + Solana Pay deposit link
