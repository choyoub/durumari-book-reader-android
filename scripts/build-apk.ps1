param(
  [ValidateSet("release", "debug")]
  [string]$Variant = "release"
)

$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$dist = Join-Path $root "dist"
$androidAssetsDist = Join-Path $root "mobile\android\app\src\main\assets\dist"
$androidDir = Join-Path $root "mobile\android"
$variantName = $Variant.ToLowerInvariant()
$gradleVariant = [System.Globalization.CultureInfo]::InvariantCulture.TextInfo.ToTitleCase($variantName)
$apk = Join-Path $androidDir "app\build\outputs\apk\$variantName\app-$variantName.apk"
$apkOutputDir = Join-Path $root "apk\$variantName"
$apkOutput = Join-Path $apkOutputDir "durumari-app-$variantName.apk"

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
  $env:NODE_ENV = if ($variantName -eq "release") { "production" } else { "development" }
  & .\gradlew.bat ":app:assemble$gradleVariant"
} finally {
  Pop-Location
}

if (-not (Test-Path -LiteralPath $apk)) {
  throw "$gradleVariant APK was not generated: $apk"
}

if (-not (Test-Path -LiteralPath $apkOutputDir)) {
  New-Item -ItemType Directory -Path $apkOutputDir -Force | Out-Null
}

$resolvedOutputDir = (Resolve-Path -LiteralPath $apkOutputDir).Path
if (-not $resolvedOutputDir.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to write outside workspace: $resolvedOutputDir"
}

Get-ChildItem -LiteralPath $resolvedOutputDir -Filter "*.apk" -Force | Remove-Item -Force
Copy-Item -LiteralPath $apk -Destination $apkOutput -Force

$item = Get-Item -LiteralPath $apkOutput
$hash = Get-FileHash -LiteralPath $apkOutput -Algorithm SHA256
Write-Host ""
Write-Host "$gradleVariant APK: $($item.FullName)"
Write-Host "Size: $($item.Length) bytes"
Write-Host "SHA256: $($hash.Hash)"
