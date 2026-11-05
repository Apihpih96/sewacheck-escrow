import { describe, expect, it } from "vitest";
import { mapError, PROGRAM_ERRORS } from "../src/lib/errors";
import idl from "../src/idl/sewacheck_escrow.json";

const PID = "9Uu5DcNxbueKnS2UdYuAQnQCBwHH6QnBo8RtNNQ91mrQ";
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

describe("error mapping", () => {
  it("covers every program error in the IDL with a friendly message", () => {
    for (const e of idl.errors) {
      expect(PROGRAM_ERRORS[e.code]?.name).toBe(e.name);
      expect(PROGRAM_ERRORS[e.code]?.msg.length).toBeGreaterThan(5);
    }
    expect(idl.errors.length).toBe(27);
  });

  it("maps Anchor log lines (Error Number)", () => {
    const logs = [
      `Program ${PID} invoke [1]`,
      "Program log: AnchorError thrown in programs/sewacheck_escrow/src/lib.rs:251. Error Code: ResponseWindowClosed. Error Number: 6022. Error Message: Response window has closed.",
      `Program ${PID} failed: custom program error: 0x1786`,
    ];
    const m = mapError({ message: "Simulation failed", logs });
    expect(m.code).toBe(6022);
    expect(m.name).toBe("ResponseWindowClosed");
    expect(m.message).toMatch(/response window/i);
  });

  it("maps hex custom errors from our program", () => {
    expect(mapError(new Error(`Program ${PID} failed: custom program error: 0x1770`)).name).toBe("InvalidAmount");
    expect(mapError({ message: `{"InstructionError":[0,{"Custom":6004}]}` }).name).toBe("InvalidStatus");
  });

  it("does not confuse SPL Token error 0x1 with a program error", () => {
    const m = mapError({ logs: [`Program ${TOKEN} invoke [2]`, "Program log: Error: insufficient funds", `Program ${TOKEN} failed: custom program error: 0x1`] });
    expect(m.message).toMatch(/Not enough USDC/);
  });

  it("maps Anchor framework constraint errors", () => {
    expect(mapError({ logs: ["Program log: AnchorError caused by account: vault. Error Code: ConstraintSeeds. Error Number: 2006."] }).message).toMatch(/seeds/);
    expect(mapError({ logs: ["Error Code: AccountNotInitialized. Error Number: 3012."] }).message).toMatch(/doesn't exist/);
  });

  it("maps wallet and network errors", () => {
    expect(mapError(new Error("User rejected the request.")).message).toMatch(/cancelled/);
    expect(mapError(new Error("Attempt to debit an account but found no record of a prior credit.")).message).toMatch(/devnet SOL/);
    expect(mapError(new Error("Blockhash not found")).message).toMatch(/expired/);
    expect(mapError({ error: { message: "429 Too Many Requests" } }).message).toMatch(/rate-limiting/);
  });

  it("falls back to the first message, truncated", () => {
    expect(mapError(new Error("x".repeat(1000))).message.length).toBe(300);
    expect(mapError(undefined).message).toBe("Something went wrong.");
  });
});
