"use client";

import { useEffect, useState } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { Program, AnchorProvider } from "@coral-xyz/anchor";
import { PrivateVoting } from "@/lib/types";
import IDL from "@/lib/idl.json";
import PollCard from "@/components/PollCard";
import Link from "next/link";

interface PollData {
  address: string;
  question: string;
  options: string[];
  voteCount: number;
  status: any;
  deadline: number;
  creator: string;
}

export default function Home() {
  const { connection } = useConnection();
  const [polls, setPolls] = useState<PollData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchPolls() {
      try {
        // Read-only provider (no wallet needed to browse)
        const readProvider = new AnchorProvider(
          connection,
          {} as any,
          { commitment: "confirmed" }
        );
        const program = new Program<PrivateVoting>(IDL as any, readProvider);
        const accounts = await program.account.pollAccount.all();

        const mapped: PollData[] = accounts.map((acc) => ({
          address: acc.publicKey.toBase58(),
          question: acc.account.question,
          options: acc.account.options,
          voteCount: (acc.account.voteCount as any).toNumber(),
          status: acc.account.status,
          deadline: (acc.account.deadline as any).toNumber(),
          creator: acc.account.creator.toBase58(),
        }));

        // Sort by newest first
        mapped.sort((a, b) => b.deadline - a.deadline);
        setPolls(mapped);
      } catch (err) {
        console.error("Failed to fetch polls:", err);
      } finally {
        setLoading(false);
      }
    }

    fetchPolls();
  }, [connection]);

  return (
    <div>
      <div className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Active Polls</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Vote privately on any open poll. Your vote is encrypted end-to-end
            via Arcium MPC.
          </p>
        </div>
        <Link
          href="/create"
          className="rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-700 transition-colors"
        >
          New Poll
        </Link>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-zinc-700 border-t-violet-500" />
        </div>
      ) : polls.length === 0 ? (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 py-20 text-center">
          <p className="text-zinc-500">No polls yet.</p>
          <Link
            href="/create"
            className="mt-3 inline-block text-sm text-violet-400 hover:text-violet-300"
          >
            Create the first one &rarr;
          </Link>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {polls.map((poll) => (
            <PollCard key={poll.address} {...poll} />
          ))}
        </div>
      )}
    </div>
  );
}
