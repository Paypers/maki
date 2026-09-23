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
  | "upload" | "clock" | "trash" | "search" | "sparkle" | "trend"
  | "sun" | "partly" | "rain" | "snow" | "storm" | "fog";

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

  // Sky. Same cloud outline under every overcast variant so the set reads as
  // one family and the difference between them is only what falls out of it.
  sun:      "M12 16.5a4.5 4.5 0 100-9 4.5 4.5 0 000 9M12 2.5v2M12 19.5v2"
            + "M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2"
            + "M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4",
  partly:   "M16.5 8.2a4.2 4.2 0 10-7.8-2.4M7 19a4 4 0 01-.4-8A6 6 0 0118 11.4"
            + "A3.8 3.8 0 0117.4 19H7",
  rain:     "M7 15a4 4 0 01-.4-8A6 6 0 0118 7.4 3.8 3.8 0 0117.4 15H7"
            + "M8.5 18l-1 3M12.5 18l-1 3M16.5 18l-1 3",
  snow:     "M7 14a4 4 0 01-.4-8A6 6 0 0118 6.4 3.8 3.8 0 0117.4 14H7"
            + "M8 17.5v3M6.7 18.4l2.6 1.7M9.3 18.4l-2.6 1.7"
            + "M16 17.5v3M14.7 18.4l2.6 1.7M17.3 18.4l-2.6 1.7",
  storm:    "M7 14a4 4 0 01-.4-8A6 6 0 0118 6.4 3.8 3.8 0 0117.4 14H7"
            + "M13 14.8l-3 4h3.5l-2.5 4",
  fog:      "M7 12.5a4 4 0 01-.4-8A6 6 0 0118 4.9 3.8 3.8 0 0117.4 12.5H7"
            + "M4 16.5h16M6.5 20.5h11",
};

/**
 * The sky, as one glyph. Keyed on `describe()` from lib/weather so the icon
 * and the words on screen can never disagree with each other.
 */
export function skyIcon(sky: string): IconName {
  switch (sky) {
    case "snow":          return "snow";
    case "thunderstorms": return "storm";
    case "heavy rain":
    case "showers":
    case "rain":
    case "drizzle":       return "rain";
    case "fog":           return "fog";
    case "overcast":      return "cloud";
    case "partly cloudy": return "partly";
    default:              return "sun";
  }
}

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
