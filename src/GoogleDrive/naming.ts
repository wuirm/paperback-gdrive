/** File-name helpers: natural sorting, file kinds and chapter/volume parsing. */

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function naturalCompare(a: string, b: string): number {
  return collator.compare(a, b);
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

export function stripExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? name : name.slice(0, dot);
}

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "avif", "bmp", "heic", "heif", "jxl"]);
const ARCHIVE_EXTENSIONS = new Set(["cbz", "zip"]);
const ARCHIVE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-cbz",
  "application/vnd.comicbook+zip",
]);

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

export function isImageFile(name: string, mimeType?: string): boolean {
  return isImageName(name) || (mimeType?.startsWith("image/") ?? false);
}

export function isArchiveFile(name: string, mimeType?: string): boolean {
  return ARCHIVE_EXTENSIONS.has(extensionOf(name)) || (mimeType !== undefined && ARCHIVE_MIME_TYPES.has(mimeType));
}

export type NativeFormat = "cbz" | "pdf" | "epub";

/** Formats Paperback can open itself when "built-in reader" mode is on. */
export function nativeFormatOf(name: string, mimeType?: string): NativeFormat | undefined {
  if (isArchiveFile(name, mimeType)) return "cbz";
  const ext = extensionOf(name);
  if (ext === "pdf" || mimeType === "application/pdf") return "pdf";
  if (ext === "epub" || mimeType === "application/epub+zip") return "epub";
  return undefined;
}

/** Skip macOS resource forks, hidden files and thumbnails inside archives. */
export function isJunkPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith(".") || part === "__MACOSX" || part === "Thumbs.db");
}

const COVER_NAMES = /^(cover|folder|poster|thumb|thumbnail|front)$/i;

export function isCoverName(name: string): boolean {
  return COVER_NAMES.test(stripExtension(name).trim());
}

export interface ParsedChapterName {
  chapter?: number;
  volume?: number;
  title: string;
}

const NUM = String.raw`(\d+(?:[.,]\d+)?)`;
const VOLUME_RE = new RegExp(String.raw`(?:^|[^a-z])(?:vol(?:ume)?\.?\s*|v)${NUM}`, "i");
const CHAPTER_RE = new RegExp(String.raw`(?:^|[^a-z])(?:ch(?:apter|ap)?\.?\s*|c|#|ep(?:isode)?\.?\s*|ch\s*)${NUM}`, "i");

function toNumber(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) ? n : undefined;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pull volume/chapter numbers out of names like
 *   "Berserk v01.cbz", "Chainsaw Man - Vol. 2 Ch. 10.cbz",
 *   "c012.5 [Group].cbz", "Series Name 045.cbz", "Volume 3/Chapter 21.cbz"
 */
export function parseChapterName(fileName: string, seriesName?: string, folderPath?: string): ParsedChapterName {
  const base = stripExtension(fileName).replace(/_/g, " ").trim();

  // Bracketed group/scanlator tags and years shouldn't be read as chapter numbers.
  const cleaned = base
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\((?:19|20)\d{2}\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  let haystack = cleaned;
  if (seriesName) {
    haystack = haystack.replace(new RegExp(`^${escapeRegExp(seriesName.trim())}`, "i"), " ").trim();
  }

  const volume = toNumber(VOLUME_RE.exec(haystack)?.[1]) ?? toNumber(folderPath ? VOLUME_RE.exec(folderPath)?.[1] : undefined);
  let chapter = toNumber(CHAPTER_RE.exec(haystack)?.[1]);

  if (chapter === undefined && volume === undefined) {
    // Fall back to the last free-standing number, e.g. "Series 045".
    const nums = haystack.replace(/\([^)]*\)/g, " ").match(/\d+(?:[.,]\d+)?/g);
    if (nums && nums.length > 0) chapter = toNumber(nums[nums.length - 1]);
  }

  return { chapter, volume, title: base };
}
