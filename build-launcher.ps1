$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $csc)) {
    throw "csc.exe not found: $csc"
}

$source = Join-Path $root 'launcher\start-shim.cs'
$output = Join-Path $root 'start-shim.exe'

& $csc /nologo /target:winexe /optimize+ /codepage:65001 /r:System.Windows.Forms.dll "/out:$output" $source
if ($LASTEXITCODE -ne 0) {
    throw "build failed with exit code $LASTEXITCODE"
}

Write-Host "built: $output"
