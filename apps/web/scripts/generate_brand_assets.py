#!/usr/bin/env python3
"""One-off icon-derivation tool for the KaneGrowth brand assets.

This script is **not** invoked by ``npm run build``, lint, typecheck or CI. It exists so the
PWA/apple/favicon rasters can be re-derived from the master logo artwork when that artwork
changes. Its PNG/ICO outputs are committed to ``apps/web/public/``.

Source (read-only): ``apps/web/public/icons/kanegrowth_logo_gold_green_transparent.png``
(the single 1024x1024 RGBA gold/green 金 mark, used for both light and dark themes). Nothing under
``apps/web/public/icons/`` or ``apps/web/src-tauri/icons/`` is written, cropped, masked or
re-encoded by this tool.

Outputs, all on a **transparent** canvas (the artwork's alpha channel is preserved, so no opaque
background is painted behind the mark):
  - ``public/pwa-192.png``          192x192, artwork scaled 1.0
  - ``public/pwa-512.png``          512x512, artwork scaled 1.0
  - ``public/apple-touch-icon.png`` 180x180, artwork scaled 1.0
  - ``public/maskable-512.png``     512x512, artwork scaled 0.88 and centred (safe zone)
  - ``public/favicon.ico``          16/32/48 multi-size ICO rendered from the pwa-512 composite

Run from the repository root with::

    python3 apps/web/scripts/generate_brand_assets.py

or via ``npm --prefix apps/web run brand:assets``.
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

TRANSPARENT = (0, 0, 0, 0)
LOGO_SIZE = 1024
MASKABLE_SCALE = 0.88
FAVICON_SIZES = [(16, 16), (32, 32), (48, 48)]

# .../kanegrowth/apps/web/scripts/generate_brand_assets.py -> repo root
REPO_ROOT = Path(__file__).resolve().parents[3]
PUBLIC_DIR = REPO_ROOT / "apps" / "web" / "public"
LOGO_PATH = PUBLIC_DIR / "icons" / "kanegrowth_logo_gold_green_transparent.png"


def load_logo() -> Image.Image:
    if not LOGO_PATH.is_file():
        sys.exit(f"brand:assets: missing logo artwork at {LOGO_PATH}")

    logo = Image.open(LOGO_PATH)
    if logo.size != (LOGO_SIZE, LOGO_SIZE):
        sys.exit(
            f"brand:assets: {LOGO_PATH} is {logo.size[0]}x{logo.size[1]}, "
            f"expected {LOGO_SIZE}x{LOGO_SIZE}"
        )
    if logo.mode != "RGBA":
        sys.exit(f"brand:assets: {LOGO_PATH} is mode {logo.mode}, expected RGBA")

    return logo.convert("RGBA")


def composite(logo: Image.Image, size: int, scale: float = 1.0) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), TRANSPARENT)

    inner = round(size * scale)
    artwork = logo.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.alpha_composite(artwork, (offset, offset))

    return canvas


def main() -> None:
    logo = load_logo()

    pwa_512 = composite(logo, 512)
    pwa_512.save(PUBLIC_DIR / "pwa-512.png")
    composite(logo, 192).save(PUBLIC_DIR / "pwa-192.png")
    composite(logo, 180).save(PUBLIC_DIR / "apple-touch-icon.png")
    composite(logo, 512, MASKABLE_SCALE).save(PUBLIC_DIR / "maskable-512.png")
    pwa_512.save(PUBLIC_DIR / "favicon.ico", sizes=FAVICON_SIZES)

    print("brand:assets: wrote pwa-192, pwa-512, apple-touch-icon, maskable-512 and favicon.ico")


if __name__ == "__main__":
    main()
