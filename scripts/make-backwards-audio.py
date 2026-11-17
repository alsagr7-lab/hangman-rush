#!/usr/bin/env python3
"""Backwards Rush (party): the spoken word for every entry in content/party/backwards.json, as a small MP3 in
site/party/bw/<id>.mp3. The phone of the player whose turn it is plays it backwards; the big screen plays it forwards
at the end of the turn. Files that already exist are kept; pass --all to make them all again.

Needs: pip install espeakng-loader (eSpeak NG with its voices, GPL-3.0; only this script uses it, the site just serves
the MP3 files it makes) and ffmpeg with libmp3lame.
    python3 scripts/make-backwards-audio.py
"""
import ctypes, json, os, subprocess, sys, tempfile, wave

import espeakng_loader

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "content", "party", "backwards.json")
OUT = os.path.join(ROOT, "site", "party", "bw")
VOICES = {"en": "en-us", "ar": "ar"}

lib = ctypes.CDLL(espeakng_loader.get_library_path())
SYNTH_CB = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.POINTER(ctypes.c_short), ctypes.c_int, ctypes.c_void_p)
lib.espeak_Initialize.restype = ctypes.c_int
lib.espeak_Initialize.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
lib.espeak_SetSynthCallback.argtypes = [SYNTH_CB]
lib.espeak_SetVoiceByName.argtypes = [ctypes.c_char_p]
lib.espeak_SetParameter.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
lib.espeak_Synth.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_void_p, ctypes.c_void_p]
lib.espeak_Synchronize.restype = ctypes.c_int

AUDIO_OUTPUT_SYNCHRONOUS, POS_CHARACTER, CHARS_UTF8, RATE, PITCH = 2, 1, 1, 1, 3
rate = lib.espeak_Initialize(AUDIO_OUTPUT_SYNCHRONOUS, 500, espeakng_loader.get_data_path().encode(), 0)
if rate <= 0:
    sys.exit("eSpeak NG didn't start")

samples = []

@SYNTH_CB
def on_audio(wav, n, events):
    if n > 0:
        samples.extend(wav[:n])
    return 0

lib.espeak_SetSynthCallback(on_audio)


def speak(text, lg):
    samples.clear()
    lib.espeak_SetVoiceByName(VOICES[lg].encode())
    lib.espeak_SetParameter(RATE, 135, 0)   # a little slower than normal, so the backwards clip is easier to copy
    lib.espeak_SetParameter(PITCH, 50, 0)
    b = text.encode("utf-8") + b"\0"
    buf = ctypes.create_string_buffer(b)
    lib.espeak_Synth(buf, len(b), 0, POS_CHARACTER, 0, CHARS_UTF8, None, None)
    lib.espeak_Synchronize()
    return list(samples)


def save(pcm, dest):
    # trim the quiet at both ends, so the backwards clip starts straight away
    lim = 400
    s = next((i for i, v in enumerate(pcm) if abs(v) > lim), 0)
    e = len(pcm) - next((i for i, v in enumerate(reversed(pcm)) if abs(v) > lim), 0)
    pcm = pcm[max(0, s - 400):min(len(pcm), e + 800)]
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as f:
        tmp = f.name
    with wave.open(tmp, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(b"".join(int(v).to_bytes(2, "little", signed=True) for v in pcm))
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", tmp, "-ac", "1", "-ar", "22050", "-codec:a", "libmp3lame", "-b:a", "40k", dest], check=True)
    os.unlink(tmp)


def main():
    data = json.load(open(SRC, encoding="utf-8"))
    os.makedirs(OUT, exist_ok=True)
    every = "--all" in sys.argv
    made = 0
    for lg in ("en", "ar"):
        for row in data[lg]:
            wid, word = row[0], row[2]
            say = row[4] if len(row) > 4 and row[4] else word
            dest = os.path.join(OUT, wid + ".mp3")
            if os.path.exists(dest) and not every:
                continue
            pcm = speak(say, lg)
            if len(pcm) < rate * 0.2:
                sys.exit(f"{wid}: no sound for {say!r}")
            save(pcm, dest)
            made += 1
    print(f"made {made} clips in {os.path.relpath(OUT, ROOT)}")


if __name__ == "__main__":
    main()
