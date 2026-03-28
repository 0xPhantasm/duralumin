"use client";

import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Program } from "@coral-xyz/anchor";
import { useMemo } from "react";
import { PrivateVoting } from "@/lib/types";
import IDL from "@/lib/idl.json";
import { PROGRAM_ID } from "@/lib/constants";

export function useProgram() {
  const { connection } = useConnection();
  const wallet = useWallet();

  const provider = useMemo(() => {
    if (!wallet.publicKey || !wallet.signTransaction) return null;
    return new AnchorProvider(
      connection,
      wallet as any,
      { commitment: "confirmed" }
    );
  }, [connection, wallet]);

  const program = useMemo(() => {
    if (!provider) return null;
    return new Program<PrivateVoting>(IDL as any, provider);
  }, [provider]);

  return { program, provider, connection, wallet };
}
