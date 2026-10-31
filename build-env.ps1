# Sets up a build environment for LemonServer: Qt 6 (MSVC 2022) in the current PowerShell session.
# Usage:  . .\build-env.ps1 [-QtRoot <path to Qt\6.x.y\msvc2022_64>]
param(
    [string]$QtRoot = "D:\Qt\6.8.3\msvc2022_64"
)
$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$vs = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vs) { throw "Visual Studio with C++ tools not found" }
$vcvars = Join-Path $vs "VC\Auxiliary\Build\vcvars64.bat"
cmd /c "`"$vcvars`" >nul && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($matches[1])" -Value $matches[2] }
}
$env:PATH = "$QtRoot\bin;" + $env:PATH
$env:CMAKE_PREFIX_PATH = $QtRoot
