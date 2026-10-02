"""Needs numpy and Pillow. Reads trace.json: prints the fade timeline and every fade that was removed before finishing (a visible snap)."""
import json, sys

trace = json.load(open(sys.argv[1] + "/trace.json"))
events = trace["events"]
t0 = next(e["t"] for e in events if e["type"] == "add")
adds = {e["id"]: e for e in events if e["type"] == "add"}
print(f"{'t(ms)':>7}  event")
for e in events:
    t = e["t"] - t0
    if e["type"] == "sse": continue
    if e["type"] == "mutation":
        print(f"{t:7.0f}    ~ block[{e['block']}] in {e['target']}: +{e['added']} -{e['removed']} html={e['html']}")
    elif e["type"] == "add":
        print(f"{t:7.0f}  + {e['kind']:5} #{e['id']:<3} {e['chars']:4} chars  {e['text']!r}")
    else:
        snap = e["age"] < 450 and e["lastOpacity"] < 0.99
        flag = f"  SNAP: opacity {e['lastOpacity']:.2f} -> 1.00" if snap else ""
        print(f"{t:7.0f}  - {e['kind']:5} #{e['id']:<3} age {e['age']:4.0f}ms{flag}")

sse = [e for e in events if e["type"] == "sse"]
if sse:
    total = sum(e["contentChars"] for e in sse)
    print(f"\nSSE: {len(sse)} reads, {total} content events, first {sse[0]['t']-t0:.0f}ms last {sse[-1]['t']-t0:.0f}ms")
    for e in sse[::max(1, len(sse)//12)]:
        print(f"  {e['t']-t0:7.0f}ms  read {e['bytes']}B  +{e['contentChars']} events")
events = [e for e in events if e["type"] not in ("mutation", "sse")]
removed = [e for e in events if e["type"] == "remove"]
snaps = [e for e in removed if e["age"] < 450 and e["lastOpacity"] < 0.99]
gaps = [b["t"] - a["t"] for a, b in zip(list(adds.values()), list(adds.values())[1:])]
print(f"\nfades: {len(adds)}   removed mid-fade (snaps): {len(snaps)}   reveal gaps ms: min {min(gaps):.0f} median {sorted(gaps)[len(gaps)//2]:.0f}")
frames = trace["frames"]
dts = [b["t"] - a["t"] for a, b in zip(frames, frames[1:])]
long = [d for d in dts if d > 34]
print(f"rAF frames: {len(frames)}  long frames >34ms: {len(long)}  worst {max(dts):.0f}ms")
