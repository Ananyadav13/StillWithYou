"""Step 8: prove the CSS font stack renders Devanagari rather than tofu boxes.

Two independent checks, because either alone is weak:

1. **cmap coverage.** Walk the font stack in CSS order and, for every codepoint in a
   real Hindi test message, find the first font whose character map contains it. This
   is what the browser does. A codepoint no font claims is a missing-glyph box.

2. **Actual raster.** Draw the message with the winning font and write a PNG, so the
   result can be looked at rather than inferred. A font can advertise a codepoint in
   its cmap and still draw it badly (wrong conjuncts, detached matras), which only
   looking will catch.

Run from `backend/`:  .venv/Scripts/python.exe scripts/check_devanagari_glyphs.py
"""

import sys
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8")

from fontTools.ttLib import TTCollection, TTFont  # noqa: E402
from PIL import Image, ImageDraw, ImageFont  # noqa: E402

# The stack from frontend/src/index.css, in order, mapped to the Windows font files
# on this machine. The Latin faces come first exactly as the browser sees them.
# Nirmala ships as a .ttc collection on Windows 11, not the .ttf the name suggests.
# The Noto and macOS entries are expected to be absent here; they are the fallbacks
# that matter on Linux/Android and macOS respectively, and their absence on this
# machine is the correct result rather than a failure.
FONT_STACK = [
    ("Segoe UI", r"C:\Windows\Fonts\segoeui.ttf"),
    ("Nirmala UI", r"C:\Windows\Fonts\Nirmala.ttc"),
    ("Noto Sans Devanagari", r"C:\Windows\Fonts\NotoSansDevanagari-Regular.ttf"),
]

TEST = "मैंने तीन बार बिल के बारे में पूछा, अभी तक कोई जवाब नहीं।"
MIXED = "Bill ka reminder: कोई बात नहीं यार"
OUT = Path(__file__).resolve().parents[2] / "docs" / "phase3-devanagari-render.png"


def cmap_of(path: str) -> set[int] | None:
    try:
        font = TTCollection(path).fonts[0] if path.lower().endswith(".ttc") else TTFont(path)
        covered: set[int] = set()
        for table in font["cmap"].tables:
            covered |= set(table.cmap.keys())
        return covered
    except Exception as exc:  # noqa: BLE001
        print(f"  (could not read {path}: {type(exc).__name__})")
        return None


def main() -> None:
    print("=== font stack coverage, in CSS order ===\n")
    coverage = {}
    for name, path in FONT_STACK:
        if not Path(path).exists():
            print(f"  {name:<24} NOT INSTALLED ({path})")
            continue
        cmap = cmap_of(path)
        if cmap is None:
            continue
        coverage[name] = cmap
        deva = sum(1 for cp in cmap if 0x0900 <= cp <= 0x097F)
        print(f"  {name:<24} installed, {deva:>3} Devanagari codepoints in cmap")

    print(f"\n=== resolving every character of the test message ===\n  {TEST}\n")
    unresolved = []
    winners: dict[str, str] = {}
    for ch in sorted(set(TEST)):
        if ch.isspace():
            continue
        for name, _ in FONT_STACK:
            if name in coverage and ord(ch) in coverage[name]:
                winners[ch] = name
                break
        else:
            unresolved.append(ch)

    by_font: dict[str, list[str]] = {}
    for ch, name in winners.items():
        by_font.setdefault(name, []).append(ch)
    for name, chars in by_font.items():
        print(f"  {name:<24} renders {len(chars):>2} chars: {''.join(sorted(chars))}")

    print(f"\n  unresolved (would render as tofu): {unresolved if unresolved else 'NONE'}")

    # 2. Raster, so the conjuncts and matras can actually be inspected.
    # Pick the first font that covers *the actual test string*, not merely one that
    # has some Devanagari in its cmap — Segoe UI carries 10 stray Devanagari
    # codepoints and would otherwise win here while rendering nothing legible.
    needed = {ord(c) for c in TEST if not c.isspace() and ord(c) >= 0x0900}
    face = next(
        (p for n, p in FONT_STACK
         if n in coverage and needed <= coverage[n] and Path(p).exists()),
        None,
    )
    if face is None:
        print("\n  no Devanagari-capable font found; skipping raster")
        return

    img = Image.new("RGB", (1000, 200), "white")
    draw = ImageDraw.Draw(img)
    # index=0 selects Nirmala UI Regular out of the .ttc collection.
    pil_font = ImageFont.truetype(face, 30, index=0)
    draw.text((20, 25), TEST, font=pil_font, fill="black")
    draw.text((20, 90), MIXED, font=pil_font, fill="black")
    draw.text((20, 150), "en/hi/hi-en-mixed rendering check", font=ImageFont.truetype(
        r"C:\Windows\Fonts\segoeui.ttf", 20), fill="#666666")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT)
    print(f"\n  rasterized with {Path(face).name} -> {OUT}")


if __name__ == "__main__":
    main()
