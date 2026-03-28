"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePollActions } from "@/hooks/usePollActions";
import {
  MAX_QUESTION_LEN,
  MAX_OPTION_LEN,
  MIN_OPTIONS,
  MAX_OPTIONS,
} from "@/lib/constants";

export default function CreatePollPage() {
  const router = useRouter();
  const { publicKey } = useWallet();
  const { createPoll } = usePollActions();

  const [question, setQuestion] = useState("");
  const [options, setOptions] = useState(["", ""]);
  const [hoursFromNow, setHoursFromNow] = useState(24);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const addOption = () => {
    if (options.length < MAX_OPTIONS) setOptions([...options, ""]);
  };

  const removeOption = (idx: number) => {
    if (options.length > MIN_OPTIONS) {
      setOptions(options.filter((_, i) => i !== idx));
    }
  };

  const updateOption = (idx: number, val: string) => {
    const next = [...options];
    next[idx] = val;
    setOptions(next);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    if (!publicKey) {
      setError("Connect your wallet first.");
      return;
    }

    const trimmedQ = question.trim();
    const trimmedOpts = options.map((o) => o.trim()).filter(Boolean);

    if (!trimmedQ) {
      setError("Question is required.");
      return;
    }
    if (trimmedQ.length > MAX_QUESTION_LEN) {
      setError(`Question must be under ${MAX_QUESTION_LEN} characters.`);
      return;
    }
    if (trimmedOpts.length < MIN_OPTIONS) {
      setError(`At least ${MIN_OPTIONS} options are required.`);
      return;
    }
    if (trimmedOpts.some((o) => o.length > MAX_OPTION_LEN)) {
      setError(`Each option must be under ${MAX_OPTION_LEN} characters.`);
      return;
    }

    const deadlineUnix = Math.floor(Date.now() / 1000) + hoursFromNow * 3600;

    setSubmitting(true);
    try {
      const { pollPDA } = await createPoll(trimmedQ, trimmedOpts, deadlineUnix);
      router.push(`/poll/${pollPDA.toBase58()}`);
    } catch (err: any) {
      console.error(err);
      setError(err?.message ?? "Transaction failed.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-lg">
      <h1 className="mb-6 text-2xl font-bold text-white">Create a Poll</h1>

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Question */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-zinc-300">
            Question
          </label>
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={MAX_QUESTION_LEN}
            placeholder="What should we decide?"
            className="w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
          />
          <p className="mt-1 text-xs text-zinc-500">
            {question.length}/{MAX_QUESTION_LEN}
          </p>
        </div>

        {/* Options */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-zinc-300">
            Options
          </label>
          <div className="space-y-2">
            {options.map((opt, i) => (
              <div key={i} className="flex gap-2">
                <input
                  type="text"
                  value={opt}
                  onChange={(e) => updateOption(i, e.target.value)}
                  maxLength={MAX_OPTION_LEN}
                  placeholder={`Option ${i + 1}`}
                  className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white placeholder:text-zinc-500 focus:border-violet-500 focus:outline-none"
                />
                {options.length > MIN_OPTIONS && (
                  <button
                    type="button"
                    onClick={() => removeOption(i)}
                    className="rounded-lg border border-zinc-700 px-3 text-sm text-zinc-400 hover:border-red-500 hover:text-red-400 transition-colors"
                  >
                    &times;
                  </button>
                )}
              </div>
            ))}
          </div>
          {options.length < MAX_OPTIONS && (
            <button
              type="button"
              onClick={addOption}
              className="mt-2 text-sm text-violet-400 hover:text-violet-300"
            >
              + Add option
            </button>
          )}
        </div>

        {/* Deadline */}
        <div>
          <label className="mb-1.5 block text-sm font-medium text-zinc-300">
            Deadline (hours from now)
          </label>
          <input
            type="number"
            min={1}
            max={8760}
            value={hoursFromNow}
            onChange={(e) => setHoursFromNow(Number(e.target.value))}
            className="w-32 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm text-white focus:border-violet-500 focus:outline-none"
          />
        </div>

        {error && (
          <p className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting || !publicKey}
          className="w-full rounded-lg bg-violet-600 py-2.5 text-sm font-medium text-white hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {submitting ? (
            <span className="flex items-center justify-center gap-2">
              <span className="h-4 w-4 animate-spin rounded-full border-2 border-white/30 border-t-white" />
              Creating &amp; initializing tallies...
            </span>
          ) : !publicKey ? (
            "Connect wallet to create"
          ) : (
            "Create Poll"
          )}
        </button>
      </form>
    </div>
  );
}
