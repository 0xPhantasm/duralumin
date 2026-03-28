"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import { PrivateVoting } from "@/lib/types";
import IDL from "@/lib/idl.json";
import { PROGRAM_ID } from "@/lib/constants";
import { usePollActions, getReceiptPDA } from "@/hooks/usePollActions";
import StatusBadge, { parsePollStatus } from "@/components/StatusBadge";

interface PollData {
  question: string;
  options: string[];
  numOptions: number;
  voteCount: number;
  status: any;
  deadline: number;
  createdAt: number;
  creator: string;
  id: BN;
  results: number[];
}

export default function PollDetailPage() {
  const params = useParams();
  const address = params.address as string;
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const { castVote, closePoll, revealResult } = usePollActions();

  const [poll, setPoll] = useState<PollData | null>(null);
  const [loading, setLoading] = useState(true);
  const [hasVoted, setHasVoted] = useState(false);
  const [selectedOption, setSelectedOption] = useState<number | null>(null);
  const [actionLoading, setActionLoading] = useState("");
  const [error, setError] = useState("");
  const [txSig, setTxSig] = useState("");

  const pollPDA = (() => {
    try {
      return new PublicKey(address);
    } catch {
      return null;
    }
  })();

  const fetchPoll = useCallback(async () => {
    if (!pollPDA) return;
    try {
      const readProvider = new AnchorProvider(
        connection,
        {} as any,
        { commitment: "confirmed" }
      );
      const program = new Program<PrivateVoting>(IDL as any, readProvider);
      const acc = await program.account.pollAccount.fetch(pollPDA);

      setPoll({
        question: acc.question,
        options: acc.options,
        numOptions: acc.numOptions,
        voteCount: (acc.voteCount as any).toNumber(),
        status: acc.status,
        deadline: (acc.deadline as any).toNumber(),
        createdAt: (acc.createdAt as any).toNumber(),
        creator: acc.creator.toBase58(),
        id: acc.id as any,
        results: (acc.results as any).map((r: any) => r.toNumber()),
      });
    } catch (err) {
      console.error("Failed to fetch poll:", err);
    } finally {
      setLoading(false);
    }
  }, [connection, pollPDA]);

  // Check if current user already voted
  useEffect(() => {
    if (!publicKey || !poll) return;
    (async () => {
      try {
        const receiptPDA = getReceiptPDA(poll.id, publicKey);
        const info = await connection.getAccountInfo(receiptPDA);
        setHasVoted(info !== null);
      } catch {
        setHasVoted(false);
      }
    })();
  }, [publicKey, poll, connection]);

  useEffect(() => {
    fetchPoll();
  }, [fetchPoll]);

  if (!pollPDA) {
    return <p className="text-red-400">Invalid poll address.</p>;
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-violet-500" />
      </div>
    );
  }

  if (!poll) {
    return <p className="text-zinc-500">Poll not found.</p>;
  }

  const status = parsePollStatus(poll.status);
  const isCreator = publicKey?.toBase58() === poll.creator;
  const isExpired = poll.deadline * 1000 < Date.now();
  const canVote = status === "open" && !hasVoted && publicKey && !isExpired;
  const canClose =
    status === "open" && (isCreator || isExpired) && publicKey;
  const canReveal = status === "closed" && isCreator;

  const handleVote = async () => {
    if (selectedOption === null || !pollPDA) return;
    setError("");
    setActionLoading("vote");
    try {
      const sig = await castVote(pollPDA, poll.id, selectedOption);
      setTxSig(sig);
      setHasVoted(true);
      await fetchPoll();
    } catch (err: any) {
      setError(err?.message ?? "Vote failed.");
    } finally {
      setActionLoading("");
    }
  };

  const handleClose = async () => {
    if (!pollPDA) return;
    setError("");
    setActionLoading("close");
    try {
      const sig = await closePoll(pollPDA, poll.id);
      setTxSig(sig);
      await fetchPoll();
    } catch (err: any) {
      setError(err?.message ?? "Close failed.");
    } finally {
      setActionLoading("");
    }
  };

  const handleReveal = async () => {
    if (!pollPDA) return;
    setError("");
    setActionLoading("reveal");
    try {
      const sig = await revealResult(pollPDA, poll.id);
      setTxSig(sig);
      await fetchPoll();
    } catch (err: any) {
      setError(err?.message ?? "Reveal failed.");
    } finally {
      setActionLoading("");
    }
  };

  const totalVotes = poll.results.reduce((s, r) => s + r, 0);

  return (
    <div className="mx-auto max-w-2xl">
      {/* Header */}
      <div className="mb-6 flex items-start justify-between gap-4">
        <h1 className="text-2xl font-bold text-white">{poll.question}</h1>
        <StatusBadge status={status} />
      </div>

      <div className="mb-6 flex flex-wrap gap-4 text-sm text-zinc-400">
        <span>
          {poll.voteCount} vote{poll.voteCount !== 1 ? "s" : ""}
        </span>
        <span>
          Deadline: {new Date(poll.deadline * 1000).toLocaleString()}
        </span>
        <span className="truncate">
          Creator: {poll.creator.slice(0, 4)}...{poll.creator.slice(-4)}
        </span>
      </div>

      {/* Options / Voting / Results */}
      <div className="space-y-3">
        {poll.options.slice(0, poll.numOptions).map((opt, i) => {
          const votes = poll.results[i];
          const pct =
            status === "revealed" && totalVotes > 0
              ? Math.round((votes / totalVotes) * 100)
              : 0;

          return (
            <div key={i} className="relative">
              {/* Result bar background */}
              {status === "revealed" && (
                <div
                  className="absolute inset-0 rounded-lg bg-violet-500/10"
                  style={{ width: `${pct}%` }}
                />
              )}

              <div
                onClick={() => canVote && setSelectedOption(i)}
                className={`relative flex items-center justify-between rounded-lg border px-4 py-3 transition-colors ${
                  canVote
                    ? selectedOption === i
                      ? "border-violet-500 bg-violet-500/10 cursor-pointer"
                      : "border-zinc-700 hover:border-zinc-600 cursor-pointer"
                    : "border-zinc-800"
                }`}
              >
                <div className="flex items-center gap-3">
                  {canVote && (
                    <div
                      className={`h-4 w-4 rounded-full border-2 ${
                        selectedOption === i
                          ? "border-violet-500 bg-violet-500"
                          : "border-zinc-600"
                      }`}
                    />
                  )}
                  <span className="text-sm font-medium text-white">{opt}</span>
                </div>

                {status === "revealed" && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-zinc-400">{votes} votes</span>
                    <span className="font-medium text-violet-400">{pct}%</span>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Actions */}
      <div className="mt-6 space-y-3">
        {canVote && (
          <button
            onClick={handleVote}
            disabled={selectedOption === null || actionLoading === "vote"}
            className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {actionLoading === "vote" ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Encrypting &amp; submitting vote...
              </span>
            ) : (
              "Cast Encrypted Vote"
            )}
          </button>
        )}

        {hasVoted && status === "open" && (
          <p className="text-center text-sm text-green-400">
            You have already voted on this poll.
          </p>
        )}

        {canClose && (
          <button
            onClick={handleClose}
            disabled={actionLoading === "close"}
            className="w-full rounded-lg border border-zinc-700 py-2.5 text-sm font-medium text-zinc-300 hover:border-zinc-600 hover:text-white disabled:opacity-50 transition-colors"
          >
            {actionLoading === "close" ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Closing...
              </span>
            ) : (
              "Close Poll"
            )}
          </button>
        )}

        {canReveal && (
          <button
            onClick={handleReveal}
            disabled={actionLoading === "reveal"}
            className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 transition-colors"
          >
            {actionLoading === "reveal" ? (
              <span className="flex items-center justify-center gap-2">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
                Decrypting results via MPC...
              </span>
            ) : (
              "Reveal Results"
            )}
          </button>
        )}
      </div>

      {/* Error / Success */}
      {error && (
        <p className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
          {error}
        </p>
      )}

      {txSig && (
        <p className="mt-4 rounded-lg bg-green-500/10 px-3 py-2 text-sm text-green-400">
          Transaction confirmed:{" "}
          <span className="font-mono text-xs break-all">{txSig}</span>
        </p>
      )}

      {/* Encryption explainer */}
      <div className="mt-8 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <h3 className="text-sm font-medium text-zinc-300">
          How privacy works
        </h3>
        <p className="mt-1 text-xs text-zinc-500 leading-relaxed">
          Your vote is encrypted locally using x25519 key exchange and
          RescueCipher before being submitted on-chain. Votes are tallied inside
          Arcium&apos;s MPC network — no single party ever sees individual votes.
          Only the poll creator can trigger the reveal of final aggregate
          results.
        </p>
      </div>
    </div>
  );
}
