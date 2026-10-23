/** Persisted settings. Secrets live in secure state (Keychain-backed in the app). */

export type AuthMode = "apiKey" | "oauth";

const K = {
  rootInput: "rootFolderInput",
  authMode: "authMode",
  apiKey: "apiKey",
  clientId: "oauthClientId",
  clientSecret: "oauthClientSecret",
  refreshToken: "oauthRefreshToken",
  nativeReader: "useNativeReader",
  langCode: "defaultLangCode",
} as const;

function getString(key: string, secure = false): string {
  const v = secure ? Application.getSecureState(key) : Application.getState(key);
  return typeof v === "string" ? v : "";
}

function setString(key: string, value: string, secure = false): void {
  const v = value.trim();
  if (secure) Application.setSecureState(v, key);
  else Application.setState(v, key);
}

/** Accepts a raw folder ID or any drive.google.com folder link. */
export function parseFolderId(input: string): string {
  const s = input.trim();
  if (!s) return "";
  const folders = /\/folders\/([A-Za-z0-9_-]{10,})/.exec(s);
  if (folders?.[1]) return folders[1];
  const idParam = /[?&]id=([A-Za-z0-9_-]{10,})/.exec(s);
  if (idParam?.[1]) return idParam[1];
  if (/^[A-Za-z0-9_-]{10,}$/.test(s)) return s;
  return "";
}

export const Settings = {
  get rootFolderInput(): string {
    return getString(K.rootInput);
  },
  set rootFolderInput(v: string) {
    setString(K.rootInput, v);
  },
  get rootFolderId(): string {
    return parseFolderId(getString(K.rootInput));
  },

  get authMode(): AuthMode {
    return getString(K.authMode) === "oauth" ? "oauth" : "apiKey";
  },
  set authMode(v: AuthMode) {
    setString(K.authMode, v);
  },

  get apiKey(): string {
    return getString(K.apiKey, true);
  },
  set apiKey(v: string) {
    setString(K.apiKey, v, true);
  },

  get clientId(): string {
    return getString(K.clientId);
  },
  set clientId(v: string) {
    setString(K.clientId, v);
  },

  get clientSecret(): string {
    return getString(K.clientSecret, true);
  },
  set clientSecret(v: string) {
    setString(K.clientSecret, v, true);
  },

  get refreshToken(): string {
    return getString(K.refreshToken, true);
  },
  set refreshToken(v: string) {
    setString(K.refreshToken, v, true);
  },

  get useNativeReader(): boolean {
    return Application.getState(K.nativeReader) === true;
  },
  set useNativeReader(v: boolean) {
    Application.setState(v, K.nativeReader);
  },

  get langCode(): string {
    return getString(K.langCode) || "en";
  },
  set langCode(v: string) {
    setString(K.langCode, v);
  },
};

/**
 * A "setup code" bundles the folder and OAuth credentials into one string so they can be
 * pasted into Paperback in one go: base64url(JSON {v:1, f: folderId, ci, cs, rt}).
 * Returns false if the text isn't a valid setup code.
 */
export function applySetupCode(text: string): boolean {
  const raw = text.trim().replace(/^pbgd1[:.]/i, "");
  if (raw.length < 40 || !/^[A-Za-z0-9_-]+={0,2}$/.test(raw)) return false;
  let b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  let json: { v?: number; f?: string; ci?: string; cs?: string; rt?: string };
  try {
    const decoded = Application.base64Decode(b64);
    json = JSON.parse(typeof decoded === "string" ? decoded : Application.arrayBufferToUTF8String(decoded));
  } catch {
    return false;
  }
  if (json.v !== 1 || !json.ci || !json.cs || !json.rt) return false;
  if (json.f) Settings.rootFolderInput = `https://drive.google.com/drive/folders/${json.f}`;
  Settings.authMode = "oauth";
  Settings.clientId = json.ci;
  Settings.clientSecret = json.cs;
  Settings.refreshToken = json.rt;
  return true;
}
