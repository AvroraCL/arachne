param(
    [Parameter(Mandatory = $true)][string]$Installer,
    [Parameter(Mandatory = $true)][string]$PortableExecutable
)

$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') {
    throw 'Run installer acceptance in a fresh Windows CI account'
}

$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Arachne'
if (Test-Path -LiteralPath $uninstallKey) { throw 'The test account already has Arachne installed' }
$root = Join-Path $env:RUNNER_TEMP ('阿拉克涅 安装验收 ' + [guid]::NewGuid())
$app = Join-Path $root '应用 文件'
$profile = Join-Path $root '工程 数据'
$executable = Join-Path $app 'Arachne.exe'
$uninstaller = Join-Path $app 'Uninstall.exe'
$shortcut = Join-Path ([Environment]::GetFolderPath('Programs')) '阿拉克涅\阿拉克涅.lnk'
New-Item -ItemType Directory -Path $root | Out-Null

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;

public static class ShortcutPath {
    [ComImport, Guid("000214F9-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW {
        void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int capacity, IntPtr data, uint flags);
    }
    public static string Read(string link) {
        var instance = Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("00021401-0000-0000-C000-000000000046")));
        try {
            ((IPersistFile)instance).Load(link, 0);
            var target = new StringBuilder(260);
            ((IShellLinkW)instance).GetPath(target, target.Capacity, IntPtr.Zero, 0);
            return target.ToString();
        } finally { Marshal.FinalReleaseComObject(instance); }
    }
}
'@

function Install-Arachne {
    # NSIS consumes the remainder of the command line as the unquoted path.
    $result = Start-Process -FilePath $Installer -ArgumentList "/S /D=$app" -Wait -PassThru
    if ($result.ExitCode -ne 0) { throw "Installer exited with $($result.ExitCode)" }
    if (!(Test-Path -LiteralPath $executable) -or !(Test-Path -LiteralPath $uninstaller)) {
        throw 'The installer did not publish the executable and uninstaller'
    }
}

try {
    Install-Arachne
    if ((Get-FileHash -LiteralPath $executable).Hash -ne (Get-FileHash -LiteralPath $PortableExecutable).Hash) {
        throw 'The installed executable differs from the verified portable bundle'
    }
    if ((Get-ItemProperty -LiteralPath $uninstallKey).InstallLocation -ne $app) {
        throw 'The Windows uninstall entry points to a different folder'
    }
    if ((Get-ItemProperty -LiteralPath $uninstallKey).DisplayName -cne '阿拉克涅') {
        throw 'The Windows uninstall entry does not preserve the Chinese product name'
    }
    if (!(Test-Path -LiteralPath $shortcut)) { throw 'The Start menu shortcut is missing' }
    $target = [ShortcutPath]::Read($shortcut)
    if ($target -ne $executable) { throw "The Start menu shortcut points to '$target', expected '$executable'" }
    Write-Host 'PASS installer, Chinese install location, executable hash and Start menu shortcut'

    $env:ARACHNE_DESKTOP_TEST_PROFILE = $profile
    node tests/windows-desktop-integration.mjs $executable
    if ($LASTEXITCODE -ne 0) { throw 'The installed application failed desktop acceptance' }

    $settings = Join-Path $profile 'desktop.json'
    $projectId = (Get-Content -LiteralPath $settings -Raw | ConvertFrom-Json).project
    $project = Join-Path $profile "data\projects\$projectId\project.json"
    $savedSettings = (Get-FileHash -LiteralPath $settings).Hash
    $savedProject = (Get-FileHash -LiteralPath $project).Hash
    Install-Arachne
    if ((Get-FileHash -LiteralPath $settings).Hash -ne $savedSettings -or
        (Get-FileHash -LiteralPath $project).Hash -ne $savedProject) {
        throw 'Reinstall changed the existing project or desktop settings'
    }

    $result = Start-Process -FilePath $uninstaller -ArgumentList '/S' -Wait -PassThru
    if ($result.ExitCode -ne 0 -or (Test-Path -LiteralPath $executable) -or
        (Test-Path -LiteralPath $uninstallKey) -or (Test-Path -LiteralPath $shortcut)) {
        throw 'Uninstall left the program or its Windows entries installed'
    }
    if ((Get-FileHash -LiteralPath $settings).Hash -ne $savedSettings -or
        (Get-FileHash -LiteralPath $project).Hash -ne $savedProject) {
        throw 'Uninstall changed the existing project or desktop settings'
    }
    Write-Host 'PASS reinstall and uninstall preserve the project and desktop settings'
} finally {
    Remove-Item Env:ARACHNE_DESKTOP_TEST_PROFILE -ErrorAction SilentlyContinue
}
