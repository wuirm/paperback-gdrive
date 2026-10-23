#!/usr/bin/env python3
"""Builds a fake Drive library on disk for the end-to-end test (stdlib only).

Writes test/.fixtures/library/... and test/.fixtures/manifest.json, which lists the
expected page order and SHA-256 of every page so the test can verify extraction.
"""
import hashlib
import json
import os
import random
import shutil
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, ".fixtures")
LIB = os.path.join(OUT, "library")
rng = random.Random(42)
manifest = {"archives": {}, "imageFolders": {}}


def fake_image(kind="jpg", size=None):
    size = size or rng.randint(3000, 60000)
    # Realistic headers; the body compresses a little so deflate is exercised.
    header = b"\xff\xd8\xff\xe0" if kind == "jpg" else b"\x89PNG\r\n\x1a\n"
    body = bytes(rng.choice(b"abcdefgh\x00\x01\x02") for _ in range(size))
    return header + body


def sha(b):
    return hashlib.sha256(b).hexdigest()


def write(path, data):
    full = os.path.join(LIB, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as f:
        f.write(data)


def make_cbz(path, pages, compression=zipfile.ZIP_DEFLATED, extras=None, junk=True, comicinfo=None, comment=b""):
    """pages: list of (name_in_zip, bytes). Expected order = natural order of names."""
    full = os.path.join(LIB, path)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with zipfile.ZipFile(full, "w", compression=compression) as z:
        z.comment = comment
        if junk:
            z.writestr("__MACOSX/._001.jpg", b"junk")
            z.writestr(".DS_Store", b"junk")
        # Write pages in shuffled order so the reader must sort them itself.
        shuffled = pages[:]
        rng.shuffle(shuffled)
        dirs = set()
        for name, data in shuffled:
            if "/" in name and name.rsplit("/", 1)[0] not in dirs:
                dirs.add(name.rsplit("/", 1)[0])
                z.writestr(zipfile.ZipInfo(name.rsplit("/", 1)[0] + "/"), b"")
            z.writestr(name, data)
        if comicinfo:
            z.writestr("ComicInfo.xml", comicinfo)
        for name, data in (extras or []):
            z.writestr(name, data)
    manifest["archives"][path] = [sha(d) for _, d in pages]


def natural_pages(names, kind="jpg"):
    return [(n, fake_image(kind)) for n in names]


def main():
    shutil.rmtree(OUT, ignore_errors=True)
    os.makedirs(LIB)

    # 1. Classic layout with cover + details.json + ComicInfo.xml
    write("One Piece/cover.jpg", fake_image())
    write("One Piece/details.json", json.dumps({
        "title": "One Piece",
        "author": "Eiichiro Oda",
        "artist": "Eiichiro Oda",
        "description": "Pirates & treasure.",
        "genre": ["Action", "Adventure"],
        "status": "1",
    }).encode())
    comicinfo = b"""<?xml version="1.0"?>
<ComicInfo><Series>ONE PIECE</Series><Writer>Oda</Writer><Summary>From ComicInfo</Summary>
<Genre>Shounen, Comedy</Genre><AgeRating>Teen</AgeRating><LanguageISO>en</LanguageISO></ComicInfo>"""
    make_cbz("One Piece/One Piece v01.cbz",
             natural_pages(["001.jpg", "002.jpg", "003.jpg", "010.jpg", "011.jpg"]),
             comicinfo=comicinfo)
    # Stored, equal-size pages with equal-length names: entries land at 0, S, 2S…
    # so one page starts at exactly twice another's offset (regression layout).
    make_cbz("One Piece/One Piece v02.cbz",
             [(n, fake_image("jpg", size=996)) for n in ["p1.jpg", "p2.jpg", "p3.jpg"]],
             compression=zipfile.ZIP_STORED, junk=False)
    write("One Piece/notes.txt", b"ignore me")

    # 2. Nested volume folders, no cover -> cover from first archive's first page
    make_cbz("Berserk/Volume 1/c001.cbz", natural_pages(["pages/01.png", "pages/02.png"], "png"))
    make_cbz("Berserk/Volume 1/c002.cbz", natural_pages(["01.png", "02.png", "03.png"], "png"))
    make_cbz("Berserk/Volume 2/c010.5.cbz", natural_pages(["a.jpg", "b.jpg"]), comment=b"x" * 2000)

    # 3. Chapters as folders of loose images
    for ch, names in (("Chapter 1", ["1.jpg", "2.jpg", "10.jpg"]), ("Chapter 2", ["01.png", "02.png"])):
        pics = []
        for n in names:
            data = fake_image("png" if n.endswith("png") else "jpg")
            write(f"Loose Images/{ch}/{n}", data)
            pics.append(sha(data))
        manifest["imageFolders"][f"Loose Images/{ch}"] = pics

    # 4. ZIP64 (more than 65535 entries) with an explicit cover inside the archive
    full = os.path.join(LIB, "Zip64 Series/huge.cbz")
    os.makedirs(os.path.dirname(full), exist_ok=True)
    pages = natural_pages(["page1.jpg", "page2.jpg", "page3.jpg"])
    with zipfile.ZipFile(full, "w", compression=zipfile.ZIP_DEFLATED) as z:
        for name, data in pages:
            z.writestr(name, data)
        for i in range(65540):
            z.writestr(f"filler/{i}.txt", b"")
    manifest["archives"]["Zip64 Series/huge.cbz"] = [sha(d) for _, d in pages]

    # 5. Unicode names, deflate, chapter numbers in names
    make_cbz("Série Ünicode/Série – Ch. 1 [Group].cbz", natural_pages(["ページ1.jpg", "ページ2.jpg"]))
    make_cbz("Série Ünicode/Série – Ch. 2 [Group].cbz", natural_pages(["ページ1.jpg"]))

    # 6. Native formats (PDF/EPUB only listed when the built-in reader is on)
    make_cbz("Native Mix/vol 1.cbz", natural_pages(["1.jpg"]))
    write("Native Mix/vol 2.pdf", b"%PDF-1.4 fake")
    write("Native Mix/side story.epub", b"PK fake epub")

    # Stray file in the root must be ignored.
    write("README.txt", b"not a series")

    with open(os.path.join(OUT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1, ensure_ascii=False)
    print(f"fixtures written to {OUT}")


if __name__ == "__main__":
    sys.exit(main())
