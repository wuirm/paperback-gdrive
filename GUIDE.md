# Setup guide

This guide walks you through reading manga from **your own Google Drive** in Paperback 0.9. You'll put CBZ files in a Drive folder, give the extension permission to read that folder, and browse it in Paperback like any other source.

- **Time:** about 10 minutes with an API key, or 20 minutes with private sign-in.
- **You need:** Paperback 0.9 on your iPhone or iPad, and a Google account. The Google Cloud steps are easiest on a computer, but a phone works too.
- **Cost:** free. The Google Drive API doesn't need billing turned on.

> This extension is unofficial. It isn't made by, or affiliated with, Google or the Paperback team.

## Contents

1. [Choose a sign-in method](#1-choose-a-sign-in-method)
2. [Put your manga in Drive](#2-put-your-manga-in-drive)
3. [Create a Google Cloud project](#3-create-a-google-cloud-project)
4. [Get your credentials](#4-get-your-credentials) ([API key](#option-a-api-key) or [private sign-in](#option-b-private-sign-in-oauth))
5. [Install and connect in Paperback](#5-install-and-connect-in-paperback)
6. [Naming, covers and metadata](#6-naming-covers-and-metadata)
7. [Troubleshooting](#7-troubleshooting)
8. [Keeping your account safe](#8-keeping-your-account-safe)

---

## 1. Choose a sign-in method

| | **API key** | **Private sign-in (OAuth)** |
|---|---|---|
| Setup time | About 5 minutes | About 15 minutes |
| Your manga folder | Shared as "Anyone with the link" | Stays private |
| What the extension can read | Only that shared folder | Your whole Drive (read-only) |
| If the credential leaked | Someone could read the shared folder, nothing else | Someone could read anything in your Drive |

**Pick the API key** if you don't mind the folder being viewable by anyone who has its link. The link is long and random, so nobody finds it by guessing. This method never touches the rest of your Google account.

**Pick private sign-in** if the folder must stay private. You can make it safer by keeping your manga in a separate Google account used only for this.

Neither method lets the extension change or delete anything in your Drive.

## 2. Put your manga in Drive

Create a folder (for example `Manga`) and put **one sub-folder per series** inside it, with that series' CBZ files in it:

```
Manga/                        ← the folder you connect
├── One Piece/                ← a series (folder name = title)
│   ├── cover.jpg             ← optional cover image
│   ├── One Piece v01.cbz     ← one chapter or volume per file
│   └── One Piece v02.cbz
├── Berserk/
│   ├── Volume 1/             ← sub-folders work too (up to two levels)
│   │   ├── c001.cbz
│   │   └── c002.cbz
│   └── Volume 2/
│       └── c010.5.cbz
└── Some Webcomic/
    ├── Chapter 1/            ← a folder of images also counts as a chapter
    │   ├── 001.jpg
    │   └── 002.jpg
    └── Chapter 2/…
```

- **CBZ and ZIP files work.** CBR (RAR) and CB7 files don't; convert them to CBZ first, for example with Calibre.
- Name files consistently so they sort in order. See [Naming, covers and metadata](#6-naming-covers-and-metadata) for what the extension understands.
- You can add more series and chapters at any time. They show up the next time Paperback refreshes.

## 3. Create a Google Cloud project

Both methods need a free Google Cloud project. It's where Google keeps track of the key or sign-in you're about to create.

1. Open [Create a project](https://console.cloud.google.com/projectcreate). If it's your first visit, accept the terms.
2. Give it any name (for example `Paperback`) and tap **Create**. Wait a few seconds for it to finish.
3. Open the [Google Drive API page](https://console.cloud.google.com/apis/library/drive.googleapis.com). At the top of the page, make sure your new project is selected, then tap **Enable**.

## 4. Get your credentials

Follow **one** of the two options below.

### Option A: API key

1. Open [Credentials](https://console.cloud.google.com/apis/credentials), tap **Create credentials**, then **API key**.
2. Restrict the key so it can only be used for Drive:
   - Open the key (tap its name in the list).
   - Under **API restrictions**, choose **Restrict key** and tick **Google Drive API**.
   - Leave **Application restrictions** set to **None**. An iOS-app restriction would block Paperback.
   - Tap **Save**, then copy the key. It starts with `AIza`.
3. Share your manga folder:
   - In Google Drive, open the folder's menu and choose **Share**.
   - Under **General access**, choose **Anyone with the link**, with the role **Viewer**.
   - Tap **Copy link**.

You now have **an API key** and **a folder link**. Go to [step 5](#5-install-and-connect-in-paperback).

> Google limits how often a publicly shared file can be downloaded. Normal personal reading is fine, but if you ever see "download quota exceeded", wait a while or switch to private sign-in.

### Option B: Private sign-in (OAuth)

You'll create your own sign-in screen, sign in once, and get a long-lived **refresh token** that the extension uses to read your folder.

**B1. Set up the sign-in screen**

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview) and tap **Get started**.
2. **App name:** anything, for example `My Paperback`. **User support email:** your email.
3. **Audience:**
   - Choose **External** if you use a normal Gmail account.
   - Choose **Internal** if your account is a work or school Google Workspace account and the option is offered.
4. **Contact information:** your email. Agree to the policy and tap **Create**.
5. **If you chose External:** open the [Audience page](https://console.cloud.google.com/auth/audience), tap **Publish app**, then confirm.
   - This matters. While the app is in "Testing", Google expires your sign-in every 7 days.
   - Google may say the app "needs verification". You can ignore that; verification is only for apps offered to the public.
   - Internal apps don't have a publishing step and don't expire.

**B2. Create a client**

1. Open [Clients](https://console.cloud.google.com/auth/clients) and tap **Create client**.
2. **Application type:** Web application. **Name:** anything.
3. Under **Authorized redirect URIs**, tap **Add URI** and enter exactly:
   ```
   https://developers.google.com/oauthplayground
   ```
4. Tap **Create**. Copy the **Client ID** and **Client secret** now and keep them somewhere private, such as a password manager. Google may only show the secret once.

**B3. Get your refresh token**

1. Open Google's [OAuth 2.0 Playground](https://developers.google.com/oauthplayground).
2. Tap the **gear icon** (top right). Tick **Use your own OAuth credentials** and paste your client ID and client secret. Close the panel.
   - Don't skip this. Without your own credentials, the Playground's tokens stop working after 24 hours.
3. In **Step 1**, find the box labelled **Input your own scopes**, enter the line below, and tap **Authorize APIs**:
   ```
   https://www.googleapis.com/auth/drive.readonly
   ```
4. Sign in with the Google account that has your manga.
   - If you see **"Google hasn't verified this app"**, tap **Advanced**, then **Go to (your app name)**. It's your own app, so this is expected.
   - Allow access when asked.
5. In **Step 2**, tap **Exchange authorization code for tokens**. Copy the **Refresh token** (it usually starts with `1//`).
6. In Google Drive, open your manga folder's **Share** menu and tap **Copy link**. The folder doesn't need to be shared with anyone; the link just identifies it.

You now have **a client ID, a client secret, a refresh token and a folder link**.

## 5. Install and connect in Paperback

1. On your iPhone or iPad, open **https://wuirm.github.io/paperback-gdrive/** in Safari and tap **Add Repository to Paperback**. Paperback opens and adds the repository.
2. Install the **Google Drive** extension from that repository. (You can also tick it on the same web page and tap **Install**.)
3. Open the Google Drive extension's **settings** in Paperback and fill in:
   - **Folder link or ID:** your folder link.
   - **Method:** **API key** or **OAuth**, matching the option you followed.
   - **API key mode:** paste your API key.
   - **OAuth mode:** paste your client ID, client secret and refresh token.
4. Tap **Test connection**. It should say **Connected: N series found**.
5. Open the extension to browse or search your library, and add series to your Paperback library as usual.

> **Moving long values to your phone:** use a password manager, or copy on your computer and paste on your phone with Apple's Universal Clipboard. Don't send them to yourself through a chat app, email or Discord.

## 6. Naming, covers and metadata

### Chapter and volume numbers

The extension reads numbers from file names:

| File name | Volume | Chapter |
|---|---|---|
| `One Piece v01.cbz`, `Vol. 1.cbz`, `Volume 01.cbz` | 1 | 1 (the volume number keeps them in order) |
| `c012.cbz`, `Ch. 12.cbz`, `Chapter 12 - Title.cbz`, `#12.cbz` | – | 12 |
| `Chainsaw Man - Vol. 2 Ch. 10.cbz` | 2 | 10 |
| `c010.5 [Group].cbz` | – | 10.5 (tags in `[brackets]` and years like `(2019)` are ignored) |
| `Series Name 045.cbz` | – | 45 (the last number, after the series name) |
| `Volume 3/c021.cbz` | 3 (from the folder name) | 21 |

Chapters are sorted "naturally", so `2` comes before `10`. Pages inside each file are sorted the same way. Hidden files and `__MACOSX` folders are skipped.

### Covers

The extension uses the first of these it finds:

1. An image in the series folder named `cover`, `folder`, `poster`, `thumb` or `front` (`.jpg`, `.png` or `.webp`).
2. Any other image in the series folder.
3. An image named `cover` inside the first CBZ, or otherwise its first page.

If you add or change a cover later, tap **Clear caches** in the extension's settings.

### Series details (optional)

Without extra files, the folder name is the title. To add an author, description, genres and status:

- **`details.json`** in the series folder (the same format the Mihon/Tachiyomi local source uses):
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
  Status: 0 unknown, 1 ongoing, 2 completed, 3 licensed, 4 publishing finished, 5 cancelled, 6 on hiatus.
- **`ComicInfo.xml`** next to the CBZ files, or inside the first CBZ. Many tagging tools write this automatically.
- The Drive folder's own **description** is used as the summary if nothing else provides one.

### Other things that work

- **Drive shortcuts:** a shortcut to a series folder stored elsewhere counts as a series.
- **Shared drives.**
- **PDF and EPUB files:** turn on **Use Paperback's built-in file reader** in the extension settings. This hands whole files to Paperback's own reader, if your Paperback build supports it, and downloads each file in full before showing it. Leave it off for the fastest CBZ reading.

## 7. Troubleshooting

Tap **Test connection** in the extension settings first. Most problems show a clear message there.

| You see | What to do |
|---|---|
| **Connected, but no series folders found** | The link should point to the folder that *contains* your series folders, not to a single series. Each series needs its own sub-folder. |
| **Google Drive error 404** | The folder link is wrong. In API key mode, also check the folder is shared as **Anyone with the link**. |
| **Google Drive error 403 … API key not valid** | Re-copy the key. Make sure the key's project is the one where you enabled the Drive API. |
| **Google Drive error 403 … has not been used in project / is disabled** | Enable the [Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) for your project, then wait a minute. |
| **Google Drive error 403 … iOS client application are blocked** | Set the API key's **Application restrictions** back to **None**. |
| **Google sign-in failed … The refresh token was revoked or expired** | Check the app is **published** (External) and that you ticked **Use your own OAuth credentials** in the Playground, then make a new token ([step B3](#option-b-private-sign-in-oauth)). |
| **Google sign-in failed: Unauthorized** (or *client was not found / was deleted*) | The client ID or secret is wrong, or the client was deleted. Re-copy them, or create a new client and token. |
| **redirect_uri_mismatch** (in the Playground) | Add `https://developers.google.com/oauthplayground` to the client's **Authorized redirect URIs** exactly as written, then try again. |
| **"Access blocked" or "admin policy" when signing in** (work/school account) | Your organisation's admin restricts third-party apps. Ask them to allow your app, or use a personal Google account. |
| **Download quota exceeded** | Google is rate-limiting a publicly shared file. Wait, or switch to private sign-in. |
| A chapter opens but pages are blank | The file is probably a CBR (RAR) renamed to `.cbz`, or is corrupt. Re-save it as a normal ZIP/CBZ. |
| A new cover or chapter doesn't appear | Tap **Clear caches** in the extension settings, then refresh the series in Paperback. |

## 8. Keeping your account safe

- **Treat your API key, client secret and refresh token like passwords.** Never post them in Discord, GitHub issues, screenshots or AI chats. Anyone asking for them to "help debug" doesn't need them.
- **What the extension can do:** read files, never change or delete them. Your credentials stay in Paperback on your device and are only sent to Google.
- **If a credential leaks**, replace it straight away:
  - **API key:** delete it on the [Credentials page](https://console.cloud.google.com/apis/credentials) and create a new one.
  - **Private sign-in:** delete the client on the [Clients page](https://console.cloud.google.com/auth/clients), which makes the old secret and refresh token useless at once. Then repeat [steps B2 and B3](#option-b-private-sign-in-oauth).
  - You can also remove the app's access at [Google account connections](https://myaccount.google.com/connections).
- **Losing a device:** do the same as for a leak.
- **Updates:** Paperback updates the extension automatically from this repository. If you'd rather review every change yourself, host your own copy; see "Host your own copy" in the [README](README.md).
