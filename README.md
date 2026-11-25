# SewaCheck Escrow

Rental deposits held in a Solana program vault (USDC), released by rules both landlord and tenant signed — not by the landlord's mood.

Extends [SewaCheck](https://github.com/Apihpih96/Sewacheck), the Malaysian tenancy agreement checker.

**Status:** in active development for Colosseum Eternal (Nov 2026). Built so far: the core escrow (create_lease, fund_deposit, cancel_lease, auto_refund, USDC only), move-out deductions with evidence hashes, tenant disputes, an arbiter with a deadline, mutual release, a Next.js app with a Solana Pay funding link and QR code, and itemised evidence packs with in-browser verification. 60 Anchor tests run in CI on solana-test-validator. Week 1 update video: https://youtu.be/U2NvCo5oEXI

**Live demo (devnet):** https://sewacheck-escrow.vercel.app

**Final pitch video:** https://youtu.be/vXx0sRloTbk

**Demo video:** https://youtu.be/q8cjzbyXSFk

**Program ID (devnet):** `9Uu5DcNxbueKnS2UdYuAQnQCBwHH6QnBo8RtNNQ91mrQ`

## Evidence packs (sprint week 3)
At move-out the landlord lists each deduction ("Broken wardrobe door: 350 USDC") and attaches its photos or invoices. Every file is SHA-256 fingerprinted in the browser and never uploaded. The app builds a small canonical JSON manifest (lease address, items, amounts, file names and hashes); the manifest's SHA-256 is the `evidence_hash` sent with `propose_deduction`, and the deduction equals the items' total. The landlord keeps the downloaded `.json` and shares it with the photos.

On the lease page, **Verify documents** lets the tenant, the arbiter, or anyone drop in the pack and its files and see, item by item, whether they are exactly what was committed on-chain. A swapped photo, an edited amount or a pack for another lease fails. The arbiter can tick the items they accept and prefill the ruling with that subtotal. The same panel checks the signed agreement against `terms_hash`. No program change: the on-chain field is the same 32 bytes, so older single-file claims still verify.

Code: `app/src/lib/evidence.ts` (pack, canonical hash, checks), `app/src/components/EvidencePackBuilder.tsx`, `app/src/components/VerifyEvidence.tsx`, tests in `app/test/evidence.test.ts`.

## Layout
- `programs/sewacheck_escrow/` — Anchor program (Rust)
- `tests/` — Anchor TypeScript tests incl. invariant tests
- `app/` — Next.js app + Solana Pay deposit link
