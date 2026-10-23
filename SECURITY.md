# Security

This is an unofficial, self-hosted Paperback source with no server of its own. The
extension runs inside Paperback on your device and talks directly to Google Drive.
This page records what it protects, what it trusts, and the hardening in place.

## Reporting a vulnerability

Please don't post details in a public issue. Use **Report a vulnerability** on this
repository's **Security** tab so it can be fixed before it's disclosed.

## What it protects

- **Your Google credentials.** In API key mode, the key; in private sign-in mode, your
  client secret and refresh token. They're stored in Paperback's secure
  (Keychain-backed) storage, never in plain settings, and sent only to
  `https://oauth2.googleapis.com` and `https://www.googleapis.com`. They travel as
  request headers, never in a URL, and are only attached to requests for the Google
  Drive API host.
- **Your library.** The OAuth scope is `drive.readonly`, and an API key can only read
  link-shared files, so even a stolen credential can't modify or delete anything.

## Trust boundaries

- **Google and GitHub Pages are trusted hosts.** Transport is HTTPS only; the Pages
  site is served with HSTS.
- **File contents are untrusted.** CBZ/ZIP archives, `details.json` and
  `ComicInfo.xml` are parsed defensively. A corrupt download or a hostile archive
  should fail cleanly, not crash the app or exhaust memory or bandwidth.
- **Updates come from this repository.** Installed copies auto-update from the
  published site. If you'd rather review every change, host your own copy (see the
  README).

## Hardening in place

- **ZIP parser bounds.** Every size and offset read from an archive is range- and
  sanity-checked. A single entry is capped at 256 MB compressed *and* uncompressed
  (`MAX_ENTRY_BYTES`); larger entries are refused rather than allocated or fetched.
  This blocks a lying `uncompressedSize` forcing a giant allocation, a lying
  `compressedSize` forcing a multi-gigabyte range download, and deflate bombs (the
  output buffer is fixed-size, so decompression can't expand past the capped size).
- **Linear-time central-directory scan**, so an archive with many entries at
  colliding offsets can't cause a quadratic hang.
- **ZIP64 and central-directory offsets** are validated against the real file size
  before any read.
- **Bounded metadata reads.** `details.json` and `ComicInfo.xml` are read with a 2 MB
  cap.
- **Re-validated page specs.** The page-location fragment the app hands back to the
  extension is bounds-checked again before use.
- **No query injection.** Folder IDs are restricted to `[A-Za-z0-9_-]` and
  quote-escaped before going into a Drive `q=` query.
- **Linear regexes** (no catastrophic backtracking) on adversarial file names.
- **Rate limiting.** Requests are capped at 20 per second, well under Google's
  per-user quota.
- **Supply chain.** The only runtime dependency is `fflate`. Every GitHub Action is
  pinned to a commit SHA; installs use `npm ci --ignore-scripts`; the test workflow
  is read-only; and publishing happens only from a version tag, after the full test
  suite passes.

## Tests

`npm test` runs the end-to-end suite (a simulated Drive API, every page verified
byte-for-byte) and `test/adversarial.ts`, which feeds the ZIP reader hostile
archives (allocation bomb, bandwidth bomb, quadratic central directory, truncation,
garbage streams) and checks each is refused cleanly.

## Your part

- Treat your API key, client secret and refresh token like passwords. Never paste
  them into chats, issues or screenshots.
- If one leaks or a device is lost, replace it: delete the API key, or delete the
  OAuth client (which instantly invalidates its secret and refresh tokens), then set
  up again. You can also remove access at https://myaccount.google.com/connections.
- In private sign-in mode the extension can read your whole Drive. A separate Google
  account used only for manga limits what a leak could expose. API key mode never
  touches the rest of your account.
- See the [setup guide](GUIDE.md#8-keeping-your-account-safe) for step-by-step links.
