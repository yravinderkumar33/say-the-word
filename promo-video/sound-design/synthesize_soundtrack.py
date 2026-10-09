#!/usr/bin/env python3
"""Original, deterministic 36-second instrumental; no samples or downloads.

Run with Python + numpy and ffmpeg. Produces a stereo 48 kHz / 24-bit WAV
normalized to -18 LUFS with a -1.5 dBTP ceiling.
"""
from pathlib import Path
import json
import subprocess
import numpy as np

OUT = Path(__file__).resolve().parent
SR = 48_000
DURATION = 36.0
BPM = 100
BEAT = 60 / BPM
N = round(DURATION * SR)
RNG = np.random.default_rng(8472)
mix = np.zeros((N, 2), dtype=np.float64)
music = np.zeros_like(mix)
pluck_bus = np.zeros_like(mix)


def freq(note):
    return 440 * 2 ** ((note - 69) / 12)


def add(bus, wave, start, amp=1.0, pan=0.0):
    begin = round(start * SR)
    end = min(N, begin + len(wave))
    if begin >= N or end <= begin:
        return
    w = wave[:end - begin] * amp
    if w.ndim == 1:
        angle = (pan + 1) * np.pi / 4
        bus[begin:end, 0] += w * np.cos(angle)
        bus[begin:end, 1] += w * np.sin(angle)
    else:
        bus[begin:end] += w


def warm_pad(note, duration, phase):
    t = np.arange(round(duration * SR)) / SR
    f = freq(note)
    # Gentle detuned fundamental, low even harmonic, rounded triangle partial.
    left = (np.sin(2*np.pi*f*t + phase)
            + .31*np.sin(2*np.pi*f*1.0016*t + phase+.3)
            + .14*np.sin(2*np.pi*f*2*t + .2)
            + .045*np.sin(2*np.pi*f*3*t + .4))
    right = (np.sin(2*np.pi*f*.9997*t + phase+.12)
             + .31*np.sin(2*np.pi*f*.9988*t + phase-.3)
             + .14*np.sin(2*np.pi*f*2*t + .27)
             + .045*np.sin(2*np.pi*f*3*t + .6))
    attack = np.minimum(1, t/.55)
    release = np.minimum(1, np.maximum(0, duration-t)/1.15)
    env = np.sin(attack*np.pi/2)**2 * np.sin(release*np.pi/2)**2
    breath = .96 + .04*np.sin(2*np.pi*.18*t + phase)
    return np.stack((left, right), axis=1) * (env*breath)[:, None]


def pluck(note, duration=1.7):
    t = np.arange(round(duration*SR))/SR
    f = freq(note)
    # Rounded electric-piano-like sine pluck; very little high frequency energy.
    tone = (np.sin(2*np.pi*f*t + .035*np.sin(2*np.pi*f*2*t)*np.exp(-t*7))
            + .17*np.sin(2*np.pi*f*2*t)*np.exp(-t*3.5)
            + .045*np.sin(2*np.pi*f*3*t)*np.exp(-t*6))
    env = (1-np.exp(-t*140))*np.exp(-t*3.4)
    env *= np.minimum(1, np.maximum(0,duration-t)/.09)
    return tone*env


def bass(note, duration):
    t = np.arange(round(duration*SR))/SR
    f = freq(note)
    env = (1-np.exp(-t*24))*np.minimum(1,np.maximum(0,duration-t)/.4)
    return (np.sin(2*np.pi*f*t)+.16*np.sin(2*np.pi*f*2*t))*env


def kick():
    t = np.arange(round(.36*SR))/SR
    phase = 2*np.pi*(49*t + 40*.018*(1-np.exp(-t/.018)))
    return np.sin(phase)*(1-np.exp(-t*800))*np.exp(-t*14)


def hat():
    t = np.arange(round(.13*SR))/SR
    noise = RNG.normal(0,1,len(t))
    # A softened shaker rather than an exposed metallic hi-hat.
    rounded = np.convolve(noise, np.ones(9)/9, mode='same')
    high = rounded - np.convolve(rounded, np.ones(31)/31, mode='same')
    return high*np.exp(-t*41)*(1-np.exp(-t*900))


def rim():
    t = np.arange(round(.19*SR))/SR
    click = RNG.normal(0,1,len(t))
    rounded = np.convolve(click,np.ones(19)/19,mode='same')
    tone = np.sin(2*np.pi*174*t)*np.exp(-t*46)
    return (rounded*.30*np.exp(-t*42)+tone*.7)*(1-np.exp(-t*1000))


# Amaj9 / Dmaj9 / F#m7 / Eadd9; a compact, resolved fifteen-bar arc.
# Positions and lengths are beats; the final A major chord resolves at 31.2 s.
chords = [
    (0, 8, 45, [57,61,64,71]),
    (8, 8, 38, [57,61,66,69]),
    (16,8,42, [57,61,64,68]),
    (24,8,40, [56,59,64,66]),
    (32,8,45, [57,61,64,71]),
    (40,8,38, [57,61,66,69]),
    (48,4,40, [56,59,64,66]),
    (52,8,45, [57,61,64,71]),
]

for idx, (start, beats, root, notes) in enumerate(chords):
    duration = beats*BEAT+.9
    for j,note in enumerate(notes):
        add(music,warm_pad(note,duration,idx*.46+j*.67),start*BEAT,.048)
    add(music,bass(root,beats*BEAT+.30),start*BEAT,.104)

# Deliberately sparse pattern leaves room for on-screen copy and possible voice.
for bar in range(14):
    start = bar*4
    current = next(c for c in reversed(chords) if c[0] <= start)
    n = current[3]
    pattern = [(0,n[2]+12), (1.5,n[1]+12), (2.5,n[3]), (3.5,n[0]+12)]
    if bar in (0,1):
        pattern = pattern[:2]
    if bar >= 12:
        pattern = pattern[:2]
    for step,(offset,note) in enumerate(pattern):
        amp = .100 if step in (0,2) else .073
        if bar >= 12:
            amp *= .78
        add(pluck_bus,pluck(note),(start+offset)*BEAT,amp,
            pan=(-.25 if step%2 else .25))

# Soft conclusion: three spread upper notes, followed by a reverb tail.
for j,note in enumerate((64,69,73)):
    add(pluck_bus,pluck(note,2.6),31.2+j*.30,.079,pan=(j-1)*.24)

mix += music + pluck_bus
for delay,level,swap in ((.3,.19,True),(.6,.11,False),(.9,.055,True)):
    d = round(delay*SR)
    wet = pluck_bus[:-d,::-1] if swap else pluck_bus[:-d]
    mix[d:] += wet*level

# A short, quiet stereo ambience from deterministic taps; no external impulses.
ambient = music*.24 + pluck_bus*.64
for delay,level in ((.047,.105),(.081,.075),(.127,.053),(.193,.038),(.271,.028)):
    d = round(delay*SR)
    mix[d:] += ambient[:-d,::-1]*level

# Percussion enters gently after the intro; it leaves before the final resolve.
for beat in range(8,48):
    position = beat*BEAT
    groove = min(1,(beat-7)/8)
    if beat%4 in (0,2):
        add(mix,kick(),position,.16*groove)
    if beat%4 in (1,3):
        add(mix,rim(),position,.032*groove,pan=-.09)
    add(mix,hat(),position+.3,.034*groove,pan=.35 if beat%2 else -.35)
    if beat%4 == 3:
        add(mix,hat(),position+.45,.014*groove,pan=-.25)

# Fade in and finish with an intentional half-second of digital silence.
t = np.arange(N)/SR
fade_in = np.sin(np.minimum(1,t/.65)*np.pi/2)**2
fade_out = np.cos(np.minimum(1,np.maximum(0,t-33.0)/2.6)*np.pi/2)**2
mix *= (fade_in*fade_out)[:,None]
mix[t>=35.6] = 0
mix -= mix.mean(axis=0)
mix[t>=35.6] = 0
peak = np.max(np.abs(mix))
mix *= .71/peak
raw = OUT/'soundtrack-mix.f32'
mix.astype('<f4').tofile(raw)

base = ['ffmpeg','-hide_banner','-nostats','-f','f32le','-ar',str(SR),'-ac','2','-i',str(raw)]
first = subprocess.run(base+['-af','loudnorm=I=-18:TP=-1.5:LRA=7:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
measurement = json.loads(first.stderr[first.stderr.rfind('{'):first.stderr.rfind('}')+1])
filt = ('loudnorm=I=-18:TP=-1.5:LRA=7:linear=true:print_format=json'
        f":measured_I={measurement['input_i']}:measured_TP={measurement['input_tp']}"
        f":measured_LRA={measurement['input_lra']}:measured_thresh={measurement['input_thresh']}"
        f":offset={measurement['target_offset']}")
destination = OUT/'say-the-word-original-36s.wav'
subprocess.run(base+['-af',filt,'-ar',str(SR),'-c:a','pcm_s24le','-y',str(destination)],check=True,capture_output=True,text=True)
verify = subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',str(destination),'-af','loudnorm=I=-18:TP=-1.5:LRA=7:print_format=json','-f','null','-'],capture_output=True,text=True,check=True)
stats = json.loads(verify.stderr[verify.stderr.rfind('{'):verify.stderr.rfind('}')+1])
(OUT/'loudness.json').write_text(json.dumps(stats,indent=2)+'\n')
raw.unlink()
print(destination)
print(json.dumps(stats,indent=2))
