"use client";

import { useCallback } from "react";
import {
  PublicKey,
  SystemProgram,
  Transaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { x25519 } from "@noble/curves/ed25519";
import IDL from "@/lib/idl.json";
import { PrivateVoting } from "@/lib/types";
import { PROGRAM_ID, CLUSTER_OFFSET, SIGN_PDA_SEED } from "@/lib/constants";

export function getPollPDA(creator: PublicKey, pollId: BN): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("poll"),
      creator.toBuffer(),
      pollId.toArrayLike(Buffer, "le", 8),
    ],
    PROGRAM_ID
  );
  return pda;
}

export function getReceiptPDA(pollId: BN, voter: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("receipt"),
      pollId.toArrayLike(Buffer, "le", 8),
      voter.toBuffer(),
    ],
    PROGRAM_ID
  );
  return pda;
}

export function usePollActions() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const getProvider = useCallback(() => {
    if (!wallet.publicKey || !wallet.signTransaction || !wallet.signAllTransactions) {
      throw new Error("Wallet not connected");
    }
    return new AnchorProvider(
      connection,
      {
        publicKey: wallet.publicKey,
        signTransaction: wallet.signTransaction,
        signAllTransactions: wallet.signAllTransactions,
      },
      { commitment: "confirmed" }
    );
  }, [connection, wallet]);

  const createPoll = useCallback(
    async (
      question: string,
      options: string[],
      deadlineUnix: number
    ): Promise<{ pollPDA: PublicKey; signature: string }> => {
      if (!wallet.publicKey) throw new Error("Wallet not connected");

      // Dynamic import to avoid SSR issues
      const arcium = await import("@arcium-hq/client");
      const {
        getClusterAccAddress,
        getMXEAccAddress,
        getMempoolAccAddress,
        getExecutingPoolAccAddress,
        getComputationAccAddress,
        getCompDefAccAddress,
        getCompDefAccOffset,
        getArciumProgramId,
        getFeePoolAccAddress,
        getClockAccAddress,
      } = arcium;

      const provider = getProvider();
      const program = new Program(IDL as any, provider) as unknown as Program<PrivateVoting>;

      const pollId = new BN(Date.now());
      const pollPDA = getPollPDA(wallet.publicKey, pollId);
      const computationOffset = new BN(Date.now());

      const [signPda] = PublicKey.findProgramAddressSync([SIGN_PDA_SEED], PROGRAM_ID);
      const compDefOffset = Buffer.from(getCompDefAccOffset("init_tallies")).readUInt32LE();

      const ix = await program.methods
        .createPoll(
          computationOffset,
          pollId,
          question,
          options,
          new BN(deadlineUnix)
        )
        .accountsPartial({
          payer: wallet.publicKey,
          signPdaAccount: signPda,
          mxeAccount: getMXEAccAddress(PROGRAM_ID),
          mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
          executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
          computationAccount: getComputationAccAddress(CLUSTER_OFFSET, computationOffset),
          compDefAccount: getCompDefAccAddress(PROGRAM_ID, compDefOffset),
          clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
          poolAccount: getFeePoolAccAddress(),
          clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId,
          arciumProgram: getArciumProgramId(),
          pollAcc: pollPDA,
        })
        .instruction();

      const signature = await buildAndSendTx(connection, wallet, ix);

      // Wait for MPC callback (init_tallies_callback sets nonce != 0)
      const pollStartTime = Date.now();
      const pollTimeout = 120_000;
      while (Date.now() - pollStartTime < pollTimeout) {
        try {
          const acc = await program.account.pollAccount.fetch(pollPDA, "confirmed");
          if (acc.nonce.toString() !== "0") break;
        } catch { /* not created yet */ }
        await new Promise((r) => setTimeout(r, 3000));
      }

      return { pollPDA, signature };
    },
    [connection, wallet, getProvider]
  );

  const castVote = useCallback(
    async (
      pollPDA: PublicKey,
      pollId: BN,
      choice: number
    ): Promise<string> => {
      if (!wallet.publicKey) throw new Error("Wallet not connected");

      // Dynamic import to avoid SSR issues
      const arcium = await import("@arcium-hq/client");
      const {
        RescueCipher,
        getClusterAccAddress,
        getMXEAccAddress,
        getMempoolAccAddress,
        getExecutingPoolAccAddress,
        getComputationAccAddress,
        getCompDefAccAddress,
        getCompDefAccOffset,
        getMXEPublicKey,
        getArciumProgramId,
        getFeePoolAccAddress,
        getClockAccAddress,
        deserializeLE,
      } = arcium;

      const provider = getProvider();
      const program = new Program(IDL as any, provider) as unknown as Program<PrivateVoting>;

      // x25519 encryption
      const mxePubkey = await getMXEPublicKey(provider, PROGRAM_ID);
      if (!mxePubkey) throw new Error("Failed to get MXE public key");
      const privateKey = x25519.utils.randomPrivateKey();
      const clientPubkey = x25519.getPublicKey(privateKey);
      const sharedSecret = x25519.getSharedSecret(privateKey, mxePubkey);
      const cipher = new RescueCipher(sharedSecret);
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const ciphertext = cipher.encrypt([BigInt(choice)], nonce);

      const pollBefore = await program.account.pollAccount.fetch(pollPDA, "confirmed");
      const countBefore = (pollBefore.voteCount as BN).toNumber();

      const receiptPDA = getReceiptPDA(pollId, wallet.publicKey);
      const computationOffset = new BN(Date.now());

      const [signPda] = PublicKey.findProgramAddressSync([SIGN_PDA_SEED], PROGRAM_ID);
      const compDefOffset = Buffer.from(getCompDefAccOffset("vote")).readUInt32LE();

      const ix = await program.methods
        .castVote(
          computationOffset,
          pollId,
          Array.from(ciphertext[0]) as any,
          Array.from(clientPubkey) as any,
          new BN(deserializeLE(nonce).toString())
        )
        .accountsPartial({
          payer: wallet.publicKey,
          signPdaAccount: signPda,
          mxeAccount: getMXEAccAddress(PROGRAM_ID),
          mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
          executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
          computationAccount: getComputationAccAddress(CLUSTER_OFFSET, computationOffset),
          compDefAccount: getCompDefAccAddress(PROGRAM_ID, compDefOffset),
          clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
          poolAccount: getFeePoolAccAddress(),
          clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId,
          arciumProgram: getArciumProgramId(),
          pollAcc: pollPDA,
          voteReceipt: receiptPDA,
        })
        .instruction();

      const signature = await buildAndSendTx(connection, wallet, ix);

      // Wait for MPC callback (vote_callback increments voteCount)
      const pollStartTime = Date.now();
      const pollTimeout = 120_000;
      while (Date.now() - pollStartTime < pollTimeout) {
        try {
          const acc = await program.account.pollAccount.fetch(pollPDA, "confirmed");
          if ((acc.voteCount as BN).toNumber() > countBefore) break;
        } catch { /* transient */ }
        await new Promise((r) => setTimeout(r, 3000));
      }

      return signature;
    },
    [connection, wallet, getProvider]
  );

  const closePoll = useCallback(
    async (pollPDA: PublicKey, pollId: BN): Promise<string> => {
      if (!wallet.publicKey) throw new Error("Wallet not connected");

      const provider = getProvider();
      const program = new Program(IDL as any, provider) as unknown as Program<PrivateVoting>;

      const ix = await program.methods
        .closePoll(pollId)
        .accountsPartial({
          payer: wallet.publicKey,
          pollAcc: pollPDA,
        })
        .instruction();

      return buildAndSendTx(connection, wallet, ix);
    },
    [connection, wallet, getProvider]
  );

  const revealResult = useCallback(
    async (pollPDA: PublicKey, pollId: BN): Promise<string> => {
      if (!wallet.publicKey) throw new Error("Wallet not connected");

      // Dynamic import to avoid SSR issues
      const arcium = await import("@arcium-hq/client");
      const {
        getClusterAccAddress,
        getMXEAccAddress,
        getMempoolAccAddress,
        getExecutingPoolAccAddress,
        getComputationAccAddress,
        getCompDefAccAddress,
        getCompDefAccOffset,
        getArciumProgramId,
        getFeePoolAccAddress,
        getClockAccAddress,
      } = arcium;

      const provider = getProvider();
      const program = new Program(IDL as any, provider) as unknown as Program<PrivateVoting>;

      const computationOffset = new BN(Date.now());

      const [signPda] = PublicKey.findProgramAddressSync([SIGN_PDA_SEED], PROGRAM_ID);
      const compDefOffset = Buffer.from(getCompDefAccOffset("reveal_result")).readUInt32LE();

      const ix = await program.methods
        .revealResult(computationOffset, pollId)
        .accountsPartial({
          payer: wallet.publicKey,
          signPdaAccount: signPda,
          mxeAccount: getMXEAccAddress(PROGRAM_ID),
          mempoolAccount: getMempoolAccAddress(CLUSTER_OFFSET),
          executingPool: getExecutingPoolAccAddress(CLUSTER_OFFSET),
          computationAccount: getComputationAccAddress(CLUSTER_OFFSET, computationOffset),
          compDefAccount: getCompDefAccAddress(PROGRAM_ID, compDefOffset),
          clusterAccount: getClusterAccAddress(CLUSTER_OFFSET),
          poolAccount: getFeePoolAccAddress(),
          clockAccount: getClockAccAddress(),
          systemProgram: SystemProgram.programId,
          arciumProgram: getArciumProgramId(),
          pollAcc: pollPDA,
        })
        .instruction();

      const signature = await buildAndSendTx(connection, wallet, ix);

      // Wait for MPC callback (reveal_result_callback sets status = Revealed)
      const pollStartTime = Date.now();
      const pollTimeout = 120_000;
      while (Date.now() - pollStartTime < pollTimeout) {
        try {
          const acc = await program.account.pollAccount.fetch(pollPDA, "confirmed");
          if (acc.status.revealed !== undefined) break;
        } catch { /* transient */ }
        await new Promise((r) => setTimeout(r, 3000));
      }

      return signature;
    },
    [connection, wallet, getProvider]
  );

  return { createPoll, castVote, closePoll, revealResult, getPollPDA };
}

// ─── Transaction helper (matches Alloy pattern exactly) ─────────────────────

async function buildAndSendTx(
  connection: any,
  wallet: any,
  txInstr: anchor.web3.TransactionInstruction
): Promise<string> {
  if (!wallet.publicKey || !wallet.signTransaction)
    throw new Error("Wallet not connected");

  const priorityFeeIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200_000 });
  const computeUnitsIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });

  // Retry blockhash fetch
  let blockhash!: string;
  let lastValidBlockHeight!: number;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await connection.getLatestBlockhash("confirmed");
      blockhash = result.blockhash;
      lastValidBlockHeight = result.lastValidBlockHeight;
      break;
    } catch (fetchErr) {
      if (attempt === 3) throw fetchErr;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  const builtTx = new Transaction({
    blockhash,
    lastValidBlockHeight,
    feePayer: wallet.publicKey!,
  });
  builtTx.add(priorityFeeIx, computeUnitsIx, txInstr);

  // Simulate with auto-retry for transient Arcium errors
  const RETRYABLE_CODES = new Set([6004, 6603]);
  const MAX_SIM_RETRIES = 5;
  const SIM_RETRY_DELAY = 2500;

  for (let simRetry = 1; simRetry <= MAX_SIM_RETRIES; simRetry++) {
    const simResult = await connection.simulateTransaction(builtTx);
    if (!simResult.value.err) break;
    const errStr = JSON.stringify(simResult.value.err);
    const customMatch = errStr.match(/"Custom":(\d+)/);
    if (customMatch && RETRYABLE_CODES.has(Number(customMatch[1]))) {
      console.warn(`Simulation transient error (attempt ${simRetry}/${MAX_SIM_RETRIES}): ${errStr}`);
      const fresh = await connection.getLatestBlockhash("confirmed");
      builtTx.recentBlockhash = fresh.blockhash;
      builtTx.lastValidBlockHeight = fresh.lastValidBlockHeight;
      await new Promise((r) => setTimeout(r, SIM_RETRY_DELAY));
      continue;
    }
    // Non-retryable simulation error — log and proceed to send (matches Alloy behavior).
    // AccountNotFound can happen when simulation races against account creation or
    // Codespaces tunnelling returns stale state; the on-chain tx will confirm if valid.
    console.warn(
      `Simulation warning (attempt ${simRetry}/${MAX_SIM_RETRIES}): ${errStr}\nLogs:\n${simResult.value.logs?.join("\n") ?? "(none)"}`
    );
    break;
  }

  // Sign and send with retry mechanism
  const signedTx = await wallet.signTransaction!(builtTx);
  const rawTx = signedTx.serialize();

  let tx: string | null = null;
  let confirmed = false;
  const maxAttempts = 3;

  for (let attempt = 1; attempt <= maxAttempts && !confirmed; attempt++) {
    tx = await connection.sendRawTransaction(rawTx, {
      skipPreflight: true,
      maxRetries: 3,
    });
    console.log(`Sent tx (attempt ${attempt}/${maxAttempts}): ${tx}`);

    // Poll for confirmation
    const startTime = Date.now();
    const timeout = 45_000;
    while (Date.now() - startTime < timeout) {
      const status = await connection.getSignatureStatus(tx);
      if (
        status.value?.confirmationStatus === "confirmed" ||
        status.value?.confirmationStatus === "finalized"
      ) {
        if (status.value.err)
          throw new Error(
            `Transaction failed on-chain: ${JSON.stringify(status.value.err)}`
          );
        confirmed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (!confirmed && attempt < maxAttempts) {
      console.warn(`Tx ${tx} not confirmed, retrying…`);
    }
  }

  if (!confirmed) {
    throw new Error(
      `Transaction not confirmed after ${maxAttempts} attempts (last sig: ${tx})`
    );
  }

  return tx!;
}
