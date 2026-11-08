# Windows PowerShell deploy (uses the ssh, scp and tar that ship with Windows 10+).
# Usage:  .\deploy\deploy.ps1 -Target you@sanjaysubramanian.com
param([Parameter(Mandatory=$true)][string]$Target)
$ErrorActionPreference = "Stop"
Set-Location (Join-Path $PSScriptRoot "..")
$tgz = Join-Path $env:TEMP "riffbox.tgz"
tar --exclude=__pycache__ --exclude=.pytest_cache --exclude=.venv --exclude=tests -czf $tgz app static
if ($LASTEXITCODE) { throw "tar failed" }
scp $tgz "${Target}:riffbox.tgz"
if ($LASTEXITCODE) { throw "scp failed" }
$remote = 'rm -rf riffbox-incoming && mkdir riffbox-incoming && tar xzf riffbox.tgz -C riffbox-incoming && doas rsync -rlt --delete --chmod=D755,F644 --chown=root:wheel riffbox-incoming/ /usr/local/riffbox/ && doas rcctl restart riffbox'
ssh $Target $remote
if ($LASTEXITCODE) { throw "remote install failed" }
Write-Host "deployed"
