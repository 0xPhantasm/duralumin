export type PollStatus = "open" | "closed" | "revealed";

export function parsePollStatus(status: any): PollStatus {
  if (status.open !== undefined) return "open";
  if (status.closed !== undefined) return "closed";
  if (status.revealed !== undefined) return "revealed";
  return "open";
}

const styles: Record<PollStatus, string> = {
  open: "bg-green-500/20 text-green-400 border-green-500/30",
  closed: "bg-yellow-500/20 text-yellow-400 border-yellow-500/30",
  revealed: "bg-violet-500/20 text-violet-400 border-violet-500/30",
};

export default function StatusBadge({ status }: { status: PollStatus }) {
  return (
    <span
      className={`inline-block rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${styles[status]}`}
    >
      {status}
    </span>
  );
}
