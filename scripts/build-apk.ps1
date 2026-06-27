$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $root "dist"
$androidAssetsDist = Join-Path $root "mobile\android\app\src\main\assets\dist"
$androidDir = Join-Path $root "mobile\android"
$apk = Join-Path $androidDir "app\build\outputs\apk\release\app-release.apk"

Set-Location $root

npm run build

if (-not (Test-Path -LiteralPath $dist)) {
  throw "Web build output was not found: $dist"
}

if (-not (Test-Path -LiteralPath $androidAssetsDist)) {
  New-Item -ItemType Directory -Path $androidAssetsDist -Force | Out-Null
}

$resolvedRoot = (Resolve-Path -LiteralPath $root).Path
$resolvedAssets = (Resolve-Path -LiteralPath $androidAssetsDist).Path
if (-not $resolvedAssets.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to clean outside workspace: $resolvedAssets"
}

Get-ChildItem -LiteralPath $resolvedAssets -Force | Remove-Item -Recurse -Force
Copy-Item -Path (Join-Path $dist "*") -Destination $resolvedAssets -Recurse -Force

Push-Location $androidDir
try {
  $env:NODE_ENV = "production"
  & .\gradlew.bat :app:assembleRelease
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $apk)) {
  throw "Release APK was not generated: $apk"
}

$item = Get-Item -LiteralPath $apk
$hash = Get-FileHash -LiteralPath $apk -Algorithm SHA256
Write-Host ""
Write-Host "Release APK: $($item.FullName)"
Write-Host "Size: $($item.Length) bytes"
Write-Host "SHA256: $($hash.Hash)"
