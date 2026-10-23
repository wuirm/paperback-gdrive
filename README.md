# Google Drive for Paperback

An unofficial [Paperback](https://paperback.moe) 0.9 extension that turns a folder in your own Google Drive into a manga source. Each sub-folder becomes a series, and each CBZ inside becomes a chapter or volume.

Pages are read **straight out of the CBZ on Drive** with small byte-range downloads, so chapters open quickly and nothing has to be unzipped or re-uploaded. There's no server to run: the extension runs inside Paperback and talks directly to Google.

> Not affiliated with Google or the Paperback team. It only reads files you put in your own Drive.

## Get started

1. On your iPhone or iPad, open **https://wuirm.github.io/paperback-gdrive/** in Safari and tap **Add Repository to Paperback**.
2. Install the **Google Drive** extension.
3. Follow the **[setup guide](GUIDE.md)** to connect your Drive. It takes about 10 minutes and walks through every step, including the Google Cloud part.

## Features

- One folder per series; CBZ/ZIP files as chapters; sub-folders (for volumes) up to two levels deep.
- Folders of loose images also work as chapters.
- Chapter and volume numbers read from file names (`v01`, `Ch. 12`, `c010.5 [Group]`, `Series 045` …), sorted naturally.
- Covers from `cover.jpg` or the first page; series details from `details.json` (Mihon/Tachiyomi format) or `ComicInfo.xml`.
- Search, "Recently Updated" and "All Series" sections.
- Drive shortcuts, shared drives and ZIP64 archives.
- Two ways to connect: an **API key** with a link-shared folder, or **private sign-in** (OAuth, read-only).
- Optional hand-off of whole CBZ/PDF/EPUB files to Paperback's built-in reader.

## Privacy and security

Your credentials are entered in Paperback, stored in its secure storage on your device, and sent only to Google. The extension can read your Drive but never change or delete anything. See [SECURITY.md](SECURITY.md) for the details, including how the CBZ reader defends against corrupt or hostile files.

## Host your own copy

Paperback updates the extension automatically from the address above. If you'd rather control updates yourself:

1. Fork this repository.
2. In your fork, open **Actions** and enable workflows. Then run **Release to GitHub Pages** (Run workflow).
3. Open **Settings → Pages** and choose **Deploy from a branch → `gh-pages` → (root)**.
4. Your copy is at `https://<your-username>.github.io/<repo-name>/`. Add that to Paperback instead.

## Development

Requires Node 24+ and Python 3 (for test fixtures).

```sh
npm install
npm run tsc      # type-check
npm run bundle   # build into ./bundles
npm run serve    # serve ./bundles on your LAN to test with the app (port 8080)
npm test         # full test suite
```

`npm test` builds a sample library (deflate/stored/ZIP64/unicode archives, nested folders, image folders, shortcuts, metadata files) and runs the **bundled** extension in a VM with the same globals as Paperback's JavaScriptCore runtime, against a simulated Drive API and OAuth endpoint. Every page is checked byte-for-byte. It then runs `test/adversarial.ts`, which feeds the CBZ reader hostile archives and checks each one is refused cleanly.

| File | What it does |
|---|---|
| `src/GoogleDrive/main.ts` | Entry point: discover, search, details, chapters, rate limiting, and the interceptors that add credentials and byte ranges and unpack pages. |
| `src/GoogleDrive/library.ts` | Maps folders to series, chapters and pages; finds covers and metadata; caches listings. |
| `src/GoogleDrive/zip.ts` | ZIP reader that works over HTTP ranges, with size and bounds checks. |
| `src/GoogleDrive/drive.ts` | Drive v3 REST client (paging, shortcuts, shared drives, errors). |
| `src/GoogleDrive/auth.ts` | API key header, or OAuth refresh token → access token. |
| `src/GoogleDrive/settings.ts` | The settings screen. |
| `src/GoogleDrive/naming.ts`, `metadata.ts` | File-name parsing, natural sort, `details.json` and `ComicInfo.xml`. |

### How page loading works

1. Opening a chapter reads only the last 128 KB of the CBZ, which holds the ZIP's table of contents.
2. Each page becomes a URL like `…/drive/v3/files/<id>?alt=media#pbzip=<start>-<end>-<method>-<sizes>`.
3. When Paperback loads it, the extension adds your credentials and a `Range` header, so Drive returns only that page's bytes.
4. The response is unpacked (and inflated if compressed) and handed to Paperback as a plain image.

### Releasing

Pushes to `main` run the tests but don't reach users. To publish a release:

1. Bump `version` in `src/GoogleDrive/pbconfig.ts` and commit.
2. Push a matching tag, for example `git tag v1.2.0 && git push origin v1.2.0`.

The **Release to GitHub Pages** workflow checks the tag matches the version, runs the tests, and publishes. Paperback then offers the update to everyone.

## License

[MIT](LICENSE)
