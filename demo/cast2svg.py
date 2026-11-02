"""Render an asciicast v2 recording to a self-contained animated SVG.

The recording is append-only terminal output (no cursor addressing), so each
line can simply fade in at the moment it was actually written. Timings come
from the recording, not from guesswork.
"""
import json, re, sys, html

CAST, OUT = sys.argv[1], sys.argv[2]

FG = "#c9d1d9"; BG = "#0d1117"; DIM = "#6e7681"
SGR = {"36": "#56d4dd", "32": "#56d364", "33": "#e3b341", "31": "#f85149", "2": DIM}
CW, LH, PAD, FS = 8.4, 20.0, 22.0, 14.0
TOP = 44.0  # room for the window chrome

events = []
with open(CAST) as f:
    header = json.loads(f.readline())
    for line in f:
        if line.strip():
            events.append(json.loads(line))

# Flatten to (time, line_text_with_sgr) as lines complete.
lines, cur, cur_t = [], "", 0.0
for t, _, data in events:
    for ch in data.replace("\r\n", "\n").replace("\r", ""):
        if ch == "\n":
            lines.append((cur_t, cur)); cur, cur_t = "", t
        else:
            if not cur: cur_t = t
            cur += ch
if cur.strip():
    lines.append((cur_t, cur))

ANSI = re.compile(r"\x1b\[([0-9;]*)m")

def spans(text):
    """Split a line into (colour, bold, text) runs."""
    out, pos, colour, bold = [], 0, FG, False
    for m in ANSI.finditer(text):
        if m.start() > pos:
            out.append((colour, bold, text[pos:m.start()]))
        for code in (m.group(1) or "0").split(";"):
            if code in ("", "0"): colour, bold = FG, False
            elif code == "1": bold = True
            elif code in SGR: colour = SGR[code]
        pos = m.end()
    if pos < len(text):
        out.append((colour, bold, text[pos:]))
    return out

total = max((t for t, _ in lines), default=0.0) + 2.5
width = int(max((len(ANSI.sub("", s)) for _, s in lines), default=80) * CW + PAD * 2)
height = int(TOP + len(lines) * LH + PAD)

css, body = [], []
for i, (t, text) in enumerate(lines):
    pct = max(0.0, min(99.0, t / total * 100.0))
    css.append(f"@keyframes a{i}{{0%,{pct:.2f}%{{opacity:0}}{min(pct+0.4,99.9):.2f}%,100%{{opacity:1}}}}")
    css.append(f".l{i}{{animation:a{i} {total:.2f}s steps(1,end) infinite}}")
    y = TOP + (i + 1) * LH
    runs, x = [], PAD
    for colour, bold, chunk in spans(text):
        if not chunk: continue
        weight = ' font-weight="600"' if bold else ""
        runs.append(f'<tspan x="{x:.1f}" fill="{colour}"{weight}>{html.escape(chunk)}</tspan>')
        x += len(chunk) * CW
    body.append(f'<text class="l{i}" y="{y:.1f}">{"".join(runs)}</text>')

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" font-family="SFMono-Regular,Consolas,Liberation Mono,Menlo,monospace" font-size="{FS}">
<style>{"".join(css)}</style>
<rect width="{width}" height="{height}" rx="10" fill="{BG}"/>
<circle cx="24" cy="22" r="6" fill="#ff5f57"/><circle cx="44" cy="22" r="6" fill="#febc2e"/><circle cx="64" cy="22" r="6" fill="#28c840"/>
<text x="{width/2:.0f}" y="27" fill="{DIM}" font-size="12" text-anchor="middle">{html.escape(header.get("title",""))}</text>
{chr(10).join(body)}
</svg>'''
open(OUT, "w").write(svg)
print(f"  {OUT}: {width}x{height}, {len(lines)} lines, {total:.1f}s loop")
