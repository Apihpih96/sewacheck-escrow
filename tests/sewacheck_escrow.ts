import * as anchor from "@coral-xyz/anchor";

describe("sewacheck_escrow scaffold", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.SewacheckEscrow;

  it("ping", async () => {
    const sig = await program.methods.ping().rpc();
    console.log("ping tx", sig);
  });
});
