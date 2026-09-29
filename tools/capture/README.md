# Capturing a room on a PC

`capture.ps1` turns a phone video of a room into a Gaussian splat on your own Windows PC:

1. ffmpeg pulls frames out of the video.
2. COLMAP works out where the camera was for each frame (feature extraction, matching, mapping) and undistorts the frames.
3. Brush trains the splat on the GPU and writes a `.ply`.
4. With `-Spz`, `ply-to-spz.mjs` shrinks it to `.spz`.

If you have Scaniverse on your phone, that's quicker and gives real-world scale. Use this when you want to train on your own hardware or already have a video.

## What you need

- Windows and a gaming-class GPU. Brush runs on NVIDIA, AMD and Intel GPUs; COLMAP's fast build needs NVIDIA.
- ffmpeg: `winget install Gyan.FFmpeg`
- COLMAP: `colmap-x64-windows-cuda.zip` from [COLMAP releases](https://github.com/colmap/colmap/releases), or `colmap-x64-windows-nocuda.zip` without an NVIDIA card. Unzip it anywhere; the exe is `bin\colmap.exe`.
- Brush: `brush-app-x86_64-pc-windows-msvc.zip` from [Brush releases](https://github.com/ArthurBrussee/brush/releases). Unzip it; the exe is `brush_app.exe`. Tested with Brush 0.3.0 and COLMAP 4.2.0. Older COLMAP 3.x builds use different option names and will fail at feature extraction.
- For `-Spz` only: Node.js 20 or newer, and `npm ci` run once in the root of this repo.

Either add the COLMAP `bin` folder and the Brush folder to PATH, or pass their paths with `-Colmap` and `-Brush`.

## Shooting the video

- Lights on, curtains however you want them to look. The splat bakes in the lighting you film.
- Walk slowly around the room with the phone at chest height, then a lap aimed a little lower and one aimed higher. Keep moving. Standing in one place and turning gives COLMAP nothing to work with.
- Keep something textured in every shot. Blank walls, mirrors, windows and screens are hard.
- Linger on the lamps and devices you want to bind, from a few angles.
- One to three minutes of 1080p or 4K is plenty. Lock the exposure if your camera app lets you.

A folder of 100 to 300 overlapping photos works too.

## Running it

From the repo root in PowerShell:

```powershell
.\tools\capture\capture.ps1 -Source D:\captures\living.mp4 -Name living -Spz `
  -Colmap C:\tools\colmap\bin\colmap.exe -Brush C:\tools\brush\brush_app.exe
```

If PowerShell says running scripts is disabled on this system, start it through `powershell -ExecutionPolicy Bypass -File .\tools\capture\capture.ps1` with the same parameters instead.

Everything goes into `.\roomtwin-capture\living\`: the frames, the COLMAP model, a `target\autotune` cache Brush writes, and the splat. Once the splat is copied to Home Assistant you can delete the folder. For scale, 112 frames took 9 minutes end to end on an RTX 4090, most of it Brush training. The last lines tell you the file to copy:

```
Done: D:\roomtwin\roomtwin-capture\living\living.spz
Copy it to /config/www/roomtwin/ on Home Assistant and point the card at /local/roomtwin/living.spz
```

| Parameter | Default | Meaning |
| --- | --- | --- |
| `-Source` | required | A video file, or a folder of `.jpg`/`.png` photos. iPhone HEIC photos are skipped with a warning, so convert them first. |
| `-Name` | file name of the source | Name of the output file and work folder. |
| `-WorkDir` | `.\roomtwin-capture\<Name>` | Where everything goes. It must not exist yet. |
| `-Fps` | `2` | Frames taken per second of video. Aim for 150 to 300 frames in total. |
| `-Steps` | `30000` | Brush training steps. Fewer is faster and blurrier. |
| `-MaxImageSize` | `1600` | Longest side of the frames, in pixels. Video frames are scaled to it; photos are copied as they are and COLMAP reads them at this size. |
| `-Spz` | off | Also write a `.spz` next to the `.ply`. |
| `-Ffmpeg`, `-Colmap`, `-Brush` | found on PATH | Paths to the tools. |

Up to 400 images, COLMAP compares every pair of frames, which is what lets it join the end of a lap to the start. Longer videos only compare neighbouring frames.

## When it goes wrong

- **COLMAP placed 40 of 200 images**: the rest couldn't be matched, so parts of the room will be missing. Film slower, with more overlap between frames, and avoid pointing at blank surfaces.
- **COLMAP split the capture into pieces**: same cause. The script keeps the biggest piece.
- **COLMAP could not reconstruct any cameras**: nothing matched at all. Usually a video that is too short, too dark, or too blurry.
- **Cannot find 'colmap'** or **'brush_app'**: pass the full path with `-Colmap` or `-Brush`.

The splat comes out upside down and in COLMAP's arbitrary units. The card expects that. Set the floor in the card's edit mode and it will be upright.
