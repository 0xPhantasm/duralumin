/**
 * setup-localnet.ts
 *
 * Run AFTER `arcium localnet` is up.  Initializes the three computation
 * definitions (init_tallies, vote, reveal_result) so the frontend can
 * queue MPC computations.
 *
 * Usage:
 *   npx ts-node --esm scripts/setup-localnet.ts
 *   # or via ts-mocha / tsx depending on what's installed
 */

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  getMXEAccAddress,
  getMXEPublicKey,
  getCompDefAccOffset,
  getCompDefAccAddress,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  getLookupTableAddress,
  buildFinalizeCompDefTx,
} from "@arcium-hq/client";
import fs from "fs";
import path from "path";

// ── Config ──────────────────────────────────────────────────────────

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8899";

const COMP_DEFS: { circuitName: string; methodName: string }[] = [
  { circuitName: "init_tallies", methodName: "initTalliesCompDef" },
  { circuitName: "vote", methodName: "initVoteCompDef" },
  { circuitName: "reveal_result", methodName: "initRevealResultCompDef" },
];

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  // Load keypair
  const keypairPath = path.join(
    process.env.HOME || "",
    ".config",
    "solana",
    "id.json"
  );
  const keypairData = JSON.parse(fs.readFileSync(keypairPath, "utf-8"));
  const payer = Keypair.fromSecretKey(new Uint8Array(keypairData));

  // Connect to localnet
  const connection = new Connection(RPC_URL, "confirmed");
  const wallet = new anchor.Wallet(payer as any);
  const provider = new anchor.AnchorProvider(connection as any, wallet, {
    commitment: "confirmed",
  });

  // Load program IDL
  const idlPath = path.resolve(__dirname, "../target/idl/private_voting.json");
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf-8"));
  const program = new Program(idl, provider);
  const programId = program.programId;

  console.log("Setting up localnet for program:", programId.toBase58());
  console.log("Payer:", payer.publicKey.toBase58());

  // ── Step 1: Wait for MXE keygen ──────────────────────────────────

  console.log("\n--- Step 1: Waiting for MXE keygen ---");
  let mxePubkey: Uint8Array | null = null;
  for (let i = 1; i <= 120; i++) {
    try {
      mxePubkey = await getMXEPublicKey(
        provider as anchor.AnchorProvider,
        programId
      );
      if (mxePubkey) {
        console.log(
          "✅ MXE keygen complete! Public key:",
          Buffer.from(mxePubkey).toString("hex")
        );
        break;
      }
    } catch {}
    if (i % 10 === 0) console.log(`  Still waiting... (${i}s)`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  if (!mxePubkey) {
    console.error("❌ MXE keygen did not complete after 120s");
    process.exit(1);
  }

  // ── Step 2: Initialize computation definitions ────────────────────

  console.log("\n--- Step 2: Initializing computation definitions ---");

  const baseSeedCompDefAcc = getArciumAccountBaseSeed(
    "ComputationDefinitionAccount"
  );
  const arciumProgram = getArciumProgram(provider);
  const mxeAccount = getMXEAccAddress(programId);
  const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
  const lutAddress = getLookupTableAddress(programId, mxeAcc.lutOffsetSlot);

  for (const { circuitName, methodName } of COMP_DEFS) {
    console.log(`\n  Initializing "${circuitName}"...`);

    const offset = getCompDefAccOffset(circuitName);
    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];

    // Check if already initialized
    const existing = await connection.getAccountInfo(compDefPDA);
    if (existing) {
      console.log(`  ⚠️  "${circuitName}" already initialized (skipping)`);
      continue;
    }

    try {
      // Init comp def
      const sig = await (program.methods as any)
        [methodName]()
        .accounts({
          compDefAccount: compDefPDA,
          payer: payer.publicKey,
          mxeAccount: mxeAccount,
          addressLookupTable: lutAddress,
        } as any)
        .signers([payer])
        .rpc({ commitment: "confirmed", preflightCommitment: "confirmed" });
      console.log(`  Init tx: ${sig}`);

      // Finalize comp def
      const finalizeTx = await buildFinalizeCompDefTx(
        provider,
        Buffer.from(offset).readUInt32LE(),
        programId
      );
      const latestBlockhash = await connection.getLatestBlockhash();
      finalizeTx.recentBlockhash = latestBlockhash.blockhash;
      finalizeTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight;
      finalizeTx.sign(payer);
      await provider.sendAndConfirm(finalizeTx);
      console.log(`  ✅ "${circuitName}" initialized and finalized`);
    } catch (error: any) {
      if (error.message?.includes("already in use")) {
        console.log(`  ⚠️  "${circuitName}" already initialized (skipping)`);
      } else {
        console.error(`  ❌ Error initializing "${circuitName}":`, error.message || error);
        process.exit(1);
      }
    }
  }

  // ── Done ──────────────────────────────────────────────────────────

  console.log("\n🎉 Localnet setup complete! Frontend is ready to use.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
