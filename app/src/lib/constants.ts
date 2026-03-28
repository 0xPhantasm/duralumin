import { PublicKey } from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "HumFumqkg2zvc1pyXymGtJ7b2GY3RhxbYy7TEJtWdmA5"
);

// Arcium cluster offset (localnet = 0).
export const CLUSTER_OFFSET = parseInt(
  process.env.NEXT_PUBLIC_ARCIUM_CLUSTER_OFFSET || "0"
);

// PDA seeds
export const SIGN_PDA_SEED = Buffer.from("ArciumSignerAccount");

// Poll constraints (must match on-chain)
export const MAX_QUESTION_LEN = 200;
export const MAX_OPTION_LEN = 50;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 5;
