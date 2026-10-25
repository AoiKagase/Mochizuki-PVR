param(
    [string]$Output = "mochizuki.exe"
)

$ErrorActionPreference = "Stop"

$goCommand = Get-Command go -ErrorAction SilentlyContinue
$goExecutable = if ($goCommand) { $goCommand.Source } else { "C:\Program Files\Go\bin\go.exe" }
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    $count = (& git rev-list --count HEAD).Trim()
    $commit = (& git rev-parse --short=12 HEAD).Trim()
    $version = "0.1.0-dev.$count+$commit"
    & git diff --quiet
    if ($LASTEXITCODE -ne 0) {
        $version += ".dirty"
    }

    $date = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $ldflags = "-X mochizuki/internal/version.Number=$version -X mochizuki/internal/version.Commit=$commit -X mochizuki/internal/version.Date=$date"
    & $goExecutable build -ldflags $ldflags -o $Output ./cmd/mochizuki
    if ($LASTEXITCODE -ne 0) {
        throw "go build failed"
    }
    Write-Host "Built Mochizuki PVR $version -> $Output"
}
finally {
    Pop-Location
}
