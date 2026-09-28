<#
.SYNOPSIS
Turns a walkaround video (or a folder of photos) of one room into a Gaussian splat .ply for RoomTwin.

.DESCRIPTION
ffmpeg extracts frames, COLMAP solves camera poses and undistorts, Brush trains the splat.
With -Spz the result is also converted to .spz using tools/capture/ply-to-spz.mjs.
See tools/capture/README.md for installing the tools and shooting the video.

.EXAMPLE
.\tools\capture\capture.ps1 -Source D:\captures\living.mp4 -Name living_room -Spz
#>
param(
  [Parameter(Mandatory = $true)][string]$Source,
  [string]$Name,
  [string]$WorkDir,
  [double]$Fps = 2,
  [int]$Steps = 30000,
  [int]$MaxImageSize = 1600,
  [switch]$Spz,
  [string]$Ffmpeg = "ffmpeg",
  [string]$Colmap = "colmap",
  [string]$Brush = "brush_app"
)

$ErrorActionPreference = "Stop"

function Invoke-Step([string]$Label, [string]$Exe, [string[]]$Arguments) {
  Write-Host "==> $Label"
  # COLMAP logs to stderr, which Windows PowerShell turns into errors under "Stop" when output is redirected.
  $ErrorActionPreference = "Continue"
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit code $LASTEXITCODE). Command: $Exe $($Arguments -join ' ')" }
}

function Resolve-Tool([string]$Exe, [string]$Hint) {
  if (Get-Command $Exe -ErrorAction SilentlyContinue) { return }
  throw "Cannot find '$Exe'. $Hint"
}

if (-not (Test-Path -LiteralPath $Source)) { throw "Source not found: $Source" }
$Source = (Resolve-Path -LiteralPath $Source).Path
$isVideo = -not (Test-Path -LiteralPath $Source -PathType Container)
if (-not $Name) {
  $Name = if ($isVideo) { [IO.Path]::GetFileNameWithoutExtension($Source) } else { [IO.Path]::GetFileName($Source.TrimEnd('\')) }
}
if (-not $WorkDir) { $WorkDir = Join-Path (Get-Location) "roomtwin-capture\$Name" }
# Windows PowerShell passes a quoted path ending in \ to native tools as an escaped quote.
$WorkDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($WorkDir).TrimEnd('\')

if ($isVideo) { Resolve-Tool $Ffmpeg "Install it with 'winget install Gyan.FFmpeg' or pass -Ffmpeg <path to ffmpeg.exe>." }
Resolve-Tool $Colmap "Download COLMAP from https://github.com/colmap/colmap/releases and pass -Colmap <path to colmap.exe>, or add it to PATH."
Resolve-Tool $Brush "Download Brush from https://github.com/ArthurBrussee/brush/releases and pass -Brush <path to brush_app.exe>, or add it to PATH."
if ($Spz) {
  Resolve-Tool "node" "-Spz needs Node.js 20 or newer: 'winget install OpenJS.NodeJS.LTS'."
  $repo = Split-Path (Split-Path $PSScriptRoot)
  if (-not (Test-Path -LiteralPath (Join-Path $repo "node_modules\@sparkjsdev\spark"))) {
    throw "-Spz needs the repo's packages. Run 'npm ci' once in $repo."
  }
}

$images = Join-Path $WorkDir "images"
$database = Join-Path $WorkDir "database.db"
$sparse = Join-Path $WorkDir "sparse"
$dataset = Join-Path $WorkDir "dataset"
$ply = Join-Path $WorkDir "$Name.ply"
if (Test-Path -LiteralPath $WorkDir) {
  throw "$WorkDir already exists. Delete it or pass a different -WorkDir so an old run is not mixed into this one."
}
New-Item -ItemType Directory -Force $images, $sparse | Out-Null

if ($isVideo) {
  # Frames are scaled down here because COLMAP and Brush both work at this size anyway.
  $scale = "fps=$Fps,scale='min($MaxImageSize,iw)':'min($MaxImageSize,ih)':force_original_aspect_ratio=decrease"
  Invoke-Step "Extracting frames at $Fps fps" $Ffmpeg @("-hide_banner", "-loglevel", "error", "-i", $Source, "-vf", $scale, "-q:v", "2", (Join-Path $images "frame_%05d.jpg"))
} else {
  Get-ChildItem -LiteralPath $Source -File | Where-Object { $_.Extension -match '^\.(jpe?g|png)$' } | Copy-Item -Destination $images
}
$frameCount = (Get-ChildItem -LiteralPath $images -File).Count
if ($frameCount -lt 20) { throw "Only $frameCount images to work with. Use a longer video, a higher -Fps, or more photos (aim for 100 to 300)." }
Write-Host "    $frameCount images"

Invoke-Step "COLMAP feature extraction" $Colmap @("feature_extractor", "--database_path", $database, "--image_path", $images,
  "--ImageReader.camera_model", "OPENCV", "--ImageReader.single_camera", "1", "--FeatureExtraction.max_image_size", "$MaxImageSize")
# Trying every pair is what lets COLMAP close loops around a room; past a few hundred images it gets slow,
# and ordered video frames can make do with matching their neighbours.
$matcher = if ($isVideo -and $frameCount -gt 400) { "sequential_matcher" } else { "exhaustive_matcher" }
Invoke-Step "COLMAP matching ($matcher)" $Colmap @($matcher, "--database_path", $database)
Invoke-Step "COLMAP mapping" $Colmap @("mapper", "--database_path", $database, "--image_path", $images, "--output_path", $sparse)

# The mapper can split a poor capture into several models; the largest one is the room.
$models = Get-ChildItem -LiteralPath $sparse -Directory | Sort-Object { (Get-Item -LiteralPath (Join-Path $_.FullName "images.bin")).Length } -Descending
if (-not $models) { throw "COLMAP could not reconstruct any cameras. The video probably moves too fast or shows too many blank walls; see tools/capture/README.md." }
if ($models.Count -gt 1) { Write-Warning "COLMAP split the capture into $($models.Count) pieces; using the largest. Parts of the room may be missing." }

Invoke-Step "COLMAP undistortion" $Colmap @("image_undistorter", "--image_path", $images, "--input_path", $models[0].FullName,
  "--output_path", $dataset, "--output_type", "COLMAP")

$registered = (Get-ChildItem -LiteralPath (Join-Path $dataset "images") -File).Count
Write-Host "    COLMAP placed $registered of $frameCount images"
if ($registered -lt $frameCount * 0.6) {
  Write-Warning "Only $registered of $frameCount images could be placed, so parts of the room will be blurry or missing. Reshoot slower with more overlap; see tools/capture/README.md."
}

# Brush leaves a GPU autotune cache in the current folder.
Push-Location -LiteralPath $WorkDir
try {
  Invoke-Step "Brush training ($Steps steps)" $Brush @($dataset, "--total-steps", "$Steps", "--export-every", "$Steps",
    "--export-path", $WorkDir, "--export-name", "$Name.ply")
} finally {
  Pop-Location
}
if (-not (Test-Path -LiteralPath $ply)) { throw "Brush finished without writing $ply." }

$result = $ply
if ($Spz) {
  $script = Join-Path $PSScriptRoot "ply-to-spz.mjs"
  Invoke-Step "Converting to .spz" "node" @($script, $ply)
  $result = [IO.Path]::ChangeExtension($ply, ".spz")
  if (-not (Test-Path -LiteralPath $result)) { throw "The .spz conversion finished without writing $result." }
}
Write-Host ""
Write-Host "Done: $result"
Write-Host "Copy it to /config/www/roomtwin/ on Home Assistant and point the card at /local/roomtwin/$([IO.Path]::GetFileName($result))"
