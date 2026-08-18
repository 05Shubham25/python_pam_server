import clsx from "clsx";

export function Avatar({
  name,
  size = 28,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  const initials = name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  // deterministic hue from name
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + hash * 31;
  const hue = Math.abs(hash) % 360;

  return (
    <span
      style={{
        width: size,
        height: size,
        fontSize: size * 0.38,
        backgroundColor: `hsl(${hue} 45% 22%)`,
        color: `hsl(${hue} 70% 78%)`,
      }}
      className={clsx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-mono font-semibold",
        className,
      )}
    >
      {initials}
    </span>
  );
}
