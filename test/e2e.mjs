// End-to-end test: runs the *bundled* extension inside a JavaScriptCore-like VM
// (the same globals Paperback exposes) against an in-process fake of the Google
// Drive v3 API + OAuth token endpoint, and verifies every page byte-for-byte.
//
//   python3 test/make_fixtures.py && npm run bundle && npm run test:e2e
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ApplicationPolyfill } from "@paperback/runtime-polyfills";

const ROOT = path.resolve(import.meta.dirname, "..");
const LIB = path.join(ROOT, "test/.fixtures/library");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "test/.fixtures/manifest.json"), "utf8"));
const ROOT_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz012345";

// ---------------------------------------------------------------- fake Drive
const FOLDER = "application/vnd.google-apps.folder";
const SHORTCUT = "application/vnd.google-apps.shortcut";
const MIME = { jpg: "image/jpeg", png: "image/png", pdf: "application/pdf", epub: "application/epub+zip", json: "application/json", txt: "text/plain", xml: "text/xml" };
const nodes = new Map(); // id -> node
const idFor = (p) => (p === "" ? ROOT_ID : "x" + crypto.createHash("sha1").update(p).digest("hex").slice(0, 24));
let clock = Date.parse("2026-01-01T00:00:00Z");

function addTree(rel, parent) {
  const full = path.join(LIB, rel);
  const st = fs.statSync(full);
  const id = idFor(rel);
  const isDir = st.isDirectory();
  const ext = path.extname(full).slice(1).toLowerCase();
  clock += 3600_000;
  nodes.set(id, {
    id, parent, name: rel === "" ? "Manga" : path.basename(rel),
    mimeType: isDir ? FOLDER : ext === "cbz" ? (rel.includes("Berserk") ? "application/octet-stream" : "application/x-cbz") : (MIME[ext] ?? "application/octet-stream"),
    data: isDir ? undefined : fs.readFileSync(full),
    modifiedTime: new Date(clock).toISOString(), createdTime: new Date(clock).toISOString(),
    description: rel === "Berserk" ? "Guts' story (from the Drive folder description)" : undefined,
  });
  if (isDir) for (const c of fs.readdirSync(full).sort()) addTree(rel ? `${rel}/${c}` : c, id);
}
addTree("", undefined);
// A folder outside the library, linked into it with a Drive shortcut.
const outsideId = "outsideFolder000000001";
nodes.set(outsideId, { id: outsideId, parent: "elsewhere", name: "Linked Target", mimeType: FOLDER, modifiedTime: new Date(clock).toISOString() });
nodes.set("outsideCbz0000000001", { ...nodes.get(idFor("Native Mix/vol 1.cbz")), id: "outsideCbz0000000001", parent: outsideId, name: "Linked c1.cbz" });
nodes.set("shortcut00000000000001", { id: "shortcut00000000000001", parent: ROOT_ID, name: "Linked Series", mimeType: SHORTCUT, shortcutDetails: { targetId: outsideId, targetMimeType: FOLDER }, modifiedTime: new Date(++clock).toISOString() });

const server = { validTokens: new Set(), refreshes: 0, requests: [], bytesServed: 0, ignoreRange: false, tokenCounter: 0 };

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
function driveError(status, message, reason) {
  return json(status, { error: { code: status, message, errors: [{ reason }] } });
}
function meta(n) {
  const o = { id: n.id, name: n.name, mimeType: n.mimeType, modifiedTime: n.modifiedTime, createdTime: n.createdTime };
  if (n.data) o.size = String(n.data.length);
  if (n.description) o.description = n.description;
  if (n.shortcutDetails) o.shortcutDetails = n.shortcutDetails;
  return o;
}

async function fakeFetch(input, init = {}) {
  const url = new URL(typeof input === "string" ? input : input.url);
  const headers = Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  server.requests.push({ url: url.toString(), headers });

  if (url.hostname === "oauth2.googleapis.com" && url.pathname === "/token") {
    const form = new URLSearchParams(String(init.body));
    if (form.get("grant_type") !== "refresh_token" || form.get("refresh_token") !== "TEST_REFRESH" || form.get("client_id") !== "cid.apps.googleusercontent.com" || form.get("client_secret") !== "csecret") {
      return json(400, { error: "invalid_grant", error_description: "Bad Request" });
    }
    server.refreshes++;
    const token = `tok_${++server.tokenCounter}`;
    server.validTokens.add(token);
    return json(200, { access_token: token, expires_in: 3599, token_type: "Bearer" });
  }
  if (url.hostname !== "www.googleapis.com") throw new Error(`unexpected host ${url.hostname}`);

  // auth
  const bearer = headers["authorization"]?.replace(/^Bearer /, "");
  if (bearer) {
    if (!server.validTokens.has(bearer)) return driveError(401, "Invalid Credentials", "authError");
  } else if (headers["x-goog-api-key"] !== "TEST_API_KEY") {
    return driveError(403, "Method doesn't allow unregistered callers.", "forbidden");
  }

  const m = /^\/drive\/v3\/files(?:\/([^/]+))?$/.exec(url.pathname);
  if (!m) return driveError(404, "Not found", "notFound");
  const id = m[1] && decodeURIComponent(m[1]);

  if (!id) {
    const q = url.searchParams.get("q") ?? "";
    const parent = /'([^']+)' in parents/.exec(q)?.[1];
    if (!nodes.has(parent)) return driveError(404, `File not found: ${parent}.`, "notFound");
    const foldersOnly = q.includes("mimeType =");
    let kids = [...nodes.values()].filter((n) => n.parent === parent && (!foldersOnly || n.mimeType === FOLDER || n.mimeType === SHORTCUT));
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const pageSize = 4; // force pagination
    const page = kids.slice(offset, offset + pageSize);
    return json(200, { files: page.map(meta), ...(offset + pageSize < kids.length ? { nextPageToken: String(offset + pageSize) } : {}) });
  }

  const n = nodes.get(id);
  if (!n) return driveError(404, `File not found: ${id}.`, "notFound");
  if (url.searchParams.get("alt") !== "media") return json(200, meta(n));
  if (!n.data) return driveError(403, "Only files with binary content can be downloaded.", "fileNotDownloadable");

  const range = headers["range"];
  if (range && !server.ignoreRange) {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(range);
    const start = Number(a), end = Math.min(Number(b), n.data.length - 1);
    const body = n.data.subarray(start, end + 1);
    server.bytesServed += body.length;
    return new Response(body, { status: 206, headers: { "content-range": `bytes ${start}-${end}/${n.data.length}`, "content-type": "application/octet-stream" } });
  }
  server.bytesServed += n.data.length;
  return new Response(n.data, { status: 200, headers: { "content-type": n.mimeType } });
}
globalThis.fetch = fakeFetch;

// ---------------------------------------------------------- JSC-like VM
const Application = ApplicationPolyfill();
const logs = [];
const ctx = vm.createContext({
  NaN, undefined, Infinity, isNaN, isFinite, escape, unescape, decodeURI, decodeURIComponent, encodeURI, encodeURIComponent,
  eval, parseInt, parseFloat, ArrayBuffer, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError,
  AggregateError, Proxy, Reflect, JSON, Math, Atomics, Int8Array, Int16Array, Int32Array, Uint8Array, Uint8ClampedArray,
  Uint16Array, Uint32Array, Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView, Date, Error, Boolean,
  Map, Number, Set, WeakMap, WeakSet, Object, Function, Array, RegExp, String, Promise, BigInt, Symbol, WeakRef,
  FinalizationRegistry, Intl, crypto,
  Application,
  console: { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) },
});
ctx.globalThis = ctx;
vm.runInContext(fs.readFileSync(path.join(ROOT, "bundles/GoogleDrive/index.js"), "utf8"), ctx);
const ext = vm.runInContext("source.GoogleDrive", ctx);

// ---------------------------------------------------------------- helpers
let failures = 0, passes = 0;
function check(cond, label, extra = "") {
  if (cond) { passes++; console.log(`  ✔ ${label}`); }
  else { failures++; console.log(`  ✘ ${label} ${extra}`); }
}
const sha = (buf) => crypto.createHash("sha256").update(new Uint8Array(buf)).digest("hex");
const id = (rel) => idFor(rel);
async function load(url) {
  const [res, data] = await Application.scheduleRequest({ url, method: "GET" });
  return { status: res.status, data };
}
async function readChapter(chapter) {
  const before = server.requests.length;
  const details = await ext.getChapterDetails(chapter);
  const listingRequests = server.requests.length - before;
  const pages = await Promise.all(details.pages.map(load));
  return { details, listingRequests, hashes: pages.map((p) => sha(p.data)), statuses: pages.map((p) => p.status) };
}
const sm = async (folderRel) => ext.getMangaDetails(id(folderRel));

// ---------------------------------------------------------------- tests
await ext.initialise();

console.log("Settings & connection (API key mode)");
const form = await ext.getSettingsForm();
check(Array.isArray(form.getSections()), "settings form renders before configuration");
await form.testConnection();
check(/No library folder/.test(form.status?.text), "test connection explains missing folder", form.status?.text);
await form.setRootFolder(`https://drive.google.com/drive/folders/${ROOT_ID}?usp=sharing`);
await form.testConnection();
check(/API key/.test(form.status?.text), "missing API key is reported", form.status?.text);
await form.setApiKey("TEST_API_KEY");
await form.testConnection();
check(form.status?.text === "Connected: 7 series found", "connection test counts series (incl. shortcut, excl. stray file)", form.status?.text);
const hiddenOauth = form.getSections().find((s) => s.id === "auth").items.filter((i) => !i.isHidden).map((i) => i.id);
check(JSON.stringify(hiddenOauth) === JSON.stringify(["authMode", "apiKey"]), "only API key fields visible in API key mode", hiddenOauth);

console.log("Discover & search");
const sections = await ext.getDiscoverSections();
check(sections.length === 2, "two discover sections");
const all = await ext.getDiscoverSectionItems(sections[1], undefined);
check(JSON.stringify(all.items.map((i) => i.title)) === JSON.stringify(["Berserk", "Linked Series", "Loose Images", "Native Mix", "One Piece", "Série Ünicode", "Zip64 Series"]), "all series, natural A–Z", all.items.map((i) => i.title));
const recent = await ext.getDiscoverSectionItems(sections[0], undefined);
check(recent.items[0].title === "Linked Series", "recently updated puts newest first", recent.items.map((i) => i.title));
const search = await ext.getSearchResults({ title: "piece" }, undefined, undefined);
check(search.items.length === 1 && search.items[0].mangaId === id("One Piece"), "search is case-insensitive substring");
check((await ext.getSearchResults({ title: "" }, undefined, undefined)).items.length === 7, "empty search lists everything");

console.log("Series details");
const op = await sm("One Piece");
check(op.mangaInfo.primaryTitle === "One Piece" && op.mangaInfo.author === "Eiichiro Oda", "details.json title/author");
check(op.mangaInfo.synopsis === "Pirates & treasure." && op.mangaInfo.status === "Ongoing", "details.json synopsis/status");
check(JSON.stringify(op.mangaInfo.tagGroups?.[0]?.tags.map((t) => t.title)) === JSON.stringify(["Action", "Adventure"]), "genres from details.json");
check(op.mangaInfo.shareUrl === `https://drive.google.com/drive/folders/${id("One Piece")}`, "share URL opens the Drive folder");
const bz = await sm("Berserk");
check(bz.mangaInfo.synopsis.startsWith("Guts"), "falls back to Drive folder description");

console.log("Chapters");
const opChapters = await ext.getChapters(op);
check(JSON.stringify(opChapters.map((c) => [c.title, c.volume, c.chapNum])) === JSON.stringify([["One Piece v01", 1, 1], ["One Piece v02", 2, 2]]), "volume-only names", JSON.stringify(opChapters.map((c) => [c.title, c.volume, c.chapNum])));
check(opChapters[0].langCode === "en", "language from ComicInfo.xml");
const bzChapters = await ext.getChapters(bz);
check(JSON.stringify(bzChapters.map((c) => [c.title, c.volume, c.chapNum])) === JSON.stringify([["Volume 1 / c001", 1, 1], ["Volume 1 / c002", 1, 2], ["Volume 2 / c010.5", 2, 10.5]]), "nested volume folders + decimal chapters", JSON.stringify(bzChapters.map((c) => [c.title, c.volume, c.chapNum])));
check(bzChapters.every((c, i) => c.sortingIndex === i + 1), "ascending sortingIndex");
const uni = await ext.getChapters(await sm("Série Ünicode"));
check(JSON.stringify(uni.map((c) => c.chapNum)) === JSON.stringify([1, 2]), "chapter numbers despite [Group] tags and unicode", JSON.stringify(uni.map((c) => c.title)));
const loose = await ext.getChapters(await sm("Loose Images"));
check(loose.length === 2 && loose.every((c) => c.chapterId.startsWith("d:")), "folders of images become chapters");
const linked = await ext.getChapters(await ext.getMangaDetails(outsideId));
check(linked.length === 1, "shortcut to a folder outside the library works");
const mix = await ext.getChapters(await sm("Native Mix"));
check(mix.length === 1, "PDF/EPUB hidden in extraction mode");

console.log("Pages (byte-for-byte)");
const archiveCases = [
  ["One Piece/One Piece v01.cbz", opChapters[0], "deflate, shuffled order, junk entries, ComicInfo"],
  ["One Piece/One Piece v02.cbz", opChapters[1], "stored"],
  ["Berserk/Volume 1/c001.cbz", bzChapters[0], "pages in a sub-directory"],
  ["Berserk/Volume 2/c010.5.cbz", bzChapters[2], "archive comment"],
  ["Série Ünicode/Série – Ch. 1 [Group].cbz", uni[0], "unicode entry names"],
];
for (const [rel, chapter, label] of archiveCases) {
  const r = await readChapter(chapter);
  check(JSON.stringify(r.hashes) === JSON.stringify(manifest.archives[rel]), `${label}: ${r.hashes.length} pages match`, JSON.stringify(r.statuses));
  check(r.listingRequests <= 2, `${label}: opened with ${r.listingRequests} small request(s)`);
}
for (const [i, rel] of ["Loose Images/Chapter 1", "Loose Images/Chapter 2"].entries()) {
  const r = await readChapter(loose[i]);
  check(JSON.stringify(r.hashes) === JSON.stringify(manifest.imageFolders[rel]), `image folder ${rel}: pages match in natural order`);
}
const z64 = await ext.getChapters(await sm("Zip64 Series"));
const z64r = await readChapter(z64[0]);
check(JSON.stringify(z64r.hashes) === JSON.stringify(manifest.archives["Zip64 Series/huge.cbz"]), "ZIP64 archive (65k+ entries) pages match");

console.log("Efficiency");
server.bytesServed = 0;
const big = nodes.get(id("One Piece/One Piece v01.cbz")).data.length;
const first = await ext.getChapterDetails(opChapters[0]);
await load(first.pages[0]);
check(server.bytesServed < big * 0.6, `first page of v01 cost ${server.bytesServed} of ${big} bytes`);

console.log("Covers");
const coverOf = async (rel) => sha((await load(op.mangaInfo.thumbnailUrl.replace(id("One Piece"), id(rel)))).data);
check(await coverOf("One Piece") === sha(nodes.get(id("One Piece/cover.jpg")).data), "cover.jpg in series folder");
check(await coverOf("Berserk") === manifest.archives["Berserk/Volume 1/c001.cbz"][0], "first page of first archive when no cover image");
check(await coverOf("Loose Images") === manifest.imageFolders["Loose Images/Chapter 1"][0], "first image of first image-folder chapter");
check(await coverOf("Zip64 Series") === manifest.archives["Zip64 Series/huge.cbz"][0], "cover from ZIP64 archive");
const reqCount = server.requests.length;
await coverOf("Berserk");
check(server.requests.length - reqCount === 1, "cover location is cached (1 request on reload)");

console.log("Range header ignored by server");
server.ignoreRange = true;
const full = await readChapter(opChapters[1]);
check(JSON.stringify(full.hashes) === JSON.stringify(manifest.archives["One Piece/One Piece v02.cbz"]), "pages still extracted from a full-file response");
server.ignoreRange = false;

console.log("OAuth mode");
await form.setAuthMode(["oauth"]);
const visible = form.getSections().find((s) => s.id === "auth").items.filter((i) => !i.isHidden).map((i) => i.id);
check(JSON.stringify(visible) === JSON.stringify(["authMode", "clientId", "clientSecret", "refreshToken"]), "OAuth fields visible", visible);
await form.setClientId("cid.apps.googleusercontent.com");
await form.setClientSecret("csecret");
await form.setRefreshToken("WRONG");
await form.testConnection();
check(/invalid_grant|Bad Request/.test(form.status?.text) && /7 days/.test(form.status?.text), "bad refresh token explained", form.status?.text);
await form.setRefreshToken("TEST_REFRESH");
await form.testConnection();
check(form.status?.text === "Connected: 7 series found", "OAuth connection works", form.status?.text);
server.refreshes = 0;
const oauthPages = await readChapter((await ext.getChapters(op))[0]);
check(JSON.stringify(oauthPages.hashes) === JSON.stringify(manifest.archives["One Piece/One Piece v01.cbz"]), "pages load with bearer token");
check(server.refreshes === 0, "access token reused across parallel page loads");
server.validTokens.clear(); // simulate expiry/revocation server-side
const afterExpiry = await ext.getChapters(bz);
check(afterExpiry.length === 3 && server.refreshes === 1, "401 triggers one refresh and a retry", `refreshes=${server.refreshes}`);
const noKeyLeak = server.requests.every((r) => !/TEST_API_KEY|tok_|TEST_REFRESH|csecret/.test(r.url));
check(noKeyLeak, "credentials only travel in headers, never in URLs");

console.log("Setup code");
const code = Buffer.from(JSON.stringify({ v: 1, f: "1SetupFolderId000000000", ci: "cid2.apps.googleusercontent.com", cs: "csecret2", rt: "rt2" })).toString("base64url");
await form.setSetupCode("not-a-code");
check(/isn't valid/.test(form.status?.text), "invalid setup code rejected", form.status?.text);
await form.setSetupCode(code);
check(/applied/.test(form.status?.text), "setup code applied", form.status?.text);
check(Application.getState("rootFolderInput").endsWith("/folders/1SetupFolderId000000000") && Application.getSecureState("oauthRefreshToken") === "rt2" && Application.getSecureState("oauthClientSecret") === "csecret2" && Application.getState("oauthClientId") === "cid2.apps.googleusercontent.com" && Application.getState("authMode") === "oauth", "setup code fills folder, mode and credentials");
check(form.getSections().find((s) => s.id === "setup").items[0].value === "", "setup code isn't echoed back in the form");
// restore the working OAuth credentials for the remaining tests
await form.setRootFolder(`https://drive.google.com/drive/folders/${ROOT_ID}`);
await form.setClientId("cid.apps.googleusercontent.com");
await form.setClientSecret("csecret");
await form.setRefreshToken("TEST_REFRESH");

console.log("Built-in reader mode");
await form.setNativeReader(true);
const mixNative = await ext.getChapters(await sm("Native Mix"));
check(JSON.stringify(mixNative.map((c) => c.title)) === JSON.stringify(["side story", "vol 1", "vol 2"]), "PDF and EPUB listed", JSON.stringify(mixNative.map((c) => c.title)));
const nd = await ext.getChapterDetails(mixNative[2]);
check(nd.type === "file" && nd.format === "pdf" && /^Bearer tok_/.test(nd.request.headers.Authorization), "file chapter with auth header", JSON.stringify(nd));
const ndCbz = await ext.getChapterDetails(mixNative[1]);
check(ndCbz.format === "cbz" && ndCbz.request.url.includes("alt=media"), "CBZ handed to the app as a file");
await form.setNativeReader(false);

console.log("Errors");
await form.setRootFolder("https://drive.google.com/drive/folders/doesNotExist12345");
await form.testConnection();
check(/404/.test(form.status?.text) && /shared/.test(form.status?.text), "missing/unshared folder explained", form.status?.text);
await form.setRootFolder("not a link");
check(form.getSections().find((s) => s.id === "library").items.some((i) => i.id === "rootFolderInvalid"), "invalid folder link flagged in settings");

console.log(`\n${passes} passed, ${failures} failed`);
if (logs.length) console.log("extension log:\n  " + logs.join("\n  "));
process.exit(failures ? 1 : 0);
