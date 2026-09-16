# discord-mic-switch-fix

**A Vencord plugin that makes Discord's microphone picker actually work on Linux.**

On Linux, Discord's native voice engine ignores the input device you select in
**Voice & Video**. It logs your choice, pretends to switch, and then records from the
PipeWire/PulseAudio *default* source anyway. Nothing changes until you fully restart
Discord — and even then you get whatever the system default happens to be.

This plugin watches Discord's capture stream and reroutes it to the device you actually
picked, live, without a restart.

---

## Root cause (measured, not guessed)

Discord's Linux voice engine is the WebRTC PulseAudio ADM
(`modules/audio_device/linux/audio_device_pulse_linux.cc`), reached through
`discord_voice.node`. Two things go wrong:

1. `SetRecordingDevice(uint16_t index)` refuses to run once recording is initialised
   (`if (_recIsInitialized) return -1;`), and the string/`WindowsDeviceType` overloads
   that Discord's web app uses are stubs on Linux —
   `SetRecordingDevice: Not supported on this platform`.
2. The device *name* the ADM resolves for a non-zero index never makes it onto the
   stream: `pa_stream_connect_record()` ends up with the default source, so the capture
   stream is pinned to the system default no matter what the UI says.

Evidence from `~/.config/discord/logs/discord-webrtc_0` while switching devices in
Voice & Video:

```
Setting audio input device: 'Alder Lake PCH-P High Definition Audio Controller Stereo Microphone'
SetRecordingDevice(1)                              <- index was passed correctly
SetRecordingDevice: Not supported on this platform <- ...via the string overload
Audio input device (id: NoiseTorch ...) initialized in 0 [ms]   <- 0 ms = fake init
```

Meanwhile PipeWire shows where the audio actually comes from:

```
Source Output #67956  source=66 (Digital Microphone = system default)
  application.name = "WEBRTC VoiceEngine"
  media.name       = "recStream"
```

→ the user selected **NoiseTorch**, Discord asked for index 3, and the stream still
recorded from the default source. That is the bug.

## How the fix works

Discord rebuilds its capture stream on every switch, so a one-shot fix races with it.
Instead:

1. The renderer plugin subscribes to `MediaEngineStore` and reads the selected input
   device (`getInputDeviceId()` / `getInputDevices()`).
2. Discord reports devices by their PulseAudio **description**, so the native (Electron
   main process) side maps that description back to a PipeWire source name via
   `pactl -f json list sources` (monitors excluded).
3. A 400 ms watcher moves every `WEBRTC VoiceEngine` capture stream onto the pinned
   source with `pactl move-source-output`, and re-applies it whenever Discord recreates
   the stream.

The actual audio path is changed, so the person on the other end hears the right
microphone — not just a UI label.

## Requirements

- Linux with PipeWire or PulseAudio (`pactl` on `PATH` — `pulseaudio-utils` / `pipewire-pulse`)
- Discord **desktop** (the `native.ts` half needs Electron)
- A **source-built** Vencord (userplugins do not work in the prebuilt release)

## Install

```bash
git clone https://github.com/duckducktw/discord-mic-switch-fix
cp -r discord-mic-switch-fix/MicSwitchFix ~/Applications/Vencord/src/userplugins/
cd ~/Applications/Vencord
pnpm build && pnpm inject
```

Restart Discord, then enable **MicSwitchFix** in *Settings → Vencord → Plugins* and
restart once more so the native half is loaded.

## Usage

Just pick a microphone in *Voice & Video* — it now applies immediately. Choosing
**Default** hands control back to the system default source.

Plugin settings:

| Setting | Default | Effect |
| --- | --- | --- |
| Also make the selected device the system default input | off | Additionally runs `pactl set-default-source`, so *other* apps that only use "default" follow along. Affects other applications; restored on unpin. |
| Log stream reroutes to the console | off | Verbose logging for debugging |

## Verification

`tools/verify.mjs` reproduces Discord's stream out-of-band by opening a `parec` capture
stream named `WEBRTC VoiceEngine` (the same `application.name` Discord registers), then
checks the plugin reroutes it and re-reroutes it after the stream is recreated:

```bash
cd MicSwitchFix && npx esbuild native.ts --bundle --platform=node --format=esm --outfile=/tmp/micswitch-native.mjs
cd ../tools && node verify.mjs
```

Expected: `RESULT: reroute=PASS  re-enforce=PASS`.

## Notes / limitations

- Matching is by PipeWire *description*; if you rename a source's description so it no
  longer matches Discord's device name, the pin is skipped with a toast.
- The watcher only ever touches streams whose `application.name` is
  `WEBRTC VoiceEngine` (or Discord's binary with a capture-like media name). Playback
  streams are never modified.
- If the pinned device disappears, the pin is dropped rather than left pointing at a
  dead target.

## License

GPL-3.0-or-later, same as Vencord.
