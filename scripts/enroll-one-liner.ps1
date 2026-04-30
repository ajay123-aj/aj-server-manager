# One-liner helper: run from repo root after npm install
#
#   .\scripts\enroll-one-liner.ps1 -Server http://192.168.1.10:3847 -Key YOUR_PAIRING_KEY
#
param(
  [Parameter(Mandatory = $true)][string]$Server,
  [Parameter(Mandatory = $true)][string]$Key
)
Set-Location $PSScriptRoot\..
$env:AJ_SERVER_URL = $Server
& node .\src\agent-cli.js --server $Server --key $Key
