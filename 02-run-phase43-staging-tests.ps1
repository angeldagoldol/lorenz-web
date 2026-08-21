Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# This runner intentionally targets only the Phase 4.3 staging project.
$stagingProjectRef = 'genlmsbvcwzlgjpdeqdl'
$stagingBaseUrl = 'https://genlmsbvcwzlgjpdeqdl.supabase.co'
$checkoutUrl = 'https://genlmsbvcwzlgjpdeqdl.supabase.co/functions/v1/checkout'
$allowedOrigin = 'https://lorenz-web-six.vercel.app'
$repoRoot = 'C:\dagoldol-stageb'

$normalPayload = @'
{
  "operation": "commit",
  "idempotencyKey": "00000000-0000-4000-8000-000000000001",
  "items": [
    { "kind": "product", "productId": "p43-edge-normal-product", "variant": "10", "quantity": 1 }
  ],
  "delivery": {
    "name": "Phase 43 User A",
    "phone": "+639171234567",
    "address": "100 Staging Lane",
    "city": "Quezon City",
    "postal": "1100",
    "landmark": "Staging fixture",
    "location": { "latitude": 14.676, "longitude": 121.0437, "confirmed": true }
  },
  "promoCode": null,
  "payment": { "method": "gcash", "reference": "P43-NORMAL-REFERENCE", "proofPath": null, "halfPayment": false },
  "saveAddress": false
}
'@

$finalStockPayload = @'
{
  "operation": "commit",
  "idempotencyKey": "00000000-0000-4000-8000-000000000002",
  "items": [
    { "kind": "product", "productId": "p43-edge-final-stock-product", "variant": "10", "quantity": 1 }
  ],
  "delivery": {
    "name": "Phase 43 User A",
    "phone": "+639171234567",
    "address": "100 Staging Lane",
    "city": "Quezon City",
    "postal": "1100",
    "landmark": "Staging fixture",
    "location": { "latitude": 14.676, "longitude": 121.0437, "confirmed": true }
  },
  "promoCode": null,
  "payment": { "method": "gcash", "reference": "P43-FINAL-STOCK-REFERENCE", "proofPath": null, "halfPayment": false },
  "saveAddress": false
}
'@

$idempotencyPayload = @'
{
  "operation": "commit",
  "idempotencyKey": "00000000-0000-4000-8000-000000000003",
  "items": [
    { "kind": "product", "productId": "p43-edge-idempotency-product", "variant": "10", "quantity": 1 }
  ],
  "delivery": {
    "name": "Phase 43 User A",
    "phone": "+639171234567",
    "address": "100 Staging Lane",
    "city": "Quezon City",
    "postal": "1100",
    "landmark": "Staging fixture",
    "location": { "latitude": 14.676, "longitude": 121.0437, "confirmed": true }
  },
  "promoCode": null,
  "payment": { "method": "gcash", "reference": "P43-IDEMPOTENCY-REFERENCE", "proofPath": null, "halfPayment": false },
  "saveAddress": false
}
'@

function Convert-SecureStringToPlainText([System.Security.SecureString]$SecureValue) {
  $pointer = [IntPtr]::Zero
  try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($SecureValue)
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  }
  finally {
    if ($pointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
  }
}

function Clear-Phase43Environment {
  Get-ChildItem Env: | Where-Object { $_.Name -like 'PHASE43_*' } | ForEach-Object {
    Remove-Item ("Env:" + $_.Name) -ErrorAction SilentlyContinue
  }
}

function Test-Phase43PublishableKey([string]$Key) {
  $safeError = 'The supplied staging key is not allowed for this runner.'
  if ([string]::IsNullOrWhiteSpace($Key)) {
    throw $safeError
  }
  if ($Key -match '^sb_publishable_.+$') {
    return
  }
  if ($Key -match '^sb_secret_') {
    throw $safeError
  }
  if ($Key -notmatch '^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$') {
    throw $safeError
  }

  try {
    $payloadPart = $Key.Split('.')[1].Replace('-', '+').Replace('_', '/')
    switch ($payloadPart.Length % 4) {
      0 { break }
      2 { $payloadPart += '==' ; break }
      3 { $payloadPart += '=' ; break }
      default { throw $safeError }
    }
    $payloadJson = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($payloadPart))
    $payload = $payloadJson | ConvertFrom-Json
    if ($null -eq $payload -or [string]$payload.role -cne 'anon') {
      throw $safeError
    }
  }
  catch {
    throw $safeError
  }
}

function Invoke-Phase43SignIn([string]$Email, [string]$Password, [string]$PublishableKey) {
  $authUrl = "$stagingBaseUrl/auth/v1/token?grant_type=password"
  $body = $null
  try {
    $body = @{ email = $Email; password = $Password } | ConvertTo-Json -Compress
    return Invoke-RestMethod -Method Post -Uri $authUrl -Headers @{ apikey = $PublishableKey } -ContentType 'application/json' -Body $body
  }
  catch {
    throw 'Staging fixture user sign-in failed.'
  }
  finally {
    $body = $null
  }
}

function Invoke-TapSuite([string]$TestPath) {
  $testOutput = @(& node --test --test-reporter=tap $TestPath 2>&1)
  $exitCode = $LASTEXITCODE
  $testOutput | ForEach-Object { Write-Output $_ }
  $tapText = ($testOutput | ForEach-Object { $_.ToString() }) -join [Environment]::NewLine

  if ($exitCode -ne 0) {
    throw "Node test suite failed: $TestPath"
  }
  # A TAP # SKIP directive is a failure for this staging runner.
  if ($tapText.Contains('# SKIP') -or $tapText -match '(?im)#\s*SKIP\b') {
    throw "Node test suite reported a skipped test: $TestPath"
  }
  if ($tapText -match '(?im)^\s*#\s*skipped\s+[1-9]\d*\b') {
    throw "Node test suite reported skipped tests: $TestPath"
  }
  if ($tapText -notmatch '(?im)^\s*#\s*pass\s+2\s*$' -or
      $tapText -notmatch '(?im)^\s*#\s*fail\s+0\s*$' -or
      $tapText -notmatch '(?im)^\s*#\s*skipped\s+0\s*$') {
    throw "Node test suite did not report exactly two passes, zero failures, and zero skipped tests: $TestPath"
  }
}

$publishableKeySecure = $null
$userAPasswordSecure = $null
$userBPasswordSecure = $null
$publishableKey = $null
$userAPassword = $null
$userBPassword = $null
$userAToken = $null
$userBToken = $null
$userAResponse = $null
$userBResponse = $null

try {
  Clear-Phase43Environment

  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Node.js is required on PATH.'
  }
  $edgeTestPath = Join-Path $repoRoot 'tests\phase4-3-edge-integration.test.mjs'
  $concurrencyTestPath = Join-Path $repoRoot 'tests\phase4-3-concurrency.test.mjs'
  foreach ($testPath in @($edgeTestPath, $concurrencyTestPath)) {
    if (-not (Test-Path -LiteralPath $testPath -PathType Leaf)) {
      throw "Required test file was not found: $testPath"
    }
  }
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $publishableKeySecure = Read-Host -Prompt 'Staging publishable/anon key' -AsSecureString
  $userAEmail = Read-Host -Prompt 'Staging fixture user A email'
  $userAPasswordSecure = Read-Host -Prompt 'Staging fixture user A password' -AsSecureString
  $userBEmail = Read-Host -Prompt 'Staging fixture user B email'
  $userBPasswordSecure = Read-Host -Prompt 'Staging fixture user B password' -AsSecureString

  $publishableKey = Convert-SecureStringToPlainText $publishableKeySecure
  Test-Phase43PublishableKey -Key $publishableKey
  $userAPassword = Convert-SecureStringToPlainText $userAPasswordSecure
  $userBPassword = Convert-SecureStringToPlainText $userBPasswordSecure
  $userAResponse = Invoke-Phase43SignIn -Email $userAEmail -Password $userAPassword -PublishableKey $publishableKey
  $userBResponse = Invoke-Phase43SignIn -Email $userBEmail -Password $userBPassword -PublishableKey $publishableKey

  $userAToken = [string]$userAResponse.access_token
  $userBToken = [string]$userBResponse.access_token
  $userAId = [string]$userAResponse.user.id
  $userBId = [string]$userBResponse.user.id
  if ([string]::IsNullOrWhiteSpace($userAToken) -or [string]::IsNullOrWhiteSpace($userBToken)) {
    throw 'Both fixture users must return an access token.'
  }
  if ([string]::IsNullOrWhiteSpace($userAId) -or [string]::IsNullOrWhiteSpace($userBId) -or $userAId -eq $userBId) {
    throw 'Fixture users must sign in as two distinct users.'
  }

  $env:PHASE43_CHECKOUT_URL = $checkoutUrl
  $env:PHASE43_USER_A_TOKEN = $userAToken
  $env:PHASE43_USER_B_TOKEN = $userBToken
  $env:PHASE43_ALLOWED_ORIGIN = $allowedOrigin
  $env:PHASE43_NORMAL_CHECKOUT_PAYLOAD = $normalPayload
  $env:PHASE43_FINAL_STOCK_PAYLOAD = $finalStockPayload
  $env:PHASE43_IDEMPOTENCY_PAYLOAD = $idempotencyPayload

  Push-Location $repoRoot
  try {
    Invoke-TapSuite -TestPath $edgeTestPath
    Invoke-TapSuite -TestPath $concurrencyTestPath
    Write-Output 'PHASE43 STAGING TESTS PASS'
  }
  finally {
    Pop-Location
  }
}
finally {
  Remove-Item Env:PHASE43_USER_A_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:PHASE43_USER_B_TOKEN -ErrorAction SilentlyContinue
  Clear-Phase43Environment

  $publishableKey = $null
  $userAPassword = $null
  $userBPassword = $null
  $userAToken = $null
  $userBToken = $null
  $userAResponse = $null
  $userBResponse = $null
  foreach ($secureValue in @($publishableKeySecure, $userAPasswordSecure, $userBPasswordSecure)) {
    if ($null -ne $secureValue) {
      $secureValue.Dispose()
    }
  }
  $publishableKeySecure = $null
  $userAPasswordSecure = $null
  $userBPasswordSecure = $null
}
