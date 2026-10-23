/** Thin Google Drive v3 REST client built on Application.scheduleRequest. */
import type { Request, Response } from "@paperback/types";
import { AuthManager } from "./auth";

export const DRIVE_API = "https://www.googleapis.com/drive/v3";
export const FOLDER_MIME = "application/vnd.google-apps.folder";
const SHORTCUT_MIME = "application/vnd.google-apps.shortcut";

const LIST_FIELDS =
  "nextPageToken,files(id,name,mimeType,size,modifiedTime,createdTime,shortcutDetails(targetId,targetMimeType))";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: number;
  modifiedTime?: string;
  createdTime?: string;
  description?: string;
}

interface RawDriveFile {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  modifiedTime?: string;
  createdTime?: string;
  description?: string;
  shortcutDetails?: { targetId?: string; targetMimeType?: string };
}

export class DriveError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

export function mediaUrl(fileId: string): string {
  return `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;
}

export function isDriveUrl(url: string): boolean {
  return url.startsWith(`${DRIVE_API}/`);
}

/** Extracts the file ID from a `${DRIVE_API}/files/<id>...` URL. */
export function fileIdFromUrl(url: string): string | undefined {
  const m = /\/drive\/v3\/files\/([^/?#]+)/.exec(url);
  return m?.[1] ? decodeURIComponent(m[1]) : undefined;
}

function normalise(raw: RawDriveFile): DriveFile {
  const isShortcut = raw.mimeType === SHORTCUT_MIME && raw.shortcutDetails?.targetId;
  return {
    id: isShortcut ? raw.shortcutDetails!.targetId! : raw.id,
    name: raw.name,
    mimeType: isShortcut ? (raw.shortcutDetails!.targetMimeType ?? raw.mimeType) : raw.mimeType,
    size: raw.size !== undefined ? Number(raw.size) : undefined,
    modifiedTime: raw.modifiedTime,
    createdTime: raw.createdTime,
    description: raw.description,
  };
}

function describeError(status: number, body: ArrayBuffer): string {
  let message = "";
  try {
    const json = JSON.parse(Application.arrayBufferToUTF8String(body)) as {
      error?: { message?: string; errors?: { reason?: string }[] };
    };
    message = json.error?.message ?? "";
    const reason = json.error?.errors?.[0]?.reason;
    if (reason === "notFound" || status === 404) {
      message += " Check the folder link, and that it is shared with 'Anyone with the link' (API key mode) or with your account (OAuth mode).";
    }
    if (reason === "downloadQuotaExceeded") {
      message += " Google limits how often publicly shared files can be downloaded; try again later or switch to OAuth mode.";
    }
  } catch {
    /* not JSON */
  }
  return `Google Drive error ${status}${message ? `: ${message.trim()}` : ""}`;
}

export class DriveClient {
  constructor(public readonly auth: AuthManager) {}

  async send(request: Request, allowRetry = true): Promise<[Response, ArrayBuffer]> {
    const authHeaders = await this.auth.headers();
    const [response, data] = await Application.scheduleRequest({
      ...request,
      headers: { ...authHeaders, ...(request.headers ?? {}) },
    });
    if (response.status === 401 && allowRetry) {
      this.auth.invalidate(authHeaders["Authorization"] ?? "");
      return this.send(request, false);
    }
    if (response.status >= 400) {
      throw new DriveError(describeError(response.status, data), response.status);
    }
    return [response, data];
  }

  private async getJson<T>(url: string): Promise<T> {
    const [, data] = await this.send({ url, method: "GET" });
    return JSON.parse(Application.arrayBufferToUTF8String(data)) as T;
  }

  async listChildren(
    folderId: string,
    options: { foldersOnly?: boolean; orderBy?: string } = {},
  ): Promise<DriveFile[]> {
    let q = `'${folderId.replace(/'/g, "\\'")}' in parents and trashed = false`;
    if (options.foldersOnly) {
      q += ` and (mimeType = '${FOLDER_MIME}' or mimeType = '${SHORTCUT_MIME}')`;
    }
    const files: DriveFile[] = [];
    let pageToken: string | undefined;
    do {
      const url =
        `${DRIVE_API}/files?q=${encodeURIComponent(q)}` +
        `&fields=${encodeURIComponent(LIST_FIELDS)}` +
        `&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true` +
        (options.orderBy ? `&orderBy=${encodeURIComponent(options.orderBy)}` : "") +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const page = await this.getJson<{ files?: RawDriveFile[]; nextPageToken?: string }>(url);
      for (const f of page.files ?? []) {
        const n = normalise(f);
        if (options.foldersOnly && n.mimeType !== FOLDER_MIME) continue;
        files.push(n);
      }
      pageToken = page.nextPageToken;
    } while (pageToken);
    return files;
  }

  async getFile(fileId: string): Promise<DriveFile> {
    const url =
      `${DRIVE_API}/files/${encodeURIComponent(fileId)}` +
      `?fields=${encodeURIComponent("id,name,mimeType,size,modifiedTime,createdTime,description")}` +
      `&supportsAllDrives=true`;
    return normalise(await this.getJson<RawDriveFile>(url));
  }

  async readRange(fileId: string, start: number, endInclusive: number): Promise<Uint8Array> {
    const [response, data] = await this.send({
      url: mediaUrl(fileId),
      method: "GET",
      headers: { Range: `bytes=${start}-${endInclusive}` },
    });
    const bytes = new Uint8Array(data);
    // If the server ignored the Range header we got the whole file.
    if (response.status === 200 && bytes.length > endInclusive - start + 1) {
      return bytes.subarray(start, endInclusive + 1);
    }
    return bytes;
  }

  async download(fileId: string): Promise<ArrayBuffer> {
    const [, data] = await this.send({ url: mediaUrl(fileId), method: "GET" });
    return data;
  }
}
