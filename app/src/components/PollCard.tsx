import Link from "next/link";
import StatusBadge, { parsePollStatus } from "./StatusBadge";

interface PollCardProps {
  address: string;
  question: string;
  options: string[];
  voteCount: number;
  status: any;
  deadline: number;
  creator: string;
}

export default function PollCard({
  address,
  question,
  options,
  voteCount,
  status,
  deadline,
  creator,
}: PollCardProps) {
  const parsed = parsePollStatus(status);
  const deadlineDate = new Date(deadline * 1000);
  const isExpired = deadlineDate < new Date();

  return (
    <Link
      href={`/poll/${address}`}
      className="block rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition-colors hover:border-zinc-700 hover:bg-zinc-900"
    >
      <div className="mb-3 flex items-start justify-between gap-2">
        <h3 className="text-base font-semibold text-white line-clamp-2">
          {question}
        </h3>
        <StatusBadge status={parsed} />
      </div>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {options.map((opt, i) => (
          <span
            key={i}
            className="rounded-md bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
          >
            {opt}
          </span>
        ))}
      </div>

      <div className="flex items-center justify-between text-xs text-zinc-500">
        <span>{voteCount} vote{voteCount !== 1 ? "s" : ""}</span>
        <span className={isExpired ? "text-red-400" : ""}>
          {isExpired ? "Expired" : `Ends ${deadlineDate.toLocaleDateString()}`}
        </span>
      </div>

      <div className="mt-2 text-xs text-zinc-600 truncate">
        by {creator.slice(0, 4)}...{creator.slice(-4)}
      </div>
    </Link>
  );
}
