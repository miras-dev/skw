#!/usr/bin/env python3
"""Rebuild the web images in assets/ from the full-size originals in assets-src/.

The originals are 1-2.5 MB PNGs; pages only ever show them as backgrounds,
a hero banner or a logo, so each is exported once at the largest size it is
displayed at (2x for retina) as WebP. Crawlers get a JPEG og:image and
browsers get small PNG icons, since those two consumers don't all read WebP.

    pip install pillow && python3 scripts/build-images.py

Output names are stable, and deploy.yml caches assets/ for 30 days: when an
image changes visibly, give the output a new name (e.g. logo-v2.webp) and
update the pages, or visitors keep the old one until their cache expires.
"""
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC, OUT = ROOT / "assets-src", ROOT / "assets"


def fit(im, width):
    if im.width <= width:
        return im
    return im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)


def webp(src, out, width, quality):
    fit(Image.open(SRC / src), width).save(OUT / out, "WEBP", quality=quality, method=6)


def png_square(src, out, size):
    im = Image.open(SRC / src).convert("RGBA")
    side = max(im.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2))
    canvas.resize((size, size), Image.LANCZOS).save(OUT / out, "PNG", optimize=True)


OUT.mkdir(exist_ok=True)
# Page backgrounds sit under a dark scrim, so they tolerate lower quality.
webp("LandingBg.png", "landing-bg.webp", 1672, 60)
webp("Topbg.png", "top-bg.webp", 1848, 60)
webp("Bodybg.png", "body-bg.webp", 1847, 60)
# Hero banner: full-viewport, object-fit: cover. A phone-width copy for srcset.
webp("LsndingBannerBg.png", "banner-bg.webp", 1672, 72)
webp("LsndingBannerBg.png", "banner-bg-900.webp", 900, 72)
# Logo: shown at most 380 CSS px wide (hero), 28 px in the header.
webp("Transparent_Logo.png", "logo.webp", 760, 82)
webp("Transparent_Logo.png", "logo-64.webp", 64, 90)
png_square("Transparent_Logo.png", "favicon-32.png", 32)
png_square("Transparent_Logo.png", "apple-touch-icon.png", 180)
png_square("Transparent_Logo.png", "logo-256.png", 256)   # schema.org logo (min 112 px)
# Social preview: 1200x630-ish JPEG, which every crawler reads.
fit(Image.open(SRC / "Thumbnaill.png").convert("RGB"), 1200).save(
    OUT / "og-image.jpg", "JPEG", quality=82, optimize=True, progressive=True)

for f in sorted(OUT.iterdir()):
    print(f"{f.stat().st_size / 1024:8.1f} KB  {f.name}")
