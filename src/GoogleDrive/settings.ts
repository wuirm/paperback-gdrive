import { ButtonRow, Form, InputRow, LabelRow, Section, SelectRow, ToggleRow, type FormSectionElement } from "@paperback/types";
import type { Library } from "./library";
import { applySetupCode, parseFolderId, Settings, type AuthMode } from "./state";

export class GoogleDriveSettingsForm extends Form {
  private status: { text: string; style?: "success" | "error" | "warning" } | undefined;
  private testing = false;

  constructor(private library: Library) {
    super();
  }

  override getSections(): FormSectionElement<unknown>[] {
    const mode = Settings.authMode;
    const folderInput = Settings.rootFolderInput;
    const folderOk = !folderInput || !!parseFolderId(folderInput);

    return [
      Section(
        {
          id: "setup",
          header: "Quick setup",
          footer: "Have a setup code? Paste it here to fill in the folder and sign-in details below in one go.",
        },
        [
          InputRow("setupCode", {
            title: "Setup code",
            value: "",
            isSecureEntry: true,
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setSetupCode"),
          }),
        ],
      ),
      Section(
        {
          id: "library",
          header: "Library",
          footer:
            "Paste the link to the Drive folder that holds one sub-folder per series. The extension reads CBZ/ZIP files inside each series folder (and up to two levels of sub-folders).",
        },
        [
          InputRow("rootFolder", {
            title: "Folder link or ID",
            value: folderInput,
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setRootFolder"),
          }),
          folderOk
            ? undefined
            : LabelRow("rootFolderInvalid", {
                title: "That doesn't look like a Drive folder link",
                value: { symbol: "exclamationmark.triangle", style: "warning" },
              }),
        ],
      ),
      Section(
        {
          id: "auth",
          header: "Access",
          footer:
            mode === "apiKey"
              ? "API key mode: share the library folder as 'Anyone with the link' (Viewer). Create a key in Google Cloud Console with the Drive API enabled."
              : "OAuth mode: the folder can stay private. Use the client ID/secret of your own OAuth client and a refresh token with the drive.readonly scope (see the README).",
        },
        [
          SelectRow("authMode", {
            title: "Method",
            subtitle: mode === "apiKey" ? "API key (link-shared folder)" : "OAuth (private folder)",
            value: [mode],
            minItemCount: 1,
            maxItemCount: 1,
            layout: "list",
            items: [
              { id: "apiKey", title: "API key (link-shared folder)" },
              { id: "oauth", title: "OAuth (private folder)" },
            ],
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setAuthMode"),
          }),
          InputRow("apiKey", {
            title: "API key",
            value: Settings.apiKey,
            isSecureEntry: true,
            isHidden: mode !== "apiKey",
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setApiKey"),
          }),
          InputRow("clientId", {
            title: "Client ID",
            value: Settings.clientId,
            isHidden: mode !== "oauth",
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setClientId"),
          }),
          InputRow("clientSecret", {
            title: "Client secret",
            value: Settings.clientSecret,
            isSecureEntry: true,
            isHidden: mode !== "oauth",
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setClientSecret"),
          }),
          InputRow("refreshToken", {
            title: "Refresh token",
            value: Settings.refreshToken,
            isSecureEntry: true,
            isHidden: mode !== "oauth",
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setRefreshToken"),
          }),
        ],
      ),
      Section(
        {
          id: "connection",
          footer: "Checks the folder and credentials and counts the series it can see.",
        },
        [
          ButtonRow("test", {
            title: this.testing ? "Testing…" : "Test connection",
            onSelect: Application.Selector(this as GoogleDriveSettingsForm, "testConnection"),
          }),
          this.status
            ? LabelRow("status", {
                title: this.status.text,
                value: {
                  symbol: this.status.style === "success" ? "checkmark.circle" : "xmark.octagon",
                  style: this.status.style ?? "error",
                },
              })
            : undefined,
        ],
      ),
      Section(
        {
          id: "reading",
          header: "Reading",
          footer:
            "Off (recommended): the extension pulls each page out of the CBZ with small ranged downloads, so chapters open instantly. On: hand the whole file to Paperback's own CBZ/PDF/EPUB reader, if your Paperback build supports it; this also lists PDF and EPUB files.",
        },
        [
          ToggleRow("nativeReader", {
            title: "Use Paperback's built-in file reader",
            value: Settings.useNativeReader,
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setNativeReader"),
          }),
          InputRow("langCode", {
            title: "Default language code",
            value: Settings.langCode,
            onValueChange: Application.Selector(this as GoogleDriveSettingsForm, "setLangCode"),
          }),
        ],
      ),
      Section(
        { id: "maintenance", footer: "Clears cached folder listings, archive indexes and covers." },
        [
          ButtonRow("clearCache", {
            title: "Clear caches",
            onSelect: Application.Selector(this as GoogleDriveSettingsForm, "clearCaches"),
          }),
        ],
      ),
    ];
  }

  private changed(): void {
    this.library.clearCaches();
    this.library.drive.auth.invalidate();
    this.status = undefined;
  }

  async setSetupCode(value: string): Promise<void> {
    if (!value.trim()) return;
    if (applySetupCode(value)) {
      this.changed();
      this.status = { text: "Setup code applied. Tap Test connection.", style: "success" };
    } else {
      this.status = { text: "That setup code isn't valid. Copy the whole code and try again.", style: "error" };
    }
    this.reloadForm();
  }

  async setRootFolder(value: string): Promise<void> {
    const wasValid = !!parseFolderId(Settings.rootFolderInput) || !Settings.rootFolderInput;
    Settings.rootFolderInput = value;
    this.changed();
    const isValid = !!parseFolderId(value) || !value;
    if (wasValid !== isValid) this.reloadForm();
  }

  async setAuthMode(value: string[]): Promise<void> {
    Settings.authMode = (value[0] as AuthMode) ?? "apiKey";
    this.changed();
    this.reloadForm();
  }

  async setApiKey(value: string): Promise<void> {
    Settings.apiKey = value;
    this.changed();
  }

  async setClientId(value: string): Promise<void> {
    Settings.clientId = value;
    this.changed();
  }

  async setClientSecret(value: string): Promise<void> {
    Settings.clientSecret = value;
    this.changed();
  }

  async setRefreshToken(value: string): Promise<void> {
    Settings.refreshToken = value;
    this.changed();
  }

  async setNativeReader(value: boolean): Promise<void> {
    Settings.useNativeReader = value;
    this.library.clearCaches();
  }

  async setLangCode(value: string): Promise<void> {
    Settings.langCode = value;
  }

  async clearCaches(): Promise<void> {
    this.library.clearCaches();
    this.status = { text: "Caches cleared", style: "success" };
    this.reloadForm();
  }

  async testConnection(): Promise<void> {
    this.testing = true;
    this.status = undefined;
    this.reloadForm();
    try {
      this.library.clearCaches();
      const series = await this.library.listSeries();
      this.status = {
        text: series.length === 0 ? "Connected, but no series folders found" : `Connected: ${series.length} series found`,
        style: series.length === 0 ? "warning" : "success",
      };
    } catch (e) {
      this.status = { text: e instanceof Error ? e.message : String(e), style: "error" };
    } finally {
      this.testing = false;
      this.reloadForm();
    }
  }
}
