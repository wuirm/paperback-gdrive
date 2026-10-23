import {
  ContentRating,
  DiscoverSectionType,
  type Chapter,
  type ChapterDetails,
  type DiscoverSection,
  type DiscoverSectionItem,
  type ExtensionImpl,
  type Form,
  type Metadata,
  type PagedResults,
  type Request,
  type Response,
  type SearchQuery,
  type SearchResultItem,
  type SourceManga,
} from "@paperback/types";

import { AuthManager } from "./auth";
import { DriveClient, fileIdFromUrl, isDriveUrl, mediaUrl } from "./drive";
import { COVER_FRAGMENT, coverUrl, folderShareUrl, Library, type Series } from "./library";
import { nativeFormatOf, parseChapterName } from "./naming";
import type { SeriesMetadata } from "./metadata";
import { GoogleDriveSettingsForm } from "./settings";
import { Settings } from "./state";
import { decodeSpec, encodeSpec, extractEntry, toArrayBuffer } from "./zip";
import type pbconfig from "./pbconfig";

const PAGE_SIZE = 50;

type OffsetMetadata = { offset: number };

function fragmentOf(url: string): string | undefined {
  const i = url.indexOf("#");
  return i < 0 ? undefined : url.slice(i + 1);
}

function withoutFragment(url: string): string {
  const i = url.indexOf("#");
  return i < 0 ? url : url.slice(0, i);
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function toDate(iso: string | undefined): Date | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? undefined : d;
}

function page<T>(all: T[], metadata: OffsetMetadata | undefined): PagedResults<T> {
  const offset = metadata?.offset ?? 0;
  const items = all.slice(offset, offset + PAGE_SIZE);
  const next = offset + PAGE_SIZE;
  return { items, metadata: next < all.length ? { offset: next } : undefined };
}

export class GoogleDriveExtension implements ExtensionImpl<typeof pbconfig> {
  readonly auth = new AuthManager();
  readonly drive = new DriveClient(this.auth);
  readonly library = new Library(this.drive);

  async initialise(): Promise<void> {
    Application.registerInterceptor(
      "googleDriveInterceptor",
      Application.Selector(this as GoogleDriveExtension, "interceptRequest"),
      Application.Selector(this as GoogleDriveExtension, "interceptResponse"),
    );
  }

  // --- Settings --------------------------------------------------------------

  async getSettingsForm(): Promise<Form> {
    return new GoogleDriveSettingsForm(this.library);
  }

  // --- Discover --------------------------------------------------------------

  async getDiscoverSections(): Promise<DiscoverSection[]> {
    return [
      { id: "recent", title: "Recently Updated", type: DiscoverSectionType.prominentCarousel },
      { id: "all", title: "All Series", type: DiscoverSectionType.simpleCarousel },
    ];
  }

  async getDiscoverSectionItems(
    section: DiscoverSection,
    metadata: OffsetMetadata | undefined,
  ): Promise<PagedResults<DiscoverSectionItem>> {
    const series = await this.library.listSeries(section.id === "recent" ? "recent" : "name");
    const list = section.id === "recent" ? series.slice(0, 20) : series;
    const result = page(list, metadata);
    return {
      metadata: section.id === "recent" ? undefined : result.metadata,
      items: result.items.map((s) => ({
        type: section.id === "recent" ? "prominentCarouselItem" : "simpleCarouselItem",
        mangaId: s.id,
        title: s.name,
        imageUrl: coverUrl(s.id),
        contentRating: ContentRating.EVERYONE,
      })),
    };
  }

  // --- Search ----------------------------------------------------------------

  async getSearchResults(
    query: SearchQuery<Metadata>,
    metadata: OffsetMetadata | undefined,
  ): Promise<PagedResults<SearchResultItem>> {
    const needle = query.title.trim().toLowerCase();
    const all = await this.library.listSeries();
    const matches = needle ? all.filter((s) => s.name.toLowerCase().includes(needle)) : all;
    const result = page<Series>(matches, metadata);
    return {
      metadata: result.metadata,
      items: result.items.map((s) => ({
        mangaId: s.id,
        title: s.name,
        imageUrl: coverUrl(s.id),
        contentRating: ContentRating.EVERYONE,
      })),
    };
  }

  // --- Manga -----------------------------------------------------------------

  async getMangaDetails(mangaId: string): Promise<SourceManga> {
    const [folder, meta] = await Promise.all([
      this.drive.getFile(mangaId),
      this.library.getSeriesMetadata(mangaId).catch((): SeriesMetadata => ({})),
    ]);

    const primaryTitle = meta.title || folder.name;
    const altTitles = (meta.altTitles ?? []).filter((t) => t.toLowerCase() !== primaryTitle.toLowerCase());
    const genres = meta.genres ?? [];

    return {
      mangaId,
      mangaInfo: {
        primaryTitle,
        secondaryTitles: Array.from(new Set(altTitles)),
        thumbnailUrl: coverUrl(mangaId),
        synopsis: meta.synopsis || folder.description || "",
        author: meta.author,
        artist: meta.artist,
        status: meta.status,
        contentRating: meta.contentRating ?? ContentRating.EVERYONE,
        tagGroups: genres.length
          ? [{ id: "genres", title: "Genres", tags: genres.map((g) => ({ id: g.toLowerCase(), title: g })) }]
          : undefined,
        shareUrl: folderShareUrl(mangaId),
      },
    };
  }

  // --- Chapters --------------------------------------------------------------

  async getChapters(sourceManga: SourceManga): Promise<Chapter[]> {
    const [refs, meta] = await Promise.all([
      this.library.getChapterRefs(sourceManga.mangaId),
      this.library.getSeriesMetadata(sourceManga.mangaId).catch(() => undefined),
    ]);
    const langCode = meta?.language || Settings.langCode;
    const seriesName = sourceManga.mangaInfo?.primaryTitle;

    return refs.map((ref, index) => {
      const parsed = parseChapterName(ref.name, seriesName, ref.path);
      const chapter: Chapter = {
        chapterId: ref.chapterId,
        sourceManga,
        langCode,
        chapNum: parsed.chapter ?? parsed.volume ?? index + 1,
        volume: parsed.volume,
        title: ref.path ? `${ref.path} / ${parsed.title}` : parsed.title,
        publishDate: toDate(ref.createdTime ?? ref.modifiedTime),
        sortingIndex: index + 1,
        additionalInfo: { kind: ref.kind, format: ref.format ?? "" },
      };
      return chapter;
    });
  }

  async getChapterDetails(chapter: Chapter): Promise<ChapterDetails> {
    const id = chapter.chapterId;
    const base = { id, mangaId: chapter.sourceManga.mangaId };

    if (id.startsWith("d:")) {
      const folderId = id.slice(2);
      const pages = await this.library.getImageFolderPages(folderId, folderId === chapter.sourceManga.mangaId);
      if (pages.length === 0) throw new Error("This folder contains no images.");
      return { ...base, type: "images", pages };
    }

    const fileId = id.startsWith("f:") ? id.slice(2) : id;

    if (Settings.useNativeReader) {
      const file = await this.drive.getFile(fileId);
      const format = nativeFormatOf(file.name, file.mimeType) ?? "cbz";
      return {
        ...base,
        type: "file",
        format,
        request: { url: mediaUrl(fileId), method: "GET", headers: await this.auth.headers() },
      };
    }

    return { ...base, type: "images", pages: await this.library.getArchivePages(fileId) };
  }

  // --- Interceptors ----------------------------------------------------------
  // Every request to the Drive API (including page and cover images loaded by the
  // app) passes through here so we can add credentials and byte ranges.

  async interceptRequest(request: Request): Promise<Request> {
    if (!isDriveUrl(request.url)) return request;

    let url = request.url;
    const headers: Record<string, string> = { ...(request.headers ?? {}) };

    try {
      if (fragmentOf(url) === COVER_FRAGMENT) {
        const folderId = fileIdFromUrl(url);
        const cover = folderId ? await this.library.resolveCover(folderId) : undefined;
        if (cover) url = mediaUrl(cover.fileId) + (cover.spec ? `#${encodeSpec(cover.spec)}` : "");
      }

      const spec = decodeSpec(fragmentOf(url));
      if (spec && !hasHeader(headers, "Range")) headers["Range"] = `bytes=${spec.start}-${spec.end}`;

      if (!hasHeader(headers, "Authorization") && !hasHeader(headers, "X-Goog-Api-Key")) {
        Object.assign(headers, await this.auth.headers());
      }
    } catch (e) {
      console.log(`[GoogleDrive] interceptRequest: ${String(e)}`);
    }

    return { ...request, url, headers };
  }

  async interceptResponse(request: Request, response: Response, data: ArrayBuffer): Promise<ArrayBuffer> {
    if (!isDriveUrl(request.url) || response.status >= 400) return data;

    const fragment = fragmentOf(request.url);
    let spec = decodeSpec(fragment);
    if (!spec && fragment === COVER_FRAGMENT) {
      // In case the app hands us the original (un-rewritten) cover request.
      const folderId = fileIdFromUrl(withoutFragment(request.url));
      spec = folderId ? this.library.cachedCover(folderId)?.spec : undefined;
    }
    if (!spec) return data;

    try {
      return toArrayBuffer(extractEntry(new Uint8Array(data), spec));
    } catch (e) {
      console.log(`[GoogleDrive] could not extract page: ${String(e)}`);
      return data;
    }
  }
}

export const GoogleDrive = new GoogleDriveExtension();
