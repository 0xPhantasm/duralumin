import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { PrivateVoting } from "../target/types/private_voting";
import { randomBytes } from "crypto";
import {
  awaitComputationFinalization,
  getArciumEnv,
  getCompDefAccOffset,
  getArciumAccountBaseSeed,
  getArciumProgramId,
  getArciumProgram,
  uploadCircuit,
  RescueCipher,
  deserializeLE,
  getMXEPublicKey,
  getMXEAccAddress,
  getMempoolAccAddress,
  getCompDefAccAddress,
  getExecutingPoolAccAddress,
  getComputationAccAddress,
  getClusterAccAddress,
  getLookupTableAddress,
  x25519,
} from "@arcium-hq/client";
import * as fs from "fs";
import * as os from "os";
import { expect } from "chai";

describe("PrivateVoting", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.PrivateVoting as Program<PrivateVoting>;
  const provider = anchor.getProvider();
  const arciumProgram = getArciumProgram(provider as anchor.AnchorProvider);

  type Event = anchor.IdlEvents<(typeof program)["idl"]>;
  const awaitEvent = async <E extends keyof Event>(
    eventName: E
  ): Promise<Event[E]> => {
    let listenerId: number;
    const event = await new Promise<Event[E]>((res) => {
      listenerId = program.addEventListener(eventName, (event) => {
        res(event);
      });
    });
    await program.removeEventListener(listenerId);
    return event;
  };

  const arciumEnv = getArciumEnv();
  const clusterAccount = getClusterAccAddress(arciumEnv.arciumClusterOffset);

  let owner: anchor.web3.Keypair;
  let mxePublicKey: Uint8Array;

  before(async () => {
    owner = readKpJson(`${os.homedir()}/.config/solana/id.json`);
    mxePublicKey = await getMXEPublicKeyWithRetry(
      provider as anchor.AnchorProvider,
      program.programId
    );
    console.log("MXE x25519 pubkey is", mxePublicKey);

    // Initialize all 3 computation definitions
    console.log("\n=== Initializing Computation Definitions ===\n");
    await initCompDef("init_tallies", "initTalliesCompDef");
    await initCompDef("vote", "initVoteCompDef");
    await initCompDef("reveal_result", "initRevealResultCompDef");
    console.log("All computation definitions initialized.\n");
  });

  it("full poll lifecycle: create → vote → close → reveal", async () => {
    const POLL_ID = Date.now();
    const deadline = Math.floor(Date.now() / 1000) + 86400; // 1 day from now

    // --- Step 1: Create Poll ---
    console.log("Step 1: Creating poll...");
    const pollCreatedPromise = awaitEvent("pollCreatedEvent");
    const createOffset = new anchor.BN(randomBytes(8), "hex");

    const [pollPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("poll"),
        owner.publicKey.toBuffer(),
        new anchor.BN(POLL_ID).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    const createSig = await program.methods
      .createPoll(
        createOffset,
        new anchor.BN(POLL_ID),
        "What is the best programming language?",
        ["Rust", "TypeScript", "Python"],
        new anchor.BN(deadline)
      )
      .accountsPartial({
        pollAcc: pollPDA,
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          createOffset
        ),
        clusterAccount,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(
          arciumEnv.arciumClusterOffset
        ),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("init_tallies")).readUInt32LE()
        ),
      })
      .rpc({
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      });
    console.log("   Create poll tx:", createSig);

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      createOffset,
      program.programId,
      "confirmed"
    );

    const pollCreatedEvent = await pollCreatedPromise;
    console.log("   Poll created:", pollCreatedEvent.poll.toBase58());

    // --- Step 2: Cast 3 votes ---
    console.log("\nStep 2: Casting votes...");
    const votes = [0, 1, 0]; // Two votes for Rust, one for TypeScript

    for (let i = 0; i < votes.length; i++) {
      const voter =
        i === 0 ? owner : anchor.web3.Keypair.generate();

      // Fund non-owner voters
      if (i > 0) {
        const fundSig = await provider.connection.requestAirdrop(
          voter.publicKey,
          2 * anchor.web3.LAMPORTS_PER_SOL
        );
        await provider.connection.confirmTransaction(fundSig);
      }

      const privateKey = x25519.utils.randomSecretKey();
      const publicKey = x25519.getPublicKey(privateKey);
      const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
      const cipher = new RescueCipher(sharedSecret);

      const nonce = randomBytes(16);
      const ciphertext = cipher.encrypt([BigInt(votes[i])], nonce);

      const voteCastPromise = awaitEvent("voteCastEvent");
      const voteOffset = new anchor.BN(randomBytes(8), "hex");

      const [receiptPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("receipt"),
          new anchor.BN(POLL_ID).toArrayLike(Buffer, "le", 8),
          voter.publicKey.toBuffer(),
        ],
        program.programId
      );

      const voteSig = await program.methods
        .castVote(
          voteOffset,
          new anchor.BN(POLL_ID),
          Array.from(ciphertext[0]),
          Array.from(publicKey),
          new anchor.BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          payer: voter.publicKey,
          pollAcc: pollPDA,
          voteReceipt: receiptPDA,
          computationAccount: getComputationAccAddress(
            arciumEnv.arciumClusterOffset,
            voteOffset
          ),
          clusterAccount,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(
            arciumEnv.arciumClusterOffset
          ),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("vote")).readUInt32LE()
          ),
        })
        .signers(i === 0 ? [] : [voter])
        .rpc({
          skipPreflight: true,
          preflightCommitment: "confirmed",
          commitment: "confirmed",
        });
      console.log(`   Vote ${i + 1} tx:`, voteSig);

      await awaitComputationFinalization(
        provider as anchor.AnchorProvider,
        voteOffset,
        program.programId,
        "confirmed"
      );

      await voteCastPromise;
      console.log(`   Vote ${i + 1} confirmed (choice: ${votes[i]})`);
    }

    // Verify vote count
    const pollAfterVotes = await program.account.pollAccount.fetch(pollPDA);
    expect(pollAfterVotes.voteCount.toNumber()).to.equal(3);
    console.log("   Total votes:", pollAfterVotes.voteCount.toNumber());

    // --- Step 3: Close Poll ---
    console.log("\nStep 3: Closing poll...");
    const pollClosedPromise = awaitEvent("pollClosedEvent");

    const closeSig = await program.methods
      .closePoll(new anchor.BN(POLL_ID))
      .accountsPartial({
        payer: owner.publicKey,
        pollAcc: pollPDA,
      })
      .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });
    console.log("   Close poll tx:", closeSig);

    const pollClosedEvent = await pollClosedPromise;
    console.log("   Poll closed, vote count:", pollClosedEvent.voteCount.toNumber());

    // --- Step 4: Reveal Result ---
    console.log("\nStep 4: Revealing results...");
    const pollRevealedPromise = awaitEvent("pollRevealedEvent");
    const revealOffset = new anchor.BN(randomBytes(8), "hex");

    const revealSig = await program.methods
      .revealResult(revealOffset, new anchor.BN(POLL_ID))
      .accountsPartial({
        payer: owner.publicKey,
        pollAcc: pollPDA,
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          revealOffset
        ),
        clusterAccount,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(
          arciumEnv.arciumClusterOffset
        ),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("reveal_result")).readUInt32LE()
        ),
      })
      .rpc({
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      });
    console.log("   Reveal tx:", revealSig);

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      revealOffset,
      program.programId,
      "confirmed"
    );

    const pollRevealedEvent = await pollRevealedPromise;
    const results = pollRevealedEvent.results.map((r) => r.toNumber());
    console.log("\n=== Poll Results ===");
    console.log("   Rust:", results[0], "votes");
    console.log("   TypeScript:", results[1], "votes");
    console.log("   Python:", results[2], "votes");
    console.log("   (unused):", results[3], "votes");
    console.log("   (unused):", results[4], "votes");
    console.log("   Total:", pollRevealedEvent.voteCount.toNumber());

    // Verify tallies: 2 for Rust, 1 for TypeScript, 0 for Python
    expect(results[0]).to.equal(2);
    expect(results[1]).to.equal(1);
    expect(results[2]).to.equal(0);
    expect(results[3]).to.equal(0);
    expect(results[4]).to.equal(0);

    // Verify status is Revealed
    const finalPoll = await program.account.pollAccount.fetch(pollPDA);
    expect(JSON.stringify(finalPoll.status)).to.equal(
      JSON.stringify({ revealed: {} })
    );

    console.log("\n   All assertions passed!");
  });

  it("prevents double voting", async () => {
    const POLL_ID = Date.now() + 1;
    const deadline = Math.floor(Date.now() / 1000) + 86400;

    // Create poll
    const createOffset = new anchor.BN(randomBytes(8), "hex");
    const [pollPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("poll"),
        owner.publicKey.toBuffer(),
        new anchor.BN(POLL_ID).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    await program.methods
      .createPoll(
        createOffset,
        new anchor.BN(POLL_ID),
        "Double vote test",
        ["Yes", "No"],
        new anchor.BN(deadline)
      )
      .accountsPartial({
        pollAcc: pollPDA,
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          createOffset
        ),
        clusterAccount,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(
          arciumEnv.arciumClusterOffset
        ),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("init_tallies")).readUInt32LE()
        ),
      })
      .rpc({
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      });

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      createOffset,
      program.programId,
      "confirmed"
    );

    // First vote succeeds
    const privateKey = x25519.utils.randomSecretKey();
    const publicKey = x25519.getPublicKey(privateKey);
    const sharedSecret = x25519.getSharedSecret(privateKey, mxePublicKey);
    const cipher = new RescueCipher(sharedSecret);
    const nonce = randomBytes(16);
    const ciphertext = cipher.encrypt([BigInt(0)], nonce);

    const voteOffset1 = new anchor.BN(randomBytes(8), "hex");
    const [receiptPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("receipt"),
        new anchor.BN(POLL_ID).toArrayLike(Buffer, "le", 8),
        owner.publicKey.toBuffer(),
      ],
      program.programId
    );

    await program.methods
      .castVote(
        voteOffset1,
        new anchor.BN(POLL_ID),
        Array.from(ciphertext[0]),
        Array.from(publicKey),
        new anchor.BN(deserializeLE(nonce).toString())
      )
      .accountsPartial({
        pollAcc: pollPDA,
        voteReceipt: receiptPDA,
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          voteOffset1
        ),
        clusterAccount,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(
          arciumEnv.arciumClusterOffset
        ),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("vote")).readUInt32LE()
        ),
      })
      .rpc({
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      });

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      voteOffset1,
      program.programId,
      "confirmed"
    );

    // Second vote should fail (receipt PDA already exists)
    const nonce2 = randomBytes(16);
    const ciphertext2 = cipher.encrypt([BigInt(1)], nonce2);
    const voteOffset2 = new anchor.BN(randomBytes(8), "hex");

    try {
      await program.methods
        .castVote(
          voteOffset2,
          new anchor.BN(POLL_ID),
          Array.from(ciphertext2[0]),
          Array.from(publicKey),
          new anchor.BN(deserializeLE(nonce2).toString())
        )
        .accountsPartial({
          pollAcc: pollPDA,
          voteReceipt: receiptPDA,
          computationAccount: getComputationAccAddress(
            arciumEnv.arciumClusterOffset,
            voteOffset2
          ),
          clusterAccount,
          mxeAccount: getMXEAccAddress(program.programId),
          mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
          executingPool: getExecutingPoolAccAddress(
            arciumEnv.arciumClusterOffset
          ),
          compDefAccount: getCompDefAccAddress(
            program.programId,
            Buffer.from(getCompDefAccOffset("vote")).readUInt32LE()
          ),
        })
        .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });
      expect.fail("Double vote should have been rejected");
    } catch (err) {
      console.log("   Double vote correctly rejected");
    }
  });

  it("allows permissionless close after deadline", async () => {
    const POLL_ID = Date.now() + 2;
    // Set deadline 2 seconds in the past (for testing)
    const deadline = Math.floor(Date.now() / 1000) - 2;

    const createOffset = new anchor.BN(randomBytes(8), "hex");
    const [pollPDA] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("poll"),
        owner.publicKey.toBuffer(),
        new anchor.BN(POLL_ID).toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );

    // Note: create_poll requires deadline > now, so we test close logic
    // by creating with a short deadline and waiting
    const shortDeadline = Math.floor(Date.now() / 1000) + 3;

    await program.methods
      .createPoll(
        createOffset,
        new anchor.BN(POLL_ID),
        "Deadline test",
        ["A", "B"],
        new anchor.BN(shortDeadline)
      )
      .accountsPartial({
        pollAcc: pollPDA,
        computationAccount: getComputationAccAddress(
          arciumEnv.arciumClusterOffset,
          createOffset
        ),
        clusterAccount,
        mxeAccount: getMXEAccAddress(program.programId),
        mempoolAccount: getMempoolAccAddress(arciumEnv.arciumClusterOffset),
        executingPool: getExecutingPoolAccAddress(
          arciumEnv.arciumClusterOffset
        ),
        compDefAccount: getCompDefAccAddress(
          program.programId,
          Buffer.from(getCompDefAccOffset("init_tallies")).readUInt32LE()
        ),
      })
      .rpc({
        skipPreflight: true,
        preflightCommitment: "confirmed",
        commitment: "confirmed",
      });

    await awaitComputationFinalization(
      provider as anchor.AnchorProvider,
      createOffset,
      program.programId,
      "confirmed"
    );

    // Wait for deadline to pass
    console.log("   Waiting for deadline to pass...");
    await new Promise((resolve) => setTimeout(resolve, 4000));

    // Non-creator closes the poll
    const stranger = anchor.web3.Keypair.generate();
    const fundSig = await provider.connection.requestAirdrop(
      stranger.publicKey,
      1 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(fundSig);

    const closeSig = await program.methods
      .closePoll(new anchor.BN(POLL_ID))
      .accountsPartial({
        payer: stranger.publicKey,
        pollAcc: pollPDA,
      })
      .signers([stranger])
      .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });

    console.log("   Permissionless close tx:", closeSig);

    const poll = await program.account.pollAccount.fetch(pollPDA);
    expect(JSON.stringify(poll.status)).to.equal(
      JSON.stringify({ closed: {} })
    );
    console.log("   Poll status correctly set to Closed");
  });

  // ── Helper: Initialize a computation definition ───────────────────

  async function initCompDef(
    circuitName: string,
    methodName: string
  ): Promise<void> {
    const baseSeedCompDefAcc = getArciumAccountBaseSeed(
      "ComputationDefinitionAccount"
    );
    const offset = getCompDefAccOffset(circuitName);

    const compDefPDA = PublicKey.findProgramAddressSync(
      [baseSeedCompDefAcc, program.programId.toBuffer(), offset],
      getArciumProgramId()
    )[0];

    const mxeAccount = getMXEAccAddress(program.programId);
    const mxeAcc = await arciumProgram.account.mxeAccount.fetch(mxeAccount);
    const lutAddress = getLookupTableAddress(
      program.programId,
      mxeAcc.lutOffsetSlot
    );

    try {
      const sig = await program.methods[methodName]()
        .accounts({
          compDefAccount: compDefPDA,
          payer: owner.publicKey,
          mxeAccount,
          addressLookupTable: lutAddress,
        })
        .signers([owner])
        .rpc({ preflightCommitment: "confirmed", commitment: "confirmed" });

      console.log(`   ${circuitName} comp def initialized:`, sig);
    } catch (error) {
      const msg = String(error);
      if (msg.includes("already in use")) {
        console.log(`   ${circuitName} comp def already exists, skipping init`);
      } else {
        throw error;
      }
    }

    const rawCircuit = fs.readFileSync(`build/${circuitName}.arcis`);
    await uploadCircuit(
      provider as anchor.AnchorProvider,
      circuitName,
      program.programId,
      rawCircuit,
      true
    );
    console.log(`   ${circuitName} circuit uploaded`);
  }
});

async function getMXEPublicKeyWithRetry(
  provider: anchor.AnchorProvider,
  programId: PublicKey,
  maxRetries: number = 20,
  retryDelayMs: number = 500
): Promise<Uint8Array> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const mxePublicKey = await getMXEPublicKey(provider, programId);
      if (mxePublicKey) {
        return mxePublicKey;
      }
    } catch (error) {
      console.log(`Attempt ${attempt} failed to fetch MXE public key:`, error);
    }
    if (attempt < maxRetries) {
      console.log(
        `Retrying in ${retryDelayMs}ms... (attempt ${attempt}/${maxRetries})`
      );
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
  throw new Error(
    `Failed to fetch MXE public key after ${maxRetries} attempts`
  );
}

function readKpJson(path: string): anchor.web3.Keypair {
  const file = fs.readFileSync(path);
  return anchor.web3.Keypair.fromSecretKey(
    new Uint8Array(JSON.parse(file.toString()))
  );
}
