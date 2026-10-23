# Security notes

This is a personal, self-hosted Paperback source. It has no server of its own: the
extension runs inside Paperback on your phone and talks directly to Google Drive.
These notes record what it protects, what it trusts, and the hardening in place.

## What it protects

- **Your Google refresh token and client secret.** In OAuth mode these grant
  read-only access to your Drive. The extension stores them in Paperback's secure
  (Keychain-backed) state, never in plain settings state, and sends them only to
  `https://oauth2.googleapis.com` and `https://www.googleapis.com`. Credentials are
  attached as request headers, never placed in a URL or query string, and are only
  ever added to requests whose URL is on the Google Drive API host.
- **Your library.** The OAuth scope is `drive.readonly`, so even a full compromise
  of the token cannot modify or delete anything in your Drive.

## Trust boundaries

- **Google Drive and GitHub Pages are trusted hosts.** Transport is HTTPS only; the
  Pages site is served over HTTPS with HSTS.
- **File contents are untrusted.** CBZ/ZIP archives, `details.json` and
  `ComicInfo.xml` are parsed defensively — a corrupt download or a hostile archive
  from a third-party scanlation should fail cleanly, not crash the app or exhaust
  memory or bandwidth.

## Hardening in place

- **ZIP parser bounds.** Every size and offset read from an archive is range- and
  sanity-checked. A single entry is capped at 256 MB compressed *and* uncompressed
  (`MAX_ENTRY_BYTES`); larger entries are refused rather than allocated or fetched.
  This blocks three denial-of-service vectors: a lying `uncompressedSize` forcing a
  giant buffer allocation, a lying `compressedSize` forcing a multi-gigabyte range
  download, and a deflate bomb (the decompression output buffer is fixed-size, so
  fflate cannot expand past the declared, capped size).
- **Linear-time central-directory scan.** Computing per-entry byte ranges is O(n),
  so an archive with many entries at colliding offsets cannot cause a quadratic hang.
- **ZIP64 offsets validated** against the real file size before any read.
- **Bounded metadata reads.** `details.json` and `ComicInfo.xml` are read with a
  2 MB cap, so a mislabelled or oversized sidecar file cannot be pulled in whole.
- **URL-fragment specs are re-validated.** The page-location fragment the app hands
  back to the extension is bounds-checked again before use, so it cannot smuggle an
  oversized allocation past the parser.
- **No injection in Drive queries.** Folder IDs are restricted to
  `[A-Za-z0-9_-]` and quote-escaped before being placed in a Drive `q=` query.
- **Regexes are linear** (no catastrophic backtracking) on adversarial input.
- **Supply chain.** No runtime dependency but `fflate`. The build pins every GitHub
  Action to a commit SHA, installs with `npm ci --ignore-scripts`, and runs with
  `contents: write` as the only permission.

## Tests

`npm test` runs the end-to-end suite (a simulated Drive API, every page verified
byte-for-byte) and `test/adversarial.ts`, which feeds the ZIP reader hostile
archives (allocation bomb, bandwidth bomb, O(n²) central directory, truncation,
garbage streams) and asserts each is refused cleanly.

## Residual risk / your responsibilities

- Anyone who obtains your **setup code** or refresh token gets read-only access to
  your Drive. Treat the setup code like a password; don't paste it anywhere public.
- Keep the OAuth consent screen **In production** so tokens don't expire weekly, and
  revoke the client (or the token) in your Google Account if a device is lost.
- Prefer **OAuth mode** over API-key mode: an API key requires the folder to be
  shared "Anyone with the link", which is public to anyone who learns the link.
- GitHub cannot be made to forget old commits on its own; see the main chat for the
  one remaining step (delete/recreate the repo, or ask GitHub Support) if you need
  the pre-rename history gone entirely.
