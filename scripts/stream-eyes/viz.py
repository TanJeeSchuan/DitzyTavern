"""Needs numpy and Pillow. Turns a trace run's screencast into pictures an image-reading agent can inspect.

  filmstrip.png  frames sampled across the stream, cropped to the message column
  arrival.png    per pixel, aligned to the streaming message: when it reached its final value (color = time)
  fade-<n>.png   the block receiving each fade, from 100ms before insertion to 600ms after
"""
import json, sys
import numpy as np
from PIL import Image, ImageDraw

run = sys.argv[1]
trace = json.load(open(f"{run}/trace.json"))
t0 = next(e["t"] for e in trace["events"] if e["type"] == "add")
shots = [(s["wall"] - trace["origin"] - t0, f"{run}/frames/{s['file']}") for s in trace["shots"]]
CROP = (360, 80, 990, int(__import__("os").environ.get("VH", 900)) - 180)  # message column, below the header, above the composer

def frame_at(t):
    return min(shots, key=lambda s: abs(s[0] - t) if s[0] <= t + 1 else 1e9)

def load(path):
    return Image.open(path).convert("RGB").crop(CROP)

def label(image, text):
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 8 * len(text) + 8, 18), fill=(20, 20, 20))
    draw.text((4, 3), text, fill=(255, 255, 0))
    return image

def grid(tiles, columns):
    w, h = tiles[0].size
    rows = (len(tiles) + columns - 1) // columns
    sheet = Image.new("RGB", (w * columns, h * rows), (255, 255, 255))
    for index, tile in enumerate(tiles):
        sheet.paste(tile, ((index % columns) * w, (index // columns) * h))
    return sheet

# Filmstrip: 12 evenly spaced frames from first fade to the end.
end = shots[-1][0]
times = np.linspace(-50, end, 12)
grid([label(load(frame_at(t)[1]).resize((315, 320)), f"{t:.0f}ms") for t in times], 6).save(f"{run}/filmstrip.png")

frames = [f for f in trace["frames"] if "article" in f]
def geometry(t):
    return min(frames, key=lambda f: abs(f["t"] - t0 - t))

def aligned(path, t, box, height):
    """The frame cropped to `box` (left, right) from the streaming message's top at time t, padded where offscreen."""
    top = geometry(t)["article"][1]
    image = Image.open(path).convert("RGB")
    canvas = Image.new("RGB", (int(box[1] - box[0]), int(height)), (255, 0, 255))
    canvas.paste(image.crop((int(box[0]), int(top), int(box[1]), int(top + height))), (0, 0))
    return canvas

# Arrival map, aligned to the streaming message: the first frame after which a pixel stays at its final value.
final_box = frames[-1]["article"]
height = final_box[3] - final_box[1]
stack = np.stack([np.asarray(aligned(path, t, (final_box[0], final_box[2]), height), dtype=np.int16) for t, path in shots])
final = stack[-1]
close = (np.abs(stack - final).max(axis=3) <= 6)
HOLD = 12  # frames (~200ms) a pixel must stay at its final value to count as arrived
held = np.lib.stride_tricks.sliding_window_view(np.pad(close, ((0, HOLD - 1), (0, 0), (0, 0)), constant_values=True), HOLD, axis=0).all(axis=-1)
first = held.argmax(axis=0)
changed = ~held[0]
t = np.array([s[0] for s in shots])[first]
span = max(end - 400, 1)
norm = np.clip(t / span, 0, 1)
colors = np.stack([255 * norm, 60 + 120 * np.sin(np.pi * norm), 255 * (1 - norm)], axis=-1)
base = final.astype(np.float32) * 0.25 + 255 * 0.75
arrival = Image.fromarray(np.where(changed[..., None], colors, base).astype(np.uint8))
draw = ImageDraw.Draw(arrival)
for i in range(240):
    n = i / 239
    draw.line((10 + i, 4, 10 + i, 14), fill=(int(255 * n), int(60 + 120 * np.sin(np.pi * n)), int(255 * (1 - n))))
draw.text((256, 3), f"0 -> {span:.0f}ms after first fade", fill=(0, 0, 0))
arrival.save(f"{run}/arrival.png")

# Fade rows: the block that received each fade, from 100ms before insertion to 600ms after.
rows = []
for e in trace["events"]:
    if e["type"] != "add" or e["chars"] < 5:
        continue
    at = e["t"] - t0
    block = geometry(at + 600)["blocks"][-1]
    tiles = []
    for dt in range(-100, 601, 100):
        g = geometry(at + dt)
        index = min(len(g["blocks"]), len(geometry(at + 600)["blocks"])) - 1
        left, top, right, bottom = g["blocks"][index] if index >= 0 else block
        image = Image.open(frame_at(at + dt)[1]).convert("RGB").crop((int(left), int(top), int(right), int(top + block[3] - block[1])))
        tiles.append(label(image.resize((image.width // 2, image.height // 2)), f"#{e['id']} {dt:+}ms"))
    rows.append(grid(tiles, 4))
for index, row in enumerate(rows):
    row.save(f"{run}/fade-{index}.png")
print("wrote filmstrip.png arrival.png fade-*.png")
