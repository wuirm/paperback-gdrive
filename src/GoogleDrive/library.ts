/**
 * Maps the Drive folder layout onto series / chapters / pages.
 *
 *   <root>/
 *     <Series A>/            -> one series (folder ID = mangaId)
 *       cover.jpg            -> optional cover
 *       details.json         -> optional metadata (Mihon local-source format)
 *       Series A v01.cbz     -> one chapter per archive
 *       Volume 2/            -> sub-folders are searched (2 levels deep) for more archives,
 *         c010.cbz              or treated as a chapter of loose images
 */
import { mergeMetadata, parseComicInfo, parseDetailsJson, type SeriesMetadata } from "./metadata";
import {
  isArchiveFile,
  isCoverName,
  isImageFile,
  isImageName,
  isJunkPath,
  nativeFormatOf,
  naturalCompare,
  parseChapterName,
  type NativeFormat,
} from "./naming";
import { DRIVE_API, DriveClient, FOLDER_MIME, mediaUrl, type DriveFile } from "./drive";
import { Settings } from "./state";
import { decodeUtf8, encodeSpec, entrySpecs, extractEntry, readZipIndex, type EntrySpec, type ZipIndex } from "./zip";

const LIST_TTL = 2 * 60 * 1000;
const META_TTL = 10 * 60 * 1000;
const COVER_STATE_KEY = "coverCache";

export const COVER_FRAGMENT = "pbcover";

export interface Series {
  id: string;
  name: string;
  modifiedTime?: string;
  createdTime?: string;
}

export interface ChapterRef {
  /** `f:<fileId>` for a file, `d:<folderId>` for a folder of images. */
  chapterId: string;
  kind: "archive" | "images" | "native";
  driveId: string;
  name: string;
  path: string;
  format?: NativeFormat;
  createdTime?: string;
  modifiedTime?: string;
}

export interface CoverRef {
  fileId: string;
  spec?: EntrySpec;
}

class TtlCache<T> {
  private map = new Map<string, { at: number; value: Promise<T> }>();
  constructor(
    private ttl: number,
    private max = 200,
  ) {}

  get(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.map.get(key);
    if (hit && Date.now() - hit.at < this.ttl) return hit.value;
    const value = load();
    value.catch(() => this.map.delete(key));
    this.map.set(key, { at: Date.now(), value });
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.map.clear();
  }
}

export function coverUrl(folderId: string): string {
  return `${DRIVE_API}/files/${encodeURIComponent(folderId)}?alt=media&supportsAllDrives=true#${COVER_FRAGMENT}`;
}

export function folderShareUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

function isComicInfo(name: string): boolean {
  return /(^|\/)comicinfo\.xml$/i.test(name);
}

export class Library {
  private folders = new TtlCache<DriveFile[]>(LIST_TTL);
  private zipIndexes = new TtlCache<ZipIndex>(24 * 60 * 60 * 1000, 40);
  private metadata = new TtlCache<SeriesMetadata>(META_TTL);
  private covers = new Map<string, Promise<CoverRef | undefined>>();

  constructor(public readonly drive: DriveClient) {}

  clearCaches(): void {
    this.folders.clear();
    this.zipIndexes.clear();
    this.metadata.clear();
    this.covers.clear();
    this.writeCoverState({});
  }

  // --- Listing ---------------------------------------------------------------

  listFolder(folderId: string): Promise<DriveFile[]> {
    return this.folders.get(folderId, () => this.drive.listChildren(folderId));
  }

  async listSeries(order: "name" | "recent" = "name"): Promise<Series[]> {
    const root = Settings.rootFolderId;
    if (!root) throw new Error("No library folder set. Open the Google Drive extension settings and paste your folder link.");
    const children = await this.listFolder(root);
    const series = children
      .filter((f) => f.mimeType === FOLDER_MIME)
      .map((f) => ({ id: f.id, name: f.name, modifiedTime: f.modifiedTime, createdTime: f.createdTime }));
    if (order === "recent") {
      return series.sort((a, b) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
    }
    return series.sort((a, b) => naturalCompare(a.name, b.name));
  }

  // --- Chapters --------------------------------------------------------------

  async getChapterRefs(seriesFolderId: string): Promise<ChapterRef[]> {
    const native = Settings.useNativeReader;
    const refs: ChapterRef[] = [];

    const collect = async (folderId: string, path: string, depth: number): Promise<void> => {
      const children = await this.listFolder(folderId);
      let foundFiles = false;

      for (const f of children) {
        if (f.mimeType === FOLDER_MIME) continue;
        const format = native ? nativeFormatOf(f.name, f.mimeType) : isArchiveFile(f.name, f.mimeType) ? "cbz" : undefined;
        if (!format) continue;
        foundFiles = true;
        refs.push({
          chapterId: `f:${f.id}`,
          kind: native ? "native" : "archive",
          driveId: f.id,
          name: f.name,
          path,
          format,
          createdTime: f.createdTime,
          modifiedTime: f.modifiedTime,
        });
      }

      const images = children.filter((f) => f.mimeType !== FOLDER_MIME && isImageFile(f.name, f.mimeType));
      if (depth > 0 && !foundFiles && images.length > 0) {
        const newest = images.map((i) => i.modifiedTime ?? "").sort().pop();
        refs.push({
          chapterId: `d:${folderId}`,
          kind: "images",
          driveId: folderId,
          name: path.split("/").pop() ?? path,
          path: path.split("/").slice(0, -1).join("/"),
          modifiedTime: newest,
          createdTime: images[0]?.createdTime,
        });
      }

      if (depth < 2) {
        const subfolders = children.filter((f) => f.mimeType === FOLDER_MIME);
        await Promise.all(subfolders.map((s) => collect(s.id, path ? `${path}/${s.name}` : s.name, depth + 1)));
      }
    };

    await collect(seriesFolderId, "", 0);

    if (refs.length === 0) {
      // A series folder that is just loose images becomes a single chapter.
      const children = await this.listFolder(seriesFolderId);
      const images = children.filter((f) => isImageFile(f.name, f.mimeType) && !isCoverName(f.name));
      if (images.length > 0) {
        refs.push({ chapterId: `d:${seriesFolderId}`, kind: "images", driveId: seriesFolderId, name: "Chapter 1", path: "" });
      }
    }

    return refs.sort((a, b) => naturalCompare(`${a.path}/${a.name}`, `${b.path}/${b.name}`));
  }

  // --- Pages -----------------------------------------------------------------

  async getZipIndex(fileId: string): Promise<ZipIndex> {
    const file = await this.drive.getFile(fileId);
    if (file.size === undefined) throw new Error(`Cannot read "${file.name}": Drive did not report a file size.`);
    const key = `${fileId}:${file.modifiedTime ?? ""}:${file.size}`;
    return this.zipIndexes.get(key, () => readZipIndex(file.size!, (s, e) => this.drive.readRange(fileId, s, e)));
  }

  async getArchivePages(fileId: string): Promise<string[]> {
    const index = await this.getZipIndex(fileId);
    const specs = entrySpecs(index);
    const pages = index.entries
      .filter((e) => !e.isDirectory && isImageName(e.name) && !isJunkPath(e.name))
      .sort((a, b) => naturalCompare(a.name, b.name));
    if (pages.length === 0) throw new Error("This archive contains no images.");
    const base = mediaUrl(fileId);
    return pages.map((e) => `${base}#${encodeSpec(specs.get(e)!)}`);
  }

  async getImageFolderPages(folderId: string, excludeCovers: boolean): Promise<string[]> {
    const children = await this.listFolder(folderId);
    return children
      .filter((f) => isImageFile(f.name, f.mimeType) && !(excludeCovers && isCoverName(f.name)))
      .sort((a, b) => naturalCompare(a.name, b.name))
      .map((f) => mediaUrl(f.id));
  }

  // --- Covers ----------------------------------------------------------------

  // Stored as a JSON string so it round-trips through the app's state store unchanged.
  private readCoverState(): Record<string, { f: string; s?: EntrySpec }> {
    const v = Application.getState(COVER_STATE_KEY);
    if (typeof v !== "string" || !v) return {};
    try {
      return JSON.parse(v) as Record<string, { f: string; s?: EntrySpec }>;
    } catch {
      return {};
    }
  }

  private writeCoverState(state: Record<string, { f: string; s?: EntrySpec }>): void {
    Application.setState(JSON.stringify(state), COVER_STATE_KEY);
  }

  /** Synchronous lookup used by the response interceptor. */
  cachedCover(folderId: string): CoverRef | undefined {
    const c = this.readCoverState()[folderId];
    return c ? { fileId: c.f, spec: c.s } : undefined;
  }

  resolveCover(folderId: string): Promise<CoverRef | undefined> {
    const known = this.cachedCover(folderId);
    if (known) return Promise.resolve(known);

    let pending = this.covers.get(folderId);
    if (!pending) {
      pending = this.findCover(folderId).then((cover) => {
        if (cover) {
          const state = this.readCoverState();
          state[folderId] = { f: cover.fileId, s: cover.spec };
          this.writeCoverState(state);
        }
        return cover;
      });
      pending.catch(() => this.covers.delete(folderId));
      this.covers.set(folderId, pending);
    }
    return pending;
  }

  private async findCover(folderId: string): Promise<CoverRef | undefined> {
    const children = await this.listFolder(folderId);
    const images = children
      .filter((f) => f.mimeType !== FOLDER_MIME && isImageFile(f.name, f.mimeType))
      .sort((a, b) => naturalCompare(a.name, b.name));
    const named = images.find((f) => isCoverName(f.name));
    if (named) return { fileId: named.id };
    if (images[0]) return { fileId: images[0].id };

    for (const ref of await this.getChapterRefs(folderId)) {
      if (ref.kind === "images") {
        const pics = (await this.listFolder(ref.driveId))
          .filter((f) => isImageFile(f.name, f.mimeType))
          .sort((a, b) => naturalCompare(a.name, b.name));
        if (pics[0]) return { fileId: pics[0].id };
      } else if (ref.format === "cbz") {
        const index = await this.getZipIndex(ref.driveId);
        const specs = entrySpecs(index);
        const first = index.entries
          .filter((e) => !e.isDirectory && isImageName(e.name) && !isJunkPath(e.name))
          .sort((a, b) => {
            // Prefer an explicit cover inside the archive.
            const ca = isCoverName(a.name.split("/").pop() ?? "") ? 0 : 1;
            const cb = isCoverName(b.name.split("/").pop() ?? "") ? 0 : 1;
            return ca - cb || naturalCompare(a.name, b.name);
          })[0];
        if (first) return { fileId: ref.driveId, spec: specs.get(first) };
      }
    }
    return undefined;
  }

  // --- Metadata --------------------------------------------------------------

  getSeriesMetadata(folderId: string): Promise<SeriesMetadata> {
    return this.metadata.get(folderId, () => this.loadSeriesMetadata(folderId));
  }

  private async loadSeriesMetadata(folderId: string): Promise<SeriesMetadata> {
    const children = await this.listFolder(folderId);
    let meta: SeriesMetadata = {};

    const details = children.find((f) => /^details\.json$/i.test(f.name));
    if (details) {
      try {
        meta = parseDetailsJson(await this.drive.downloadText(details.id));
      } catch (e) {
        console.log(`[GoogleDrive] could not read details.json: ${String(e)}`);
      }
    }

    let comicInfoXml: string | undefined;
    const looseComicInfo = children.find((f) => /^comicinfo\.xml$/i.test(f.name));
    try {
      if (looseComicInfo) {
        comicInfoXml = await this.drive.downloadText(looseComicInfo.id);
      } else {
        const firstArchive = (await this.getChapterRefs(folderId)).find((r) => r.format === "cbz");
        if (firstArchive) {
          const index = await this.getZipIndex(firstArchive.driveId);
          const entry = index.entries.find((e) => isComicInfo(e.name) && !isJunkPath(e.name));
          if (entry) {
            const spec = entrySpecs(index).get(entry)!;
            const bytes = await this.drive.readRange(firstArchive.driveId, spec.start, spec.end);
            comicInfoXml = decodeUtf8(extractEntry(bytes, spec));
          }
        }
      }
    } catch (e) {
      console.log(`[GoogleDrive] could not read ComicInfo.xml: ${String(e)}`);
    }

    if (comicInfoXml) meta = mergeMetadata(meta, parseComicInfo(comicInfoXml));
    return meta;
  }
}
