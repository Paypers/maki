/**
 * The icon set.
 *
 * These were Unicode glyphs -- the tab bar read as a row of mojibake, because
 * that is what a font stack does with an odd codepoint on a device that has no
 * glyph for it. Real SVG renders identically everywhere, scales, and takes
 * `currentColor` so an icon is never a colour decision.
 *
 * One geometry throughout: a 24-unit box, 1.75 stroke, round caps and joins,
 * no fills. Mixing stroke and solid icons is the fastest way to make a set look
 * assembled from three different places.
 */

export type IconName =
  | "check" | "calendar" | "list" | "chart" | "chevron" | "back"
  | "plus" | "minus" | "alert" | "cloud" | "settings" | "download"
  | "upload" | "clock" | "trash" | "search" | "sparkle" | "trend";

const PATHS: Record<IconName, string> = {
  check:    "M20 6.5L9 17.5l-5-5",
  calendar: "M4 8h16M8 3v3M16 3v3M5 5h14a1 1 0 011 1v13a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z",
  list:     "M4 7h16M4 12h16M4 17h10",
  chart:    "M5 20V11M12 20V5M19 20v-6",
  chevron:  "M9 5l7 7-7 7",
  back:     "M15 5l-7 7 7 7",
  plus:     "M12 6v12M6 12h12",
  minus:    "M6 12h12",
  alert:    "M12 4.5L2.8 20h18.4L12 4.5zM12 10v4M12 17.2v.1",
  cloud:    "M7 18a4 4 0 01-.4-8A6 6 0 0118 10.4 3.8 3.8 0 0117.4 18H7z",
  settings: "M5 7h14M5 12h14M5 17h14M9 5v4M16 10v4M11 15v4",
  download: "M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14",
  upload:   "M12 15V4M7.5 8.5L12 4l4.5 4.5M5 19h14",
  clock:    "M12 7v5l3 2M12 21a9 9 0 100-18 9 9 0 000 18z",
  trash:    "M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6",
  search:   "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  sparkle:  "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2 2-6z",
  trend:    "M4 15l5-5 4 4 7-7M15 7h5v5",
};

interface Props {
  name: IconName;
  /** Pixel size. 20 in dense rows, 24 in navigation, 18 inline with text. */
  size?: number;
  className?: string;
}

export function Icon({ name, size = 20, className }: Props) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorative by default: every icon in this app sits beside a text label,
      // so announcing it again is noise in a screen reader.
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
