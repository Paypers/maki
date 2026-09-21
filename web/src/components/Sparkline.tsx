/**
 * A ten-day line beside an item, 56×18. Recessive by default; the accent when
 * the story is that it is flat against the ceiling -- sold out most days, so
 * the line shows supply, not demand.
 *
 * No axes, no labels, no tooltip: at this size it is a glyph that says
 * "trending up", "flat", "erratic", and the number beside it is the value.
 */

interface Props {
  /** Oldest first. Nulls are days with no record and leave a gap. */
  values: Array<number | null>;
  /** Draw in the accent. */
  hot?: boolean;
  width?: number;
  height?: number;
  className?: string;
}

export function Sparkline({ values, hot, width = 56, height = 18, className }: Props) {
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) {
    return <svg width={width} height={height} className={`spark${className ? ` ${className}` : ""}`} aria-hidden="true" />;
  }
  const max = Math.max(...known, 1);
  const min = Math.min(...known, 0);
  const span = max - min || 1;
  const pad = 2;
  const stepX = (width - pad * 2) / (values.length - 1);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);

  // One polyline per run of known values, so a missing day breaks the line
  // instead of being drawn through as if it were zero.
  const runs: string[] = [];
  let current: string[] = [];
  values.forEach((v, i) => {
    if (v === null) {
      if (current.length) runs.push(current.join(" "));
      current = [];
    } else {
      current.push(`${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`);
    }
  });
  if (current.length) runs.push(current.join(" "));

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={`spark${hot ? " hot" : ""}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      {runs.map((points, i) => (
        <polyline
          key={i}
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}
