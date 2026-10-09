# OpenAdmiral icon: a constellation of our own starbursts (irregular rounded rays) joined by thin lines.
import math, sys
out = sys.argv[1]

def burst(cx, cy, r, rays, seed, fill, core=0.24):
    """Rays are round-capped strokes of uneven length, width and angle around a solid core."""
    parts = [f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r*core:.1f}" fill="{fill}"/>']
    for i in range(rays):
        # Deterministic irregularity: no two rays alike, nothing like an evenly spaced asterisk.
        j = math.sin(seed * 12.9898 + i * 78.233) * 43758.5453
        j = j - math.floor(j)
        k = math.sin(seed * 4.1 + i * 9.7) * 1000; k = k - math.floor(k)
        ang = (i + 0.32 * (j - 0.5)) * 2 * math.pi / rays - math.pi / 2 + seed * 0.4
        length = r * (0.74 + 0.26 * k)
        width = r * (0.105 + 0.05 * j)
        x2, y2 = cx + length * math.cos(ang), cy + length * math.sin(ang)
        x1, y1 = cx + r * 0.12 * math.cos(ang), cy + r * 0.12 * math.sin(ang)
        parts.append(f'<line x1="{x1:.1f}" y1="{y1:.1f}" x2="{x2:.1f}" y2="{y2:.1f}" stroke="{fill}" stroke-width="{width:.1f}" stroke-linecap="round"/>')
    return "".join(parts)

NODES = [(440, 575, 215, 10, 1), (728, 340, 104, 9, 2), (735, 728, 80, 8, 3), (318, 282, 58, 8, 4)]
LINKS = [(0, 1), (0, 2), (0, 3), (1, 2)]

def squircle(fill, stroke):
    # Continuous-corner rounded square on the macOS icon grid (824 of 1024).
    return (f'<rect x="100" y="100" width="824" height="824" rx="185" fill="{fill}"/>'
            f'<rect x="100.5" y="100.5" width="823" height="823" rx="185" fill="none" stroke="{stroke}" stroke-opacity=".5"/>')

COLORWAYS = {
    "terracotta": dict(bg="url(#bg)", bg0="#2a211d", bg1="#15110f", rim="#4a3a33", g0="#ec9677", g1="#d97757", g2="#b9583b", line="#d97757"),
    # Stars from the light end of the BlueSky ramp so they read on the navy squircle.
    "blue": dict(bg="url(#bg)", bg0="#11204a", bg1="#070d22", rim="#26355f", g0="#dbe6ff", g1="#a9c1ff", g2="#5c8bff", line="#5c8bff", line_opacity=".32", glow="#5c8bff"),
}

def icon(c, simple=False):
    defs = (f'<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="{c["bg0"]}"/><stop offset="1" stop-color="{c["bg1"]}"/></linearGradient>'
            + (f'<filter id="glow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="{c.get("blur", 14)}"/></filter>' if c.get("glow") else "") + f'<linearGradient id="fg" gradientUnits="userSpaceOnUse" x1="160" y1="160" x2="864" y2="864"><stop offset="0" stop-color="{c["g0"]}"/><stop offset=".55" stop-color="{c["g1"]}"/><stop offset="1" stop-color="{c["g2"]}"/></linearGradient></defs>')
    body = squircle(c["bg"], c["rim"])
    if simple:
        # Small sizes: the big starburst alone, centered, so it never mushes.
        stars = burst(512, 512, 310, 10, 1, "url(#fg)", core=0.26)
        halo = burst(512, 512, 310, 10, 1, c.get("glow", "none"), core=0.26)
    else:
        for a, b in LINKS:
            (x1, y1, *_), (x2, y2, *_) = NODES[a], NODES[b]
            body += f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" stroke="{c["line"]}" stroke-opacity="{c.get("line_opacity", ".45")}" stroke-width="9" stroke-linecap="round"/>'
        stars = "".join(burst(x, y, r, rays, seed, "url(#fg)") for (x, y, r, rays, seed) in NODES)
        halo = "".join(burst(x, y, r, rays, seed, c.get("glow", "none")) for (x, y, r, rays, seed) in NODES)
    if c.get("glow"):
        # A soft brand-blue glow behind the stars, so they lift off the navy.
        body += f'<g filter="url(#glow)" opacity=".55">{halo}</g>'
    body += stars
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">{defs}{body}</svg>'

def tray(size_hint):
    # Template image: black on transparent, macOS tints it. One big starburst, two small, no lines.
    s = ""
    s += burst(13, 19, 11.5, 9, 1, "#000", core=0.34)
    s += burst(26.5, 8.5, 5.6, 8, 2, "#000", core=0.36)
    s += burst(28, 27.5, 4.4, 7, 3, "#000", core=0.38)
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 36 36">{s}</svg>'

for name, c in COLORWAYS.items():
    open(f"{out}/admiral-{name}.svg", "w").write(icon(c))
    open(f"{out}/admiral-{name}-small.svg", "w").write(icon(c, simple=True))
open(f"{out}/admiral-tray.svg", "w").write(tray(36))
print("ok")
