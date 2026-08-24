# dsh-oc-tui automatic installer for Windows.
#
# One-command setup of the dsh-oc-tui terminal UI plugin:
#   powershell -ExecutionPolicy Bypass -Command "iwr https://raw.githubusercontent.com/rayafriandion/dsh-oc-tui/main/install.ps1 -OutFile install.ps1; & .\install.ps1"
# or, from a checkout:
#   .\install.ps1
[CmdletBinding()]
param(
    [switch]$Local,
    [string]$Source,
    [string]$Profile,
    [switch]$Launcher,
    [switch]$Help
)

$ErrorActionPreference = 'Stop'

$Repo = 'rayafriandion/dsh-oc-tui'
$DshPackage = '@deepseek-ai/dsh'
$NodeMinMajor = 22

if (-not $Profile) {
    $Profile = if ($env:DSH_TUI_PROFILE) { $env:DSH_TUI_PROFILE } else { 'tui' }
}
if (-not $Source) {
    $Source = "github:$Repo"
}
if ($Local) {
    $Source = '.'
}

function Write-Step([string]$Message) {
    Write-Host '[dsh-oc-tui] ' -ForegroundColor Cyan -NoNewline
    Write-Host $Message
}
function Write-Warn([string]$Message) {
    Write-Host '[dsh-oc-tui] ' -ForegroundColor Yellow -NoNewline
    Write-Host $Message
}
function Write-Die([string]$Message) {
    Write-Host '[dsh-oc-tui] ' -ForegroundColor Red -NoNewline
    Write-Host $Message
    exit 1
}

function Show-Help {
    @'
Usage: install.ps1 [options]

Automatic installer for the dsh-oc-tui terminal UI plugin.

Options:
  -Local            install from this checkout (.) instead of GitHub
  -Source <spec>    install a custom source (e.g. dsh-oc-tui for the npm
                    registry, github:you/dsh-oc-tui, or .\dsh-oc-tui-0.1.0.tgz)
  -Profile <name>   dsh profile to install into (default: tui, or $env:DSH_TUI_PROFILE)
  -Launcher         also install the dsh-oc-tui launcher command globally
  -Help             show this help
'@ | Write-Host
}

if ($Help) { Show-Help; exit 0 }

function Run([string]$Program, [string[]]$Arguments) {
    Write-Host "  > $Program $($Arguments -join ' ')" -ForegroundColor DarkGray
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[dsh-oc-tui] '$Program' failed with exit code $LASTEXITCODE" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Step 'checking prerequisites...'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Die "Node.js is not installed - install Node.js >= $NodeMinMajor first: https://nodejs.org/"
}

$nodeVersion = (node --version)
$nodeMajor = 0
if ($nodeVersion -match '^v?(\d+)') {
    $nodeMajor = [int]$Matches[1]
}
if ($nodeMajor -lt $NodeMinMajor) {
    Write-Die "Node.js >= $NodeMinMajor is required (found: $nodeVersion)."
}

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
    Write-Warn 'pnpm not found - installing it globally via npm...'
    Run 'npm' @('install', '-g', 'pnpm')
}

if (Get-Command dsh -ErrorAction SilentlyContinue) {
    Write-Step "installing $Source into profile '$Profile'..."
    Run 'dsh' @('plugin', '--profile', $Profile, 'add', $Source)
} else {
    Write-Warn 'dsh CLI not found - using npx fallback for this install.'
    Write-Step "installing $Source into profile '$Profile'..."
    Run 'npx' @('--yes', $DshPackage, 'plugin', '--profile', $Profile, 'add', $Source)
}

if ($Launcher) {
    Write-Step 'installing the dsh-oc-tui launcher globally...'
    Run 'npm' @('install', '-g', $Source)
}

Write-Host ''
Write-Host 'Install complete. Launch it with:' -ForegroundColor Green
Write-Host "  dsh --profile $Profile"
if ($Launcher) {
    Write-Host 'or the convenience launcher:'
    Write-Host '  dsh-oc-tui'
} else {
    Write-Host 'To add the convenience launcher, rerun with -Launcher or run:'
    Write-Host "  npm install -g $Source"
}
