/**
 * Optional series metadata, read from (in priority order):
 *   - details.json in the series folder (same format as Mihon/Tachiyomi's local source)
 *   - ComicInfo.xml in the series folder
 *   - ComicInfo.xml inside the first archive
 *   - the Drive folder's own "description" field (synopsis only)
 */
import { ContentRating } from "@paperback/types";

export interface SeriesMetadata {
  title?: string;
  altTitles?: string[];
  author?: string;
  artist?: string;
  synopsis?: string;
  status?: string;
  genres?: string[];
  contentRating?: ContentRating;
  language?: string;
}

const MIHON_STATUS: Record<string, string> = {
  "0": "Unknown",
  "1": "Ongoing",
  "2": "Completed",
  "3": "Licensed",
  "4": "Publishing finished",
  "5": "Cancelled",
  "6": "On hiatus",
};

function str(v: unknown): string | undefined {
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return undefined;
}

export function parseDetailsJson(text: string): SeriesMetadata {
  const json = JSON.parse(text) as Record<string, unknown>;
  const genreRaw = json["genre"] ?? json["genres"] ?? json["tags"];
  const genres = Array.isArray(genreRaw)
    ? genreRaw.map(str).filter((g): g is string => !!g)
    : typeof genreRaw === "string"
      ? genreRaw.split(",").map((g) => g.trim()).filter(Boolean)
      : undefined;
  const status = str(json["status"]);
  return {
    title: str(json["title"]),
    author: str(json["author"]),
    artist: str(json["artist"]),
    synopsis: str(json["description"]) ?? str(json["summary"]),
    status: status ? (MIHON_STATUS[status] ?? status) : undefined,
    genres,
  };
}

function decodeEntities(s: string): string {
  try {
    return Application.decodeHTMLEntities(s);
  } catch {
    return s
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, "&");
  }
}

function xmlTag(xml: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i").exec(xml);
  if (!m || m[1] === undefined) return undefined;
  const v = decodeEntities(m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
  return v || undefined;
}

function splitList(v: string | undefined): string[] {
  return v ? v.split(/[,;]/).map((s) => s.trim()).filter(Boolean) : [];
}

export function parseComicInfo(xml: string): SeriesMetadata {
  const ageRating = (xmlTag(xml, "AgeRating") ?? "").toLowerCase();
  let contentRating: ContentRating | undefined;
  if (/adults only|x18|r18|18\+/.test(ageRating)) contentRating = ContentRating.ADULT;
  else if (/mature|^m$|17\+|ma15|15\+/.test(ageRating)) contentRating = ContentRating.MATURE;
  else if (ageRating) contentRating = ContentRating.EVERYONE;

  const series = xmlTag(xml, "Series");
  const localized = xmlTag(xml, "LocalizedSeries");
  const writer = xmlTag(xml, "Writer");
  const penciller = xmlTag(xml, "Penciller") ?? xmlTag(xml, "Inker");
  const genres = [...splitList(xmlTag(xml, "Genre")), ...splitList(xmlTag(xml, "Tags"))];

  // The Drive folder name stays the primary title; ComicInfo's series name is only an alias.
  const altTitles = [series, localized].filter((t): t is string => !!t);
  return {
    altTitles: altTitles.length ? altTitles : undefined,
    author: writer,
    artist: penciller,
    synopsis: xmlTag(xml, "Summary"),
    genres: genres.length ? Array.from(new Set(genres)) : undefined,
    contentRating,
    language: xmlTag(xml, "LanguageISO"),
  };
}

/** Fill gaps in `primary` with values from `fallback`. */
export function mergeMetadata(primary: SeriesMetadata, fallback: SeriesMetadata): SeriesMetadata {
  const out: SeriesMetadata = { ...fallback };
  for (const [k, v] of Object.entries(primary)) {
    if (v !== undefined && !(Array.isArray(v) && v.length === 0)) {
      (out as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
