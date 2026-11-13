#requires -Version 7
<#
.SYNOPSIS
  Runs OpenTofu for BibleStudy with credentials taken from your environment.
.DESCRIPTION
  Reads User-scope environment variables, never prints them, and sets them for this process only:
  CLOUDFLARE_API_TOKEN, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, TF_VAR_state_passphrase,
  TF_VAR_portainer_api_key, TF_VAR_cf_access_client_id, TF_VAR_cf_access_client_secret and
  TF_VAR_dispatch_token. GITHUB_TOKEN falls back to `gh auth token`.
  The stack's own values (`env` and `secrets`) come from a private var-file outside the repository:
  $HOME\.subzerodev\biblestudy.tfvars.json, or the path in BIBLESTUDY_TFVARS. Write it with
  scripts/export-stack-env.ps1 from the SubZeroDev.Infra repository.
.EXAMPLE
  ./deploy/tofu.ps1 plan
  ./deploy/tofu.ps1 apply
#>
[CmdletBinding()]
param([Parameter(ValueFromRemainingArguments)][string[]]$TofuArguments)
$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

$required = 'CLOUDFLARE_API_TOKEN', 'R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY',
  'TF_VAR_state_passphrase', 'TF_VAR_portainer_api_key', 'TF_VAR_cf_access_client_id',
  'TF_VAR_cf_access_client_secret', 'TF_VAR_dispatch_token'
$missing = foreach ($name in $required) {
  # The saved User value wins: a terminal opened before it changed still holds the old one.
  $value = [Environment]::GetEnvironmentVariable($name, 'User')
  if (-not $value) { $value = [Environment]::GetEnvironmentVariable($name, 'Process') }
  if ($value) { Set-Item "env:$name" $value } else { $name }
}
if (-not $env:GITHUB_TOKEN) { $env:GITHUB_TOKEN = (gh auth token) }
if ($missing) { throw "Set these environment variables first: $($missing -join ', ')" }

$varFile = if ($env:BIBLESTUDY_TFVARS) { $env:BIBLESTUDY_TFVARS } else { Join-Path $HOME '.subzerodev/biblestudy.tfvars.json' }
if (-not (Test-Path $varFile)) { throw "Missing $varFile. Write it with scripts/export-stack-env.ps1 (SubZeroDev.Infra)." }

$env:AWS_ACCESS_KEY_ID = $env:R2_ACCESS_KEY_ID
$env:AWS_SECRET_ACCESS_KEY = $env:R2_SECRET_ACCESS_KEY
if (-not (Test-Path backend.hcl)) {
  Set-Content backend.hcl -Encoding utf8 -Value @(
    'bucket    = "subzerodev-tofu-state"'
    'key       = "apps/subzerodev-biblestudy.tfstate"'
    "endpoints = { s3 = `"https://$($env:R2_ACCOUNT_ID).r2.cloudflarestorage.com`" }")
}
if (-not (Test-Path (Join-Path .terraform 'terraform.tfstate'))) { tofu init '-backend-config=backend.hcl' | Out-Host }

# -var-file applies to the commands that take variables, not to init, state or output.
$withVars = $TofuArguments -and $TofuArguments[0] -in 'plan', 'apply', 'destroy', 'import', 'refresh', 'console'
if ($withVars) { tofu $TofuArguments[0] "-var-file=$varFile" @($TofuArguments | Select-Object -Skip 1) } else { tofu @TofuArguments }
exit $LASTEXITCODE
