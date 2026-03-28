"use client";

import Link from "next/link";
import dynamic from "next/dynamic";

const WalletMultiButtonDynamic = dynamic(
  async () =>
    (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

export default function Navbar() {
  return (
    <nav className="border-b border-zinc-800 bg-zinc-950">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-6">
          <Link
            href="/"
            className="text-lg font-bold tracking-tight text-white"
          >
            Private Voting
          </Link>
          <Link
            href="/create"
            className="text-sm text-zinc-400 hover:text-white transition-colors"
          >
            Create Poll
          </Link>
        </div>
        <WalletMultiButtonDynamic />
      </div>
    </nav>
  );
}
