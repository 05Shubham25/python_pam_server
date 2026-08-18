export function TableSkeleton({ rows = 5, cols = 6 }: { rows?: number; cols?: number }) {
  return (
    <div className="divide-y divide-border/60">
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} className="flex items-center gap-6 px-5 py-3.5">
          {Array.from({ length: cols }).map((_, c) => (
            <div
              key={c}
              className="skeleton-row h-3.5 flex-1"
              style={{ animationDelay: `${(r * cols + c) * 60}ms` }}
            />
          ))}
        </div>
      ))}
    </div>
  );
}
