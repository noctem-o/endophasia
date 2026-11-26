"""Synthesises the promo soundtrack from the shared timeline (numpy only).

    python3 audio.py out/soundtrack.wav

Layers: rain bed, storm drone, key clicks timed to the typed text, thunder on
each lightning cue, a 100 BPM score (Dm - Bb - F - C) that starts with the
title, UI plucks on every card and a D major resolve on the call to action.
Everything is derived from timeline.js, so sound and picture stay in sync.
"""
import json
import pathlib
import sys
import wave

import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
TL = json.loads((HERE / "timeline.js").read_text().split("window.TL =")[1].strip().rstrip(";"))
C = TL["cues"]
SR = 48000
DUR = TL["duration"]
N = int(SR * DUR)
T = np.arange(N) / SR
rng = np.random.default_rng(7)

L = np.zeros(N)
R = np.zeros(N)
wet = np.zeros(N)  # mono reverb send


def clamp(x, a=0.0, b=1.0):
    return np.minimum(b, np.maximum(a, x))


def P(t, a, b):
    return clamp((t - a) / (b - a))


def spectral(x, lo=None, hi=None, order=4):
    """Smooth band-pass in the frequency domain."""
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(len(x), 1 / SR) + 1e-9
    g = np.ones_like(f)
    if hi:
        g /= 1 + (f / hi) ** order
    if lo:
        g /= 1 + (lo / f) ** order
    return np.fft.irfft(X * g, len(x))


def place(sig, at, gain=1.0, pan=0.0, send=0.0):
    i = int(at * SR)
    if i >= N:
        return
    s = sig[: N - i] * gain
    L[i : i + len(s)] += s * np.sqrt(0.5 * (1 - pan))
    R[i : i + len(s)] += s * np.sqrt(0.5 * (1 + pan))
    wet[i : i + len(s)] += s * send


def tt(dur):
    return np.arange(int(dur * SR)) / SR


def note(name):
    names = {"C": 0, "C#": 1, "Db": 1, "D": 2, "Eb": 3, "E": 4, "F": 5, "F#": 6, "G": 7, "Ab": 8, "A": 9, "Bb": 10, "B": 11}
    pc, octv = name[:-1], int(name[-1])
    return 440.0 * 2 ** ((names[pc] + 12 * (octv + 1) - 69) / 12)


def additive(freq, t, harmonics=14, tilt=1.4, detune=(0.0,)):
    out = np.zeros_like(t)
    for d in detune:
        f0 = freq * (1 + d)
        ph = rng.uniform(0, 2 * np.pi)
        for n in range(1, harmonics + 1):
            if f0 * n > 9000:
                break
            out += np.sin(2 * np.pi * f0 * n * t + ph * n) / n**tilt
    return out / len(detune)


def adsr(t, a, d, s, r, length):
    e = np.where(t < a, t / a, s + (1 - s) * np.exp(-(t - a) / d))
    rel = clamp((t - (length - r)) / r)
    return e * (1 - rel)


# ---- storm intensity (same curve as scene.html) --------------------------
storm = clamp(1 - 0.55 * P(T, 10.5, 14) + 0.4 * P(T, 20.8, 21.6) - 0.4 * P(T, 23, 25) - 0.5 * P(T, 39, 43))
fade_in = P(T, 0, 0.6)

# ---- rain bed ----------------------------------------------------------
for ch in (L, R):
    n = rng.standard_normal(N)
    rain = spectral(n, lo=700, hi=7000, order=2) * 0.05
    patter = spectral(rng.standard_normal(N) * (rng.random(N) < 0.004), lo=2500, hi=9000) * 0.6
    rumble = spectral(rng.standard_normal(N), hi=110, order=4) * 0.25
    ch += (rain + patter + rumble * 0.6) * (0.25 + 0.75 * storm) * fade_in

# ---- opening drone (0 -> title) -----------------------------------------
t = tt(C["title"] + 1.5)
drone = additive(note("D2"), t, 10, 1.6, (-0.003, 0.0, 0.004)) + 0.6 * additive(note("A2"), t, 8, 1.7, (-0.002, 0.003))
swell = (0.35 + 0.65 * P(t, 0, C["bolt1"])) * (1 - P(t, C["title"], C["title"] + 1.2)) * (0.85 + 0.15 * np.sin(2 * np.pi * 0.25 * t))
drone = spectral(drone, hi=900, order=2) * swell
place(drone, 0, 0.12, 0, 0.3)

# ---- key clicks ----------------------------------------------------------
def click():
    t = tt(0.045)
    body = spectral(rng.standard_normal(len(t)), lo=1800, hi=8000, order=2) * np.exp(-t / 0.006)
    thock = np.sin(2 * np.pi * rng.uniform(170, 230) * t) * np.exp(-t / 0.012) * 0.5
    return body + thock


for seg in TL["typing"]:
    for i, chr_ in enumerate(seg["text"]):
        at = seg["start"] + i / seg["cps"] + rng.uniform(-0.008, 0.008)
        g = 0.0 if chr_ == " " else rng.uniform(0.18, 0.28)
        place(click(), at, g * (1.25 if chr_ in "'*+" else 1), rng.uniform(-0.25, 0.25), 0.05)
    place(click(), seg["start"] + len(seg["text"]) / seg["cps"] + 0.18, 0.34, 0, 0.08)  # enter

# ---- stingers -------------------------------------------------------------
def pluck(freq, dur=1.2, bright=1.0):
    t = tt(dur)
    s = additive(freq, t, 8, 2.2 - 0.6 * bright, (0.0, 0.002))
    return s * np.exp(-t / (dur * 0.28)) * clamp(t / 0.004)


def sour_hit():
    t = tt(2.2)
    chord = sum(additive(note(n), t, 9, 1.3, (-0.004, 0.004)) for n in ("D3", "Eb3", "Ab3", "D4"))
    thump = np.sin(2 * np.pi * (55 + 60 * np.exp(-t / 0.05)) * t) * np.exp(-t / 0.35)
    return chord * np.exp(-t / 0.55) * clamp(t / 0.006) * 0.35 + thump * 0.9


def thunder(seed):
    r = np.random.default_rng(seed)
    t = tt(5.0)
    crack = spectral(r.standard_normal(len(t)), lo=300, hi=6000, order=2) * np.exp(-t / 0.09) * clamp(t / 0.002)
    flick = 1 + 0.8 * (np.abs(t - 0.17) < 0.05)
    rum = spectral(r.standard_normal(len(t)), lo=32, hi=160, order=4)
    rum *= (1 - np.exp(-t / 0.15)) * np.exp(-t / 1.4) * (0.7 + 0.3 * np.sin(2 * np.pi * 1.7 * t + 1))
    return crack * flick * 0.9 + rum * 3.2


place(sour_hit(), C["out20"], 0.5, 0, 0.35)
place(pluck(note("A5"), 0.5), C["out0"], 0.12, 0.2, 0.2)
for k, b in enumerate(TL["bolts"]):
    place(thunder(11 + k), b, 0.75, -0.15 + 0.3 * k, 0.4)

# title bloom: reversed-swell into a Dm9 pad
t = tt(4.0)
bloom = sum(additive(note(n), t, 10, 1.5, (-0.004, 0.0, 0.005)) for n in ("D3", "A3", "F4", "C5", "E5"))
bloom = spectral(bloom, hi=2600, order=2) * adsr(t, 0.05, 1.2, 0.25, 1.5, 4.0)
place(bloom, C["title"], 0.11, 0, 0.6)
pre = tt(0.6)
place(spectral(rng.standard_normal(len(pre)), lo=900, hi=5000) * (pre / 0.6) ** 3, C["title"] - 0.6, 0.12, 0, 0.3)

# UI plucks: cards, lanes, board rows, captions
scale = ["D5", "F5", "A5", "C6", "D6", "F6"]
for i, k in enumerate(("plan", "receipt", "ledger")):
    place(pluck(note(scale[i * 2])), C[k], 0.13, -0.3 + 0.3 * i, 0.4)
place(pluck(note("A5"), 0.8), C["receiptOk"], 0.10, 0.2, 0.3)
for i in range(4):
    place(pluck(note(scale[i + 1]), 0.9), C[f"lane{i}"], 0.11, -0.45 + 0.3 * i, 0.4)
    place(pluck(note(scale[i]), 0.5, 0.4), C[f"row{i}"], 0.07, 0.3, 0.3)

# ledger failure: low minor-second hit under the thunder
t = tt(2.5)
fail = (additive(note("A2"), t, 10, 1.2) + additive(note("Bb2"), t, 10, 1.2)) * np.exp(-t / 0.7) * clamp(t / 0.01)
place(fail, C["fail"], 0.16, 0, 0.4)

# ---- score: 100 BPM, Dm - Bb - F - C ----------------------------------
m = TL["music"]
beat = 60 / m["bpm"]
start, resolve = m["start"], m["resolve"]
chords = {"Dm": ("D3", "A3", "F4", "A4"), "Bb": ("Bb2", "F3", "D4", "F4"), "F": ("F3", "A3", "C4", "A4"), "C": ("C3", "G3", "E4", "G4")}
roots = {"Dm": "D2", "Bb": "Bb1", "F": "F2", "C": "C2"}
bar = 4 * beat
nbar = int(np.ceil((resolve - start) / bar))
for b in range(nbar):
    name = m["chords"][b % 4]
    at = start + b * bar
    length = min(bar + 0.4, resolve - at + 0.3)
    if length <= 0:
        break
    t = tt(length)
    pad = sum(additive(note(n), t, 9, 1.6, (-0.004, 0.0, 0.005)) for n in chords[name])
    pad = spectral(pad, hi=1500 + 900 * P(at, 14, 33), order=2) * adsr(t, 0.35, 1.0, 0.7, 0.4, length)
    place(pad, at, 0.055 + 0.03 * P(at, 24, 33), 0, 0.5)
    if at >= C["plan"] - 0.01:  # bass enters with the evidence
        for k in (0, 2.5):
            bt = tt(beat * 1.4)
            bass = additive(note(roots[name]), bt, 5, 1.8) * np.exp(-bt / 0.45) * clamp(bt / 0.008)
            place(bass, at + k * beat, 0.32, 0, 0.05)

def kick():
    t = tt(0.4)
    return np.sin(2 * np.pi * np.cumsum(48 + 90 * np.exp(-t / 0.035)) / SR) * np.exp(-t / 0.16)


def hat():
    t = tt(0.06)
    return spectral(rng.standard_normal(len(t)), lo=7000, order=2) * np.exp(-t / 0.012)


nbeat = int((resolve - start) / beat)
for k in range(nbeat):
    at = start + k * beat
    duck = 0.35 if C["fail"] - 0.2 <= at <= C["fail"] + 1.2 else 1.0
    if at >= C["plan"] - 0.01:
        place(kick(), at, 0.55 * duck, 0, 0.02)
    if at >= C["lanes"] - 0.01:
        place(hat(), at + beat / 2, 0.09 * duck, 0.3, 0.05)
        place(hat(), at, 0.05 * duck, -0.3, 0.05)

# laws: boom + bell on each line
for i in range(4):
    at = C[f"law{i}"]
    t = tt(1.6)
    boom = np.sin(2 * np.pi * np.cumsum(40 + 50 * np.exp(-t / 0.06)) / SR) * np.exp(-t / 0.5)
    place(boom, at, 0.6, 0, 0.2)
    place(pluck(note(["D5", "F5", "A5", "D6"][i]), 1.6, 0.8), at, 0.14, 0, 0.6)

# resolve: D major, ringing out
t = tt(DUR - resolve)
res = sum(additive(note(n), t, 10, 1.5, (-0.004, 0.0, 0.005)) for n in ("D2", "D3", "A3", "F#4", "A4", "D5"))
res = spectral(res, hi=3000, order=2) * adsr(t, 0.03, 1.5, 0.45, 2.5, len(t) / SR)
place(res, resolve, 0.09, 0, 0.6)
place(pluck(note("F#6"), 3.0, 0.9), resolve, 0.12, 0.25, 0.7)
place(pluck(note("D6"), 3.0, 0.9), C["url"], 0.08, -0.25, 0.7)

# ---- reverb + master -----------------------------------------------------
ir_t = tt(2.4)
ir = rng.standard_normal(len(ir_t)) * np.exp(-ir_t / 0.55)
ir = spectral(ir, hi=5000, order=2)
ir /= np.sqrt(np.sum(ir**2))
size = 1 << int(np.ceil(np.log2(N + len(ir))))
verb = np.fft.irfft(np.fft.rfft(wet, size) * np.fft.rfft(ir, size), size)[:N] * 0.6
L += verb
R += np.roll(verb, int(0.011 * SR))

out = np.stack([L, R], axis=1)
out *= (1 - P(T, DUR - 0.8, DUR))[:, None]
out = np.tanh(out * 1.4) / 1.4
out *= 0.89 / np.max(np.abs(out))
dest = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else HERE / "out/soundtrack.wav")
dest.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(dest), "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((out * 32767).astype("<i2").tobytes())
print("soundtrack ->", dest)
