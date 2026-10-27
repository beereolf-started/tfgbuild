# Сборка TfgUpdater.exe: компилятор C# из .NET SDK, программа - под .NET Framework 4.8 (есть в любой Windows 10/11).
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$sdk = (Get-ChildItem 'C:\Program Files\dotnet\sdk' -Directory | Sort-Object Name | Select-Object -Last 1).FullName
$csc = Join-Path $sdk 'Roslyn\bincore\csc.dll'
$fw = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319'
$refs = 'mscorlib', 'System', 'System.Core', 'System.Drawing', 'System.Windows.Forms', 'System.Net.Http',
        'System.IO.Compression', 'System.IO.Compression.FileSystem', 'System.Web.Extensions' |
        ForEach-Object { "-r:$fw\$_.dll" }
$out = Join-Path $here 'TfgUpdater.exe'
& dotnet $csc -nologo -noconfig -nostdlib -target:winexe -langversion:7.3 -optimize+ -platform:anycpu `
    "-out:$out" @refs (Join-Path $here '*.cs')
if ($LASTEXITCODE -ne 0) { throw "сборка не удалась" }
Get-Item $out | Select-Object Name, Length
