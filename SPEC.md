# SewaCheck Escrow — Technical Spec (pre-sprint)

Status: design only. Code is written during the Colosseum Eternal 4-week sprint.

## 1. Problem
Malaysian residential deposits (commonly 2 months security + 1 month utility) are held by the landlord with no neutral custody. Disputes at move-out are slow and costly to pursue for small amounts. Tenants have little leverage and landlords have no cheap way to prove legitimate deductions.

## 2. Product
A tenancy deposit held in a Solana program vault in USDC, released by rules both parties signed when the lease was created. It extends SewaCheck, which already checks tenancy agreements for unfair clauses before signing.

## 3. Actors
| Actor | Wallet | Can |
|---|---|---|
| Landlord | signer | create lease, propose deductions, approve release |
| Tenant | signer | fund deposit, accept/dispute deductions, approve release |
| Arbiter | signer (opt-in, chosen at creation) | rule on disputes only |
| Anyone | any | crank the auto-refund after the deadline |

## 4. On-chain state
`Lease` PDA — seeds `["lease", landlord, tenant, lease_id(u64)]`
- landlord, tenant, arbiter: Pubkey
- mint: Pubkey (USDC only, checked against config)
- amount: u64 — required deposit
- funded: u64
- lease_end_ts: i64
- claim_window_secs: i64 (default 14 days)
- terms_hash: [u8;32] — SHA-256 of the signed agreement PDF (from SewaCheck)
- status: enum { Created, Active, DeductionProposed, Disputed, Settled, Cancelled }
- deduction: u64, evidence_hash: [u8;32], proposed_ts: i64
- bump, vault_bump

`vault` — ATA of the Lease PDA for the USDC mint.

## 5. Instructions
| # | Instruction | Signer | Pre-status → Post | Notes |
|---|---|---|---|---|
| 1 | create_lease(lease_id, amount, lease_end_ts, arbiter, terms_hash, claim_window) | landlord | — → Created | tenant pubkey fixed here |
| 2 | fund_deposit(amount) | tenant | Created → Active when funded == amount | partial funding allowed |
| 3 | cancel_lease | landlord or tenant | Created → Cancelled | refunds any partial funding to tenant |
| 4 | propose_deduction(deduction, evidence_hash) | landlord | Active → DeductionProposed | only after lease_end_ts and before lease_end_ts + claim_window; deduction ≤ funded |
| 5 | accept_deduction | tenant | DeductionProposed → Settled | pays deduction to landlord, rest to tenant |
| 6 | dispute | tenant | DeductionProposed → Disputed | within 7 days of proposal |
| 7 | resolve_dispute(to_landlord) | arbiter | Disputed → Settled | to_landlord ≤ deduction claimed |
| 8 | auto_refund | anyone | Active (past end + window, no claim) → Settled | 100% to tenant |
| 9 | auto_accept | anyone | DeductionProposed (7 days, no dispute) → Settled | silence = acceptance |
| 10 | mutual_release(to_landlord) | landlord + tenant | Active → Settled | early exit, both sign one tx |

All payouts close the vault and the Lease account, with rent going back to the landlord who paid it.

## 6. Invariants to test
- Vault balance == funded until Settled; 0 after.
- No path pays out more than funded.
- The landlord can never take funds without either tenant consent, arbiter ruling, or tenant silence after a valid proposal.
- The tenant always gets 100% if the landlord misses the claim window.
- Arbiter cannot act unless status == Disputed.
- Wrong mint / wrong vault / wrong signer → error.

## 7. Off-chain
- Evidence (move-out photos, invoices) stored on Arweave/IPFS; only the hash goes on-chain.
- Next.js app: landlord uploads the agreement → SewaCheck check → hash → create lease → shareable Solana Pay / Blink link for the tenant to fund from a phone.
- Notifications: email/Telegram when status changes and before the claim window ends.

## 8. Business model (pitch)
Flat fee per lease (e.g. a small % of the deposit, capped) paid by the landlord, or a landlord/agent subscription. Property agents managing many units are the wedge.

## 9. Risks
- Fiat on-ramp in Malaysia → partner on-ramp; devnet for the MVP.
- Regulatory: holding deposits may touch trust/escrow rules → the program is non-custodial (no company key can move funds); legal review before mainnet.
- Arbiter trust → opt-in, named at creation, can only split within claimed amount.

## 10. Sprint scope (4 weeks)
W1 instructions 1–3 + tests + devnet · W2 instructions 4–10 + invariant tests · W3 app + Solana Pay link · W4 user tests with 3–5 renters/landlords, security checklist, pitch + demo videos.
