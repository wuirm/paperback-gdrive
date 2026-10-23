# Google Drive source for Paperback 0.9

A Paperback 0.9 extension that turns a Google Drive folder into a manga source. Point it at a folder, and every sub-folder becomes a series and every CBZ/ZIP inside becomes a chapter (or volume).

Pages are read **straight out of the CBZ on Drive** using small byte-range downloads: opening a chapter costs one or two tiny requests, and each page downloads only its own bytes. There's no server to run, and nothing has to be unzipped or re-uploaded.

```
Manga/                         ← the folder you point the extension at
├── One Piece/                 ← a series (folder name = title)
│   ├── cover.jpg              ← optional cover (cover/folder/poster.jpg|png|webp)
│   ├── details.json           ← optional metadata (see below)
│   ├── One Piece v01.cbz      ← one chapter per archive
│   └── One Piece v02.cbz
├── Berserk/
│   ├── Volume 1/              ← sub-folders are searched too (2 levels deep)
│   │   ├── c001.cbz
│   │   └── c002.cbz
│   └── Volume 2/
│       └── c010.5.cbz
└── Some Webcomic/
    ├── Chapter 1/             ← a folder of loose images also works as a chapter
    │   ├── 001.jpg
    │   └── 002.jpg
    └── Chapter 2/…
```

---

## 1. Set up Google access (pick one)

Both options start in the [Google Cloud Console](https://console.cloud.google.com/):

1. Create a project (any name, e.g. "Paperback").
2. Go to **APIs & Services → Library**, search for **Google Drive API** and click **Enable**.

### Option A: API key + link-shared folder (5 minutes)

Simplest. The trade-off is that anyone who has the folder link can view it.

1. **APIs & Services → Credentials → Create credentials → API key.**
2. Edit the key: under **API restrictions** choose *Restrict key* → **Google Drive API**. Leave *Application restrictions* on **None** (an iOS-app restriction would block Paperback).
3. In Google Drive, right-click your `Manga` folder → **Share** → *General access* → **Anyone with the link**, role **Viewer**. Copy the link.

Note: Google rate-limits downloads of publicly shared files that get a lot of traffic. Normal personal reading is fine, but if you ever see "download quota exceeded", switch to Option B.

### Option B: OAuth, private folder (15 minutes)

The folder stays private. You give the extension a long-lived *refresh token* for your own account, created with your own OAuth client.

1. **Google Auth Platform → Branding** (older consoles call this the **OAuth consent screen**): fill in an app name and your email. Choose **External** as the audience.
2. **Audience → Publish app** so the status reads **In production**.
   *This matters:* while an app is in **Testing**, Google expires its refresh tokens after 7 days. You don't need to submit for verification; for personal use you just click through the "Google hasn't verified this app" warning when you sign in.
3. **Clients → Create client → Web application.** Under *Authorized redirect URIs*, add
   `https://developers.google.com/oauthplayground`. Save, and copy the **Client ID** and **Client secret**.
4. Open the [OAuth 2.0 Playground](https://developers.google.com/oauthplayground):
   - Click the ⚙️ gear (top right) → tick **Use your own OAuth credentials** → paste the client ID and secret.
   - In *Step 1*, type the scope `https://www.googleapis.com/auth/drive.readonly` into the box and click **Authorize APIs**. Sign in, then accept the unverified-app warning (*Advanced → Go to …*).
   - In *Step 2*, click **Exchange authorization code for tokens** and copy the **Refresh token**.
5. Copy your `Manga` folder's link from Drive (the **Share → Copy link** link works; it doesn't need to be public).

`drive.readonly` means the extension can read your Drive but never modify it.

---

## 2. Host the extension

Paperback installs extensions from a *repository*, which is just a folder of static files on the web. The easiest free host is GitHub Pages, and the included workflow does the building for you, so you don't need Node installed.

1. Create a new GitHub repository (public, or private if your plan allows private Pages) and push this folder to its `main` branch.
2. In the repository: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. Go to the **Actions** tab and wait for *Bundle and deploy to GitHub Pages* to finish (re-run it if the first push happened before step 2).
4. Your repository URL is `https://<your-username>.github.io/<repo-name>/`.

The repository only contains code; your API key, tokens and folder link are entered in the app and stored on your phone.

**Testing locally instead:** with Node 24+, run `npm install && npm run serve`. It prints a LAN address (port 8080) that you can add in Paperback while your phone is on the same Wi-Fi.

## 3. Install in Paperback

1. On your iPhone, open `https://<your-username>.github.io/<repo-name>/` in Safari and tap **Add Repository to Paperback** (this opens the app and adds the repository).
2. In Paperback, install the **Google Drive** extension from that repository.
3. Open the extension's **settings**:
   - **Folder link or ID**: paste the `Manga` folder link.
   - **Method**: *API key* or *OAuth*, then fill in the matching fields.
   - Tap **Test connection**. It should say "Connected: N series found".
4. Browse the extension's Discover page or search it, and add series to your library as usual. New CBZs you drop into Drive show up when Paperback checks the series for updates.

---

## Library details

**Chapter numbers** come from the file name:

| File name | Volume | Chapter |
|---|---|---|
| `One Piece v01.cbz`, `Vol. 1.cbz`, `Volume 01.cbz` | 1 | 1 (volume number, so ordering works) |
| `c012.cbz`, `Ch. 12.cbz`, `Chapter 12 - Title.cbz`, `#12.cbz` | – | 12 |
| `Chainsaw Man - Vol. 2 Ch. 10.cbz` | 2 | 10 |
| `c010.5 [Group].cbz` | – | 10.5 (bracketed tags and `(2019)`-style years are ignored) |
| `Series Name 045.cbz` | – | 45 (last number, after removing the series name) |
| `Volume 3/c021.cbz` | 3 (from the folder) | 21 |

Chapters are ordered by natural sort of their path and name (`2` before `10`), so consistently named files always end up in the right order. Pages inside an archive are naturally sorted too; `__MACOSX` and hidden files are skipped.

**Covers**, in order of preference: an image named `cover`/`folder`/`poster`/`thumb`/`front` in the series folder, any other image in the series folder, then the first page (or an image called `cover` inside) of the first archive.

**Metadata** (all optional; folder name is the title otherwise):

- `details.json` in the series folder, the same format Mihon/Tachiyomi's local source uses:
  ```json
  {
    "title": "One Piece",
    "author": "Eiichiro Oda",
    "artist": "Eiichiro Oda",
    "description": "Pirates and treasure.",
    "genre": ["Action", "Adventure"],
    "status": "1"
  }
  ```
  Status codes: 0 unknown, 1 ongoing, 2 completed, 3 licensed, 4 publishing finished, 5 cancelled, 6 on hiatus.
- `ComicInfo.xml` next to the archives, or inside the first archive (Summary, Writer, Penciller, Genre, Tags, AgeRating, LanguageISO).
- The Drive folder's own **description** (Drive → folder → *File information → Details*) is used as the synopsis if nothing else provides one.

**Also supported:** Drive shortcuts (a shortcut to a series folder elsewhere counts as a series), shared drives, ZIP64 archives, stored and deflate-compressed CBZs, and series folders that are just loose images.

## Reading modes

Settings → *Reading* → **Use Paperback's built-in file reader**

- **Off (default, recommended):** the extension extracts each page itself. Works on every Paperback 0.9 build. Pages appear as soon as they're downloaded, and the reader can prefetch normally.
- **On:** the extension hands the whole file to Paperback's native reader (`type: "file"` chapters, added to the extension API in May 2026). This also lists **PDF** and **EPUB** files. It only works if your Paperback build supports file chapters, and it downloads the whole archive before showing anything.

## Limitations

- **CBR (RAR) and CB7 aren't supported.** Convert them to CBZ (for example with Calibre or `cbconvert`).
- Encrypted (password-protected) ZIPs aren't supported.
- "Recently Updated" uses the series folder's *modified* time in Drive, which doesn't always change when files are added to it.
- Covers are cached by the app. If you add or change a `cover.jpg` later, use **Clear caches** in the extension settings (and Paperback's own image cache if needed).

## Troubleshooting

| Message | Fix |
|---|---|
| `Google Drive error 404 … Check the folder link…` | Wrong link, or in API-key mode the folder isn't shared *Anyone with the link*. |
| `Google Drive error 403 … API key not valid` / `has not been used in project` | Key typo, or the Drive API isn't enabled in that Cloud project (enabling can take a minute to apply). |
| `Google Drive error 403 … requests from this iOS client application are blocked` | Remove the iOS application restriction from the API key. |
| `Google sign-in failed: … invalid_grant` | Refresh token revoked or expired. Check the consent screen is **In production**, then create a new refresh token in the Playground. |
| Chapter opens but pages are blank | The archive is probably a renamed RAR (CBR) file, or uses an unusual compression method. Re-save it as a normal ZIP/CBZ. |

You can stream the extension's log from your phone while reproducing a problem with `npx paperback-cli logcat --ip <phone-ip>` (see `npx paperback-cli logcat --help`).

---

## Development

Requires Node 24+ (and Python 3 for the test fixtures).

```sh
npm install
npm run tsc      # type-check
npm run bundle   # build into ./bundles
npm run serve    # serve ./bundles on your LAN for the app
npm test         # end-to-end test against a simulated Drive API
```

`npm test` builds a sample library (deflate/stored/ZIP64/unicode archives, nested folders, image folders, shortcuts, metadata files), then runs the *bundled* extension in a VM with the same globals as Paperback's JavaScriptCore runtime. A fake Drive API with Range support and a fake OAuth token endpoint stand in for Google, and every page is checked byte-for-byte.

| File | What it does |
|---|---|
| `src/GoogleDrive/main.ts` | Extension entry point: discover, search, details, chapters, and the request/response interceptors that add credentials and byte ranges and unpack pages. |
| `src/GoogleDrive/library.ts` | Maps folders to series/chapters/pages, finds covers and metadata, caches listings. |
| `src/GoogleDrive/zip.ts` | ZIP reader that works over HTTP ranges (EOCD, ZIP64, central directory, inflate via `fflate`). |
| `src/GoogleDrive/drive.ts` | Drive v3 REST client (paging, shortcuts, shared drives, errors). |
| `src/GoogleDrive/auth.ts` | API key header or OAuth refresh-token → access-token handling. |
| `src/GoogleDrive/settings.ts` | The settings screen. |
| `src/GoogleDrive/naming.ts` / `metadata.ts` | File-name parsing, natural sort, `details.json` / `ComicInfo.xml`. |

### How page loading works

1. `getChapterDetails` asks Drive for the file size, then downloads only the last 128 KB of the CBZ, which holds the ZIP's table of contents.
2. For each image it returns a page URL such as
   `https://www.googleapis.com/drive/v3/files/<id>?alt=media#pbzip=<start>-<end>-<method>-<sizes>`.
3. When Paperback loads that URL, `interceptRequest` adds your credentials and a `Range: bytes=<start>-<end>` header, so Drive returns just that page's bytes.
4. `interceptResponse` strips the small ZIP header, inflates the data if it was compressed, and hands Paperback a plain image.
