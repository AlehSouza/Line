# Monta o pacote MSIX do Line para a Microsoft Store a partir do build do Tauri.
# A Store assina o pacote na publicação, então aqui ele sai sem assinatura (só serve para enviar).
# Uso: make-msix.ps1 -Version 0.1.123 -IdentityName 12345Fulano.Line -Publisher "CN=..." -PublisherName "Fulano"
param(
  [Parameter(Mandatory)] [string] $Version,
  [Parameter(Mandatory)] [string] $IdentityName,
  [Parameter(Mandatory)] [string] $Publisher,
  [Parameter(Mandatory)] [string] $PublisherName,
  # Nome reservado na Partner Center; precisa ser igual. No menu Iniciar o app continua "Line".
  [string] $DisplayName = "Line",
  [string] $Release = "target/release",
  [string] $Out = "target/release/bundle/msix"
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$msix = Join-Path $here "../src-tauri/msix"

# O Tauri 2 dá ao executável o nome do produto (Line.exe); versões antigas usavam o do pacote Cargo.
$exe = @("Line.exe", "line-desktop.exe") | Where-Object { Test-Path (Join-Path $Release $_) } | Select-Object -First 1
if (-not $exe) { throw "Executável do Line não encontrado em $Release" }

$stage = Join-Path $Out "stage"
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $stage "Assets") | Out-Null
Copy-Item (Join-Path $Release $exe) $stage
Get-ChildItem $Release -Filter *.dll -ErrorAction SilentlyContinue | Copy-Item -Destination $stage
Copy-Item (Join-Path $msix "Assets/*") (Join-Path $stage "Assets")

# A Store exige quatro números com o último zero (0.1.123 -> 0.1.123.0).
$v = "$Version.0"
$xml = Get-Content (Join-Path $msix "AppxManifest.xml") -Raw
$esc = { param($s) [System.Security.SecurityElement]::Escape($s) }
$xml = $xml.Replace("{{IDENTITY_NAME}}", (& $esc $IdentityName)).Replace("{{PUBLISHER}}", (& $esc $Publisher)).Replace("{{PUBLISHER_NAME}}", (& $esc $PublisherName)).Replace("{{DISPLAY_NAME}}", (& $esc $DisplayName)).Replace("{{VERSION}}", $v).Replace("{{EXE}}", $exe)
Set-Content -Path (Join-Path $stage "AppxManifest.xml") -Value $xml -Encoding UTF8

$makeappx = Get-ChildItem "${env:ProgramFiles(x86)}\Windows Kits\10\bin\*\x64\makeappx.exe" | Sort-Object FullName -Descending | Select-Object -First 1
if (-not $makeappx) { throw "makeappx.exe (Windows SDK) não encontrado" }
$file = Join-Path $Out "Line_${Version}_x64.msix"
& $makeappx.FullName pack /o /d $stage /p $file
if ($LASTEXITCODE -ne 0) { throw "makeappx falhou" }
Remove-Item $stage -Recurse -Force
Write-Host "Pacote da Store: $file"
