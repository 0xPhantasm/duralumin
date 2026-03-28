const { Connection, Keypair, Transaction, ComputeBudgetProgram, PublicKey } = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");
const { Program } = require("@coral-xyz/anchor");
const arcium = require("@arcium-hq/client");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

async function main() {
  const conn = new Connection("http://127.0.0.1:8899", "confirmed");
  const kp = Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(fs.readFileSync(path.join(process.env.HOME, ".config/solana/id.json"), "utf-8")))
  );
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync("./target/idl/private_voting.json", "utf-8"));
  const program = new Program(idl, provider);
  const PROGRAM_ID = program.programId;
  const CLUSTER_OFFSET = 0;

  const pollId = new anchor.BN(Date.now());
  const [pollPDA] = PublicKey.findProgramAddressSync(
    [Buffer.from("poll"), kp.publicKey.toBuffer(), pollId.toArrayLike(Buffer, "le", 8)],
    PROGRAM_ID
  );

  const offset = new anchor.BN(crypto.randomBytes(8).toString("hex"), "hex");

  const ix = await program.methods
    .createPoll(offset, pollId, "Test question?", ["Yes", "No"], new anchor.BN(Math.floor(Date.now() / 1000) + 86400))
    .accountsPartial({
      pollAcc: pollPDA,
      computationAccount: arcium.getComputationAccAddress(CLUSTER_OFFSET, offset),
      clusterAccount: arcium.getClusterAccAddress(CLUSTER_OFFSET),
      mxeAccount: arcium.getMXEAccAddress(PROGRAM_ID),
      mempoolAccount: arcium.getMempoolAccAddress(CLUSTER_OFFSET),
      executingPool: arcium.getExecutingPoolAccAddress(CLUSTER_OFFSET),
      compDefAccount: arcium.getCompDefAccAddress(PROGRAM_ID, Buffer.from(arcium.getCompDefAccOffset("init_tallies")).readUInt32LE()),
      poolAccount: arcium.getFeePoolAccAddress(),
      clockAccount: arcium.getClockAccAddress(),
      arciumProgram: arcium.getArciumProgramId(),
    })
    .instruction();

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new Transaction();
  tx.recentBlockhash = blockhash;
  tx.feePayer = kp.publicKey;
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ix
  );
  tx.sign(kp);

  // Simulate
  const sim = await conn.simulateTransaction(tx);
  console.log("Simulation err:", sim.value.err);
  if (sim.value.logs) {
    for (const l of sim.value.logs.slice(-10)) console.log(" ", l);
  }

  if (!sim.value.err) {
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    console.log("Sent:", sig);
    await new Promise((r) => setTimeout(r, 3000));
    const { value } = await conn.getSignatureStatuses([sig]);
    console.log("Status:", JSON.stringify(value[0]));
  }
}
main().catch(console.error);
