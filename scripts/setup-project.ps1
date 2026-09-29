[CmdletBinding()]
param(
  [ValidatePattern('^[a-z_][a-z0-9_]{3,63}$')]
  [string]$SupabaseSecretKeyName
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ProjectRef = 'coqkgyaekenxccbxlozo'
$SupabaseUrl = 'https://coqkgyaekenxccbxlozo.supabase.co'
$LocalAppUrl = 'http://localhost:5173'
$ProjectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$Utf8WithoutBom = New-Object System.Text.UTF8Encoding($false)
$SupabaseCliPath = Join-Path $ProjectRoot 'node_modules/.bin/supabase.cmd'
$SupabaseSecretSecure = $null
$TurnstileSecretSecure = $null
$OverallFailure = $false
$EnvironmentTargets = @(
  '.env.local',
  '.env.bootstrap',
  '.env.edge.local',
  '.env.edge.production'
)
$RequiredIgnoreRules = @(
  '.env',
  '.env.*',
  '!.env.example',
  '!.env.*.example',
  '.env.local',
  '.env.bootstrap',
  '.env.edge.local',
  '.env.edge.production',
  'supabase/functions/.env'
)

$Summary = [ordered]@{
  Files = New-Object System.Collections.Generic.List[string]
  Variables = New-Object System.Collections.Generic.List[string]
  Linked = $false
  EdgeSecrets = 'No solicitado'
  Migrations = 'No solicitado'
  Functions = 'No solicitado'
  Bootstrap = 'No solicitado'
  SecurityCheck = 'Pendiente'
  Lint = 'Pendiente'
  Typecheck = 'Pendiente'
  Build = 'Pendiente'
  EdgeChecks = 'Pendiente'
  Pending = New-Object System.Collections.Generic.List[string]
}

function Write-Heading {
  param([Parameter(Mandatory = $true)][string]$Text)
  Write-Host ''
  Write-Host $Text -ForegroundColor Cyan
}

function Test-LineSafe {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)
  return -not ($Value.Contains("`r") -or $Value.Contains("`n") -or $Value.Contains([char]0))
}

function Read-RequiredText {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [Parameter(Mandatory = $true)][scriptblock]$Validator,
    [Parameter(Mandatory = $true)][string]$InvalidMessage
  )

  while ($true) {
    $value = (Read-Host $Prompt).Trim()
    if ($value.Length -gt 0 -and (Test-LineSafe -Value $value) -and (& $Validator $value)) {
      return $value
    }
    Write-Warning $InvalidMessage
  }
}

function ConvertFrom-SecureValue {
  param([Parameter(Mandatory = $true)][Security.SecureString]$SecureValue)

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

function Read-RequiredSecret {
  param(
    [Parameter(Mandatory = $true)][string]$Prompt,
    [Parameter(Mandatory = $true)][scriptblock]$Validator,
    [Parameter(Mandatory = $true)][string]$InvalidMessage
  )

  while ($true) {
    $secureValue = Read-Host $Prompt -AsSecureString
    $plainValue = $null
    $isValid = $false
    try {
      $plainValue = ConvertFrom-SecureValue -SecureValue $secureValue
      $isValid = (
        $null -ne $plainValue -and
        $plainValue.Length -gt 0 -and
        (Test-LineSafe -Value $plainValue) -and
        (& $Validator $plainValue)
      )
    }
    finally {
      $plainValue = $null
    }
    if ($isValid) {
      return $secureValue
    }
    $secureValue.Dispose()
    Write-Warning $InvalidMessage
  }
}

function Read-Confirmation {
  param([Parameter(Mandatory = $true)][string]$Prompt)

  while ($true) {
    $answer = (Read-Host "$Prompt [S/N]").Trim().ToLowerInvariant()
    if ($answer -eq '' -or $answer -eq 'n' -or $answer -eq 'no') {
      return $false
    }
    if ($answer -eq 's' -or $answer -eq 'si') {
      return $true
    }
    Write-Warning 'Responda S o N.'
  }
}

function Normalize-AppUrl {
  param(
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][bool]$AllowLoopbackHttp
  )

  $parsed = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$parsed)) {
    throw 'La URL no es valida.'
  }
  if ($parsed.UserInfo -or $parsed.Query -or $parsed.Fragment) {
    throw 'La URL no puede incluir credenciales, query ni fragmento.'
  }
  if ($parsed.AbsolutePath -ne '/') {
    throw 'La URL debe contener solamente esquema, host y puerto.'
  }

  $loopback = $parsed.Host -eq 'localhost' -or $parsed.Host -eq '127.0.0.1' -or $parsed.Host -eq '::1'
  if ($parsed.Scheme -ne 'https' -and -not ($AllowLoopbackHttp -and $loopback -and $parsed.Scheme -eq 'http')) {
    throw 'La URL debe usar HTTPS; HTTP se admite solo para localhost.'
  }
  return $parsed.GetLeftPart([UriPartial]::Authority).TrimEnd('/')
}

function Read-OptionalProductionUrl {
  while ($true) {
    $value = (Read-Host 'URL productiva opcional (Enter para usar localhost por ahora)').Trim()
    if ($value.Length -eq 0) {
      return $null
    }
    if (-not (Test-LineSafe -Value $value)) {
      Write-Warning 'La URL productiva no puede contener saltos de linea.'
      continue
    }
    try {
      return Normalize-AppUrl -Value $value -AllowLoopbackHttp $false
    }
    catch {
      Write-Warning 'Ingrese una URL productiva HTTPS valida, sin ruta, credenciales, query ni fragmento.'
    }
  }
}

function Test-SuperAdminEmail {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Value)

  if ($Value.Length -eq 0 -or $Value -match '\s' -or $Value.Length -gt 254) {
    return $false
  }
  try {
    $address = New-Object System.Net.Mail.MailAddress($Value)
    return $address.Address -eq $Value -and $address.Host.Contains('.')
  }
  catch {
    return $false
  }
}

function New-CryptographicSecret {
  $bytes = New-Object byte[] 32
  $generator = [Security.Cryptography.RandomNumberGenerator]::Create()
  $encoded = $null
  try {
    $generator.GetBytes($bytes)
    $encoded = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    return $encoded
  }
  finally {
    $generator.Dispose()
    [Array]::Clear($bytes, 0, $bytes.Length)
  }
}

function Get-ExistingEnvironmentValue {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Name
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  foreach ($line in [IO.File]::ReadAllLines($Path)) {
    $match = [regex]::Match($line, '^' + [regex]::Escape($Name) + '=(.*)$')
    if ($match.Success) {
      $value = $match.Groups[1].Value.Trim()
      if (Test-LineSafe -Value $value) {
        return $value
      }
      return $null
    }
  }
  return $null
}

function Test-RandomSecret {
  param([AllowNull()][AllowEmptyString()][string]$Value)
  return $null -ne $Value -and $Value -match '^[A-Za-z0-9_-]{43,}$'
}

function Assert-SafeTarget {
  param([Parameter(Mandatory = $true)][string]$Path)

  $fullPath = [IO.Path]::GetFullPath($Path)
  $rootPrefix = $ProjectRoot.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar) + [IO.Path]::DirectorySeparatorChar
  if (-not $fullPath.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Un archivo de entorno quedo fuera de la raiz del proyecto.'
  }
  if (Test-Path -LiteralPath $fullPath) {
    $item = Get-Item -LiteralPath $fullPath -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Se rechazo un enlace o reparse point en $($item.Name)."
    }
  }
}

function Ensure-GitIgnoreRules {
  param([switch]$ForceCanonicalBlock)

  $gitIgnorePath = Join-Path $ProjectRoot '.gitignore'
  Assert-SafeTarget -Path $gitIgnorePath
  $existingLines = @()
  if (Test-Path -LiteralPath $gitIgnorePath -PathType Leaf) {
    $existingLines = [IO.File]::ReadAllLines($gitIgnorePath)
  }
  $missing = @($RequiredIgnoreRules | Where-Object { $existingLines -notcontains $_ })
  if ($missing.Count -eq 0 -and -not $ForceCanonicalBlock) {
    return
  }

  $builder = New-Object Text.StringBuilder
  if ($existingLines.Count -gt 0) {
    [void]$builder.Append(($existingLines -join "`n").TrimEnd())
    [void]$builder.Append("`n`n")
  }
  [void]$builder.Append("# Environment files generated by setup:project`n")
  [void]$builder.Append(($RequiredIgnoreRules -join "`n"))
  [void]$builder.Append("`n")
  [IO.File]::WriteAllText($gitIgnorePath, $builder.ToString(), $Utf8WithoutBom)
}

function Assert-NotTracked {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  $trackedPath = & git ls-files -- $RelativePath
  if ($LASTEXITCODE -ne 0) {
    throw 'No se pudo verificar el indice de Git.'
  }
  if ($trackedPath) {
    throw "$RelativePath ya esta versionado. Quitelo del indice antes de guardar secretos."
  }
}

function Assert-Ignored {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  & git check-ignore --quiet -- $RelativePath
  if ($LASTEXITCODE -ne 0) {
    Ensure-GitIgnoreRules -ForceCanonicalBlock
    & git check-ignore --quiet -- $RelativePath
    if ($LASTEXITCODE -ne 0) {
      throw "$RelativePath no esta protegido por .gitignore."
    }
  }
}

function Write-EnvironmentFile {
  param(
    [Parameter(Mandatory = $true)][string]$RelativePath,
    [Parameter(Mandatory = $true)][Collections.IDictionary]$Values
  )

  Assert-NotTracked -RelativePath $RelativePath
  Assert-Ignored -RelativePath $RelativePath
  $targetPath = Join-Path $ProjectRoot $RelativePath
  Assert-SafeTarget -Path $targetPath

  $lines = New-Object System.Collections.Generic.List[string]
  $contents = $null
  $temporaryPath = "$targetPath.setup-$PID-$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    foreach ($entry in $Values.GetEnumerator()) {
      if ($entry.Key -notmatch '^[A-Z][A-Z0-9_]*$') {
        throw 'Se rechazo un nombre de variable de entorno invalido.'
      }
      $plainValue = $null
      try {
        if ($entry.Value -is [Security.SecureString]) {
          $plainValue = ConvertFrom-SecureValue -SecureValue $entry.Value
        }
        else {
          $plainValue = [string]$entry.Value
        }
        if (-not (Test-LineSafe -Value $plainValue)) {
          throw "Se rechazo un valor multilinea para $($entry.Key)."
        }
        $lines.Add("$($entry.Key)=$plainValue")
      }
      finally {
        $plainValue = $null
      }
    }

    $contents = ($lines -join "`n") + "`n"
    [IO.File]::WriteAllText($temporaryPath, $contents, $Utf8WithoutBom)
    Move-Item -LiteralPath $temporaryPath -Destination $targetPath -Force
  }
  finally {
    $contents = $null
    $lines.Clear()
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force
    }
  }

  Assert-Ignored -RelativePath $RelativePath
  $Summary.Files.Add($RelativePath)
  foreach ($name in $Values.Keys) {
    $Summary.Variables.Add([string]$name)
  }
}

function Get-LinkedProjectRef {
  $refPath = Join-Path $ProjectRoot 'supabase/.temp/project-ref'
  if (-not (Test-Path -LiteralPath $refPath -PathType Leaf)) {
    return $null
  }
  $value = [IO.File]::ReadAllText($refPath).Trim()
  if ($value -match '^[a-z]{20}$') {
    return $value
  }
  return $null
}

function Invoke-VisibleCommand {
  param(
    [Parameter(Mandatory = $true)][string]$Executable,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][ref]$Succeeded
  )

  & $Executable @Arguments
  $exitCode = $LASTEXITCODE
  $Succeeded.Value = $exitCode -eq 0
}

function Invoke-Validation {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptName,
    [Parameter(Mandatory = $true)][string]$SummaryProperty
  )

  $succeeded = $false
  Invoke-VisibleCommand -Executable 'npm' -Arguments @('run', $ScriptName) -Succeeded ([ref]$succeeded) | Out-Host
  if ($succeeded) {
    $Summary[$SummaryProperty] = 'Correcto'
  }
  else {
    $Summary[$SummaryProperty] = 'Fallo'
  }
  return $succeeded
}

function Show-ConfiguredSecretNames {
  param([Parameter(Mandatory = $true)][string[]]$ExpectedNames)

  $output = & $SupabaseCliPath secrets list --output-format json
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    Write-Warning 'No se pudo verificar la lista de nombres de secretos.'
    return $false
  }
  try {
    $parsed = ($output -join "`n") | ConvertFrom-Json
    $items = @($parsed)
    if (
      $null -ne $parsed -and
      $null -ne $parsed.PSObject.Properties['secrets'] -and
      $null -ne $parsed.secrets
    ) {
      $items = @($parsed.secrets)
    }
    $names = @($items | ForEach-Object { $_.name } | Where-Object { $_ } | Sort-Object -Unique)
    $configuredExpectedNames = @($ExpectedNames | Where-Object { $names -contains $_ } | Sort-Object -Unique)
    Write-Host 'Nombres esperados confirmados en Supabase:'
    foreach ($name in $configuredExpectedNames) {
      Write-Host "- $name"
    }
    $missing = @($ExpectedNames | Where-Object { $names -notcontains $_ })
    if ($missing.Count -gt 0) {
      Write-Warning ('Faltan nombres esperados: ' + ($missing -join ', '))
      return $false
    }
    return $true
  }
  catch {
    Write-Warning 'La CLI respondio, pero el listado no tuvo el formato JSON esperado.'
    return $false
  }
}

function Invoke-EdgeValidations {
  $checks = @(
    @{ Label = 'formato'; Arguments = @('fmt', '--check') },
    @{ Label = 'lint'; Arguments = @('lint') },
    @{ Label = 'typecheck'; Arguments = @('task', 'check') },
    @{ Label = 'tests'; Arguments = @('task', 'test') }
  )
  $allSucceeded = $true
  Push-Location (Join-Path $ProjectRoot 'supabase/functions')
  try {
    foreach ($check in $checks) {
      $succeeded = $false
      Invoke-VisibleCommand -Executable 'deno' -Arguments $check.Arguments -Succeeded ([ref]$succeeded) | Out-Host
      if (-not $succeeded) {
        $allSucceeded = $false
      }
    }
  }
  finally {
    Pop-Location
  }
  return $allSucceeded
}

function Add-PendingStep {
  param([Parameter(Mandatory = $true)][string]$Text)
  if (-not $Summary.Pending.Contains($Text)) {
    $Summary.Pending.Add($Text)
  }
}

Push-Location $ProjectRoot
try {
  Write-Heading 'Configuracion guiada de Mozzi Menu'

  if ($ProjectRef -notmatch '^[a-z]{20}$') {
    throw 'El Project Ref configurado no tiene exactamente 20 letras minusculas.'
  }
  $expectedHost = "$ProjectRef.supabase.co"
  $parsedSupabaseUrl = [Uri](Normalize-AppUrl -Value $SupabaseUrl -AllowLoopbackHttp $false)
  if ($parsedSupabaseUrl.Host -ne $expectedHost) {
    throw 'La URL de Supabase no corresponde al Project Ref configurado.'
  }

  foreach ($command in @('git', 'npm')) {
    if (-not (Get-Command $command -ErrorAction SilentlyContinue)) {
      throw "Falta el comando requerido: $command."
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $ProjectRoot 'package.json') -PathType Leaf)) {
    throw 'No se encontro package.json en la raiz esperada.'
  }
  if (-not (Test-Path -LiteralPath $SupabaseCliPath -PathType Leaf)) {
    throw 'No se encontro la Supabase CLI local fijada por package-lock.json. Ejecute npm ci y vuelva a intentar.'
  }

  Ensure-GitIgnoreRules
  foreach ($relativePath in $EnvironmentTargets + @('supabase/functions/.env')) {
    Assert-SafeTarget -Path (Join-Path $ProjectRoot $relativePath)
    Assert-NotTracked -RelativePath $relativePath
    Assert-Ignored -RelativePath $relativePath
  }

  $email = Read-RequiredText -Prompt 'Correo real del Super Admin' -Validator {
    param($candidate)
    Test-SuperAdminEmail -Value $candidate
  } -InvalidMessage 'Ingrese un correo valido, en una sola linea.'
  $email = $email.ToLowerInvariant()

  $publishableKey = Read-RequiredText -Prompt 'Supabase Publishable Key' -Validator {
    param($candidate)
    $candidate -match '^sb_publishable_[A-Za-z0-9_-]{16,}$' -and $candidate -notmatch '^sb_secret_'
  } -InvalidMessage 'La Publishable Key debe usar el formato moderno sb_publishable_...; no se aceptan JWT legacy.'

  $SupabaseSecretSecure = Read-RequiredSecret -Prompt 'Supabase Secret Key' -Validator {
    param($candidate)
    $candidate -match '^sb_secret_[A-Za-z0-9_-]{16,}$' -and $candidate -notmatch '^sb_publishable_'
  } -InvalidMessage 'La Secret Key debe usar el formato moderno sb_secret_...; no se aceptan JWT legacy.'

  $productionInput = Read-OptionalProductionUrl
  $edgeBaseUrl = $(if ($null -ne $productionInput) { $productionInput } else { $LocalAppUrl })

  $turnstileEnabled = Read-Confirmation -Prompt 'Desea activar Cloudflare Turnstile'
  $turnstileSiteKey = $null
  if ($turnstileEnabled) {
    $turnstileSiteKey = Read-RequiredText -Prompt 'Turnstile Site Key' -Validator {
      param($candidate)
      $candidate -match '^[A-Za-z0-9_-]{10,}$'
    } -InvalidMessage 'La Site Key de Turnstile no tiene un formato valido.'
    $TurnstileSecretSecure = Read-RequiredSecret -Prompt 'Turnstile Secret Key' -Validator {
      param($candidate)
      $candidate -match '^[A-Za-z0-9_-]{10,}$'
    } -InvalidMessage 'La Secret Key de Turnstile no tiene un formato valido.'
  }

  $existingEdgePath = Join-Path $ProjectRoot '.env.edge.production'
  $rateLimitSecret = Get-ExistingEnvironmentValue -Path $existingEdgePath -Name 'RATE_LIMIT_HASH_SECRET'
  $maintenanceSecret = Get-ExistingEnvironmentValue -Path $existingEdgePath -Name 'MAINTENANCE_SECRET'
  $existingSecretKeyName = Get-ExistingEnvironmentValue -Path $existingEdgePath -Name 'APP_SECRET_KEY_NAME'
  $existingEdgeHasContent = (
    (Test-Path -LiteralPath $existingEdgePath -PathType Leaf) -and
    (Get-Item -LiteralPath $existingEdgePath -Force).Length -gt 0
  )
  if ($PSBoundParameters.ContainsKey('SupabaseSecretKeyName')) {
    $secretKeyName = $SupabaseSecretKeyName
    if (
      -not [string]::IsNullOrWhiteSpace($existingSecretKeyName) -and
      $existingSecretKeyName -ne $secretKeyName
    ) {
      Write-Warning "Se cambiara APP_SECRET_KEY_NAME de '$existingSecretKeyName' a '$secretKeyName'."
      if (-not (Read-Confirmation -Prompt 'Confirma la rotacion del selector de secret key')) {
        throw 'Se cancelo la rotacion del selector de secret key.'
      }
    }
  }
  elseif (-not [string]::IsNullOrWhiteSpace($existingSecretKeyName)) {
    $secretKeyName = $existingSecretKeyName
  }
  else {
    $secretKeyName = Read-RequiredText -Prompt 'Nombre exacto de la Supabase Secret Key (por ejemplo, default)' -Validator {
      param($candidate)
      $candidate -match '^[a-z_][a-z0-9_]{3,63}$'
    } -InvalidMessage 'El nombre debe tener entre 4 y 64 caracteres, comenzar con letra minuscula o guion bajo y contener solo letras minusculas, digitos o guiones bajos.'
  }
  if ($secretKeyName -notmatch '^[a-z_][a-z0-9_]{3,63}$') {
    throw 'APP_SECRET_KEY_NAME debe tener entre 4 y 64 caracteres, comenzar con letra minuscula o guion bajo y contener solo letras minusculas, digitos o guiones bajos.'
  }
  $rateLimitSecretValid = Test-RandomSecret -Value $rateLimitSecret
  $maintenanceSecretValid = (Test-RandomSecret -Value $maintenanceSecret) -and $maintenanceSecret -ne $rateLimitSecret
  $secretsToGenerate = New-Object System.Collections.Generic.List[string]
  if (-not $rateLimitSecretValid) {
    $secretsToGenerate.Add('RATE_LIMIT_HASH_SECRET')
  }
  if (-not $maintenanceSecretValid) {
    $secretsToGenerate.Add('MAINTENANCE_SECRET')
  }
  $setupAppearsToBeARerun = (
    (Test-Path -LiteralPath (Join-Path $ProjectRoot '.env.local') -PathType Leaf) -or
    $existingEdgeHasContent
  )
  if ($setupAppearsToBeARerun -and $secretsToGenerate.Count -gt 0) {
    Write-Warning ('La reejecucion necesita reemplazar estos secretos internos: ' + ($secretsToGenerate -join ', '))
    Write-Warning 'La rotacion puede cortar la continuidad del rate limit o invalidar integraciones de mantenimiento.'
    if (-not (Read-Confirmation -Prompt 'Desea generar valores nuevos para esos nombres')) {
      throw 'Se cancelo la configuracion para evitar una rotacion de secretos no confirmada.'
    }
  }
  if (-not $rateLimitSecretValid) {
    $rateLimitSecret = New-CryptographicSecret
  }
  if (-not $maintenanceSecretValid) {
    do {
      $maintenanceSecret = New-CryptographicSecret
    } while ($maintenanceSecret -eq $rateLimitSecret)
  }

  $frontendValues = [ordered]@{
    VITE_SUPABASE_URL = $SupabaseUrl
    VITE_SUPABASE_PUBLISHABLE_KEY = $publishableKey
    VITE_APP_BASE_URL = $LocalAppUrl
  }
  if ($turnstileEnabled) {
    $frontendValues.VITE_TURNSTILE_SITE_KEY = $turnstileSiteKey
  }

  $bootstrapValues = [ordered]@{
    SUPABASE_URL = $SupabaseUrl
    SUPABASE_SECRET_KEY = $SupabaseSecretSecure
    SUPER_ADMIN_EMAIL = $email
  }

  $allowedOrigins = New-Object System.Collections.Generic.List[string]
  $allowedOrigins.Add($LocalAppUrl)
  if ($edgeBaseUrl -ne $LocalAppUrl) {
    $allowedOrigins.Add($edgeBaseUrl)
  }
  $edgeValues = [ordered]@{
    APP_BASE_URL = $edgeBaseUrl
    APP_ALLOWED_ORIGINS = $allowedOrigins -join ','
    APP_SECRET_KEY_NAME = $secretKeyName
    RATE_LIMIT_HASH_SECRET = $rateLimitSecret
    MAINTENANCE_SECRET = $maintenanceSecret
    TURNSTILE_ENABLED = $(if ($turnstileEnabled) { 'true' } else { 'false' })
  }
  if ($turnstileEnabled) {
    $edgeValues.TURNSTILE_SECRET_KEY = $TurnstileSecretSecure
  }
  $localEdgeValues = [ordered]@{
    APP_BASE_URL = $LocalAppUrl
    APP_ALLOWED_ORIGINS = $LocalAppUrl
    APP_SECRET_KEY_NAME = 'default'
    RATE_LIMIT_HASH_SECRET = $rateLimitSecret
    MAINTENANCE_SECRET = $maintenanceSecret
    TURNSTILE_ENABLED = $(if ($turnstileEnabled) { 'true' } else { 'false' })
  }
  if ($turnstileEnabled) {
    $localEdgeValues.TURNSTILE_SECRET_KEY = $TurnstileSecretSecure
  }
  $expectedEdgeSecretNames = @($edgeValues.Keys)

  Write-EnvironmentFile -RelativePath '.env.local' -Values $frontendValues
  Write-EnvironmentFile -RelativePath '.env.bootstrap' -Values $bootstrapValues
  Write-EnvironmentFile -RelativePath '.env.edge.local' -Values $localEdgeValues
  Write-EnvironmentFile -RelativePath '.env.edge.production' -Values $edgeValues

  $SupabaseSecretSecure.Dispose()
  $SupabaseSecretSecure = $null
  if ($null -ne $TurnstileSecretSecure) {
    $TurnstileSecretSecure.Dispose()
    $TurnstileSecretSecure = $null
  }
  $rateLimitSecret = $null
  $maintenanceSecret = $null
  $frontendValues = $null
  $bootstrapValues = $null
  $localEdgeValues = $null
  $edgeValues = $null
  [GC]::Collect()

  Write-Host 'Los cuatro archivos de entorno se generaron y git confirmo que estan ignorados.'

  $linkedRef = Get-LinkedProjectRef
  if ($linkedRef -ne $ProjectRef) {
    Write-Heading 'Vinculacion con Supabase'
    Write-Host 'La CLI puede solicitar directamente la clave de base de datos. No se guardara en archivos.'
    $linkSucceeded = $false
    Invoke-VisibleCommand -Executable $SupabaseCliPath -Arguments @('link', '--project-ref', $ProjectRef) -Succeeded ([ref]$linkSucceeded)
    $linkedRef = Get-LinkedProjectRef
    $Summary.Linked = $linkSucceeded -and $linkedRef -eq $ProjectRef
    if (-not $Summary.Linked) {
      $OverallFailure = $true
      Add-PendingStep -Text 'Vincular el repositorio al proyecto Supabase.'
    }
  }
  else {
    $Summary.Linked = $true
    Write-Host 'El repositorio ya estaba vinculado al Project Ref esperado.'
  }

  $loadEdgeSecrets = Read-Confirmation -Prompt 'Desea cargar ahora los secretos de Edge Functions a Supabase'
  if ($loadEdgeSecrets -and $Summary.Linked) {
    $setSecretsSucceeded = $false
    Invoke-VisibleCommand -Executable $SupabaseCliPath -Arguments @('secrets', 'set', '--env-file', '.env.edge.production') -Succeeded ([ref]$setSecretsSucceeded)
    if ($setSecretsSucceeded -and (Show-ConfiguredSecretNames -ExpectedNames $expectedEdgeSecretNames)) {
      $Summary.EdgeSecrets = 'Cargados y verificados por nombre'
    }
    elseif ($setSecretsSucceeded) {
      $Summary.EdgeSecrets = 'Cargados; verificacion pendiente'
      $OverallFailure = $true
      Add-PendingStep -Text 'Verificar los nombres de secretos remotos.'
    }
    else {
      $Summary.EdgeSecrets = 'Fallo'
      $OverallFailure = $true
      Add-PendingStep -Text 'Cargar los secretos de Edge Functions.'
    }
  }
  elseif ($loadEdgeSecrets) {
    $Summary.EdgeSecrets = 'Omitidos: proyecto no vinculado'
    $OverallFailure = $true
    Add-PendingStep -Text 'Cargar los secretos luego de vincular Supabase.'
  }
  else {
    Add-PendingStep -Text 'Cargar los secretos de Edge cuando corresponda.'
  }

  $pushMigrations = Read-Confirmation -Prompt 'Desea aplicar las migraciones al proyecto remoto'
  if ($pushMigrations -and $Summary.Linked) {
    $pushSucceeded = $false
    Invoke-VisibleCommand -Executable $SupabaseCliPath -Arguments @('db', 'push') -Succeeded ([ref]$pushSucceeded)
    if ($pushSucceeded) {
      $Summary.Migrations = 'Aplicadas'
    }
    else {
      $Summary.Migrations = 'Fallo'
      $OverallFailure = $true
      Add-PendingStep -Text 'Resolver el error tecnico y volver a aplicar las migraciones sin --force.'
    }
  }
  elseif ($pushMigrations) {
    $Summary.Migrations = 'Omitidas: proyecto no vinculado'
    $OverallFailure = $true
    Add-PendingStep -Text 'Aplicar migraciones luego de vincular Supabase.'
  }
  else {
    Add-PendingStep -Text 'Aplicar las migraciones remotas cuando corresponda.'
  }

  $deployFunctions = Read-Confirmation -Prompt 'Desea desplegar las Edge Functions'
  if ($deployFunctions -and $Summary.Linked) {
    $deploySucceeded = $false
    Invoke-VisibleCommand -Executable $SupabaseCliPath -Arguments @('functions', 'deploy') -Succeeded ([ref]$deploySucceeded)
    if ($deploySucceeded) {
      $Summary.Functions = 'Desplegadas'
    }
    else {
      $Summary.Functions = 'Fallo'
      $OverallFailure = $true
      Add-PendingStep -Text 'Resolver el error tecnico y desplegar las Edge Functions.'
    }
  }
  elseif ($deployFunctions) {
    $Summary.Functions = 'Omitidas: proyecto no vinculado'
    $OverallFailure = $true
    Add-PendingStep -Text 'Desplegar funciones luego de vincular Supabase.'
  }
  else {
    Add-PendingStep -Text 'Desplegar las Edge Functions cuando corresponda.'
  }

  $runBootstrap = Read-Confirmation -Prompt 'Desea ejecutar ahora el bootstrap de Lautaro Galvan'
  if ($runBootstrap) {
    $bootstrapSucceeded = $false
    Invoke-VisibleCommand -Executable 'npm' -Arguments @('run', 'bootstrap:superadmin', '--', '--email', $email) -Succeeded ([ref]$bootstrapSucceeded)
    if ($bootstrapSucceeded) {
      $Summary.Bootstrap = 'Ejecutado'
      if (Read-Confirmation -Prompt 'Desea eliminar ahora .env.bootstrap') {
        $bootstrapPath = Join-Path $ProjectRoot '.env.bootstrap'
        Assert-SafeTarget -Path $bootstrapPath
        Remove-Item -LiteralPath $bootstrapPath -Force
      }
      else {
        Add-PendingStep -Text 'Eliminar .env.bootstrap cuando deje de ser necesario.'
      }
    }
    else {
      $Summary.Bootstrap = 'Fallo'
      $OverallFailure = $true
      Add-PendingStep -Text 'Confirmar que el usuario exista y este confirmado en Auth; luego repetir el bootstrap.'
    }
  }
  else {
    Add-PendingStep -Text 'Ejecutar el bootstrap del Super Admin y luego eliminar .env.bootstrap.'
  }

  Write-Heading 'Comprobaciones locales'
  $securityOk = Invoke-Validation -ScriptName 'security:check' -SummaryProperty 'SecurityCheck'
  $lintOk = Invoke-Validation -ScriptName 'lint' -SummaryProperty 'Lint'
  $typecheckOk = Invoke-Validation -ScriptName 'typecheck' -SummaryProperty 'Typecheck'
  $buildOk = Invoke-Validation -ScriptName 'build' -SummaryProperty 'Build'
  if (Get-Command 'deno' -ErrorAction SilentlyContinue) {
    $edgeChecksOk = Invoke-EdgeValidations
    if ($edgeChecksOk) {
      $Summary.EdgeChecks = 'Correcto'
    }
    else {
      $Summary.EdgeChecks = 'Fallo'
      $OverallFailure = $true
      Add-PendingStep -Text 'Resolver las validaciones de Edge Functions.'
    }
  }
  else {
    $Summary.EdgeChecks = 'No ejecutadas: Deno no esta instalado'
    Add-PendingStep -Text 'Instalar Deno y ejecutar fmt, lint, typecheck y tests de Edge Functions.'
  }

  if (-not $productionInput) {
    Add-PendingStep -Text 'Ejecutar nuevamente el asistente cuando exista la URL productiva.'
  }

  Write-Heading 'Resumen final'
  Write-Host 'Archivos generados:'
  foreach ($file in $Summary.Files) {
    Write-Host "- $file"
  }
  Write-Host 'Nombres de variables configuradas:'
  foreach ($name in @($Summary.Variables | Sort-Object -Unique)) {
    Write-Host "- $name"
  }
  Write-Host "Proyecto vinculado: $(if ($Summary.Linked) { 'Si' } else { 'No' })"
  Write-Host "Secretos Edge: $($Summary.EdgeSecrets)"
  Write-Host "Migraciones: $($Summary.Migrations)"
  Write-Host "Edge Functions: $($Summary.Functions)"
  Write-Host "Bootstrap: $($Summary.Bootstrap)"
  Write-Host "Security check: $($Summary.SecurityCheck)"
  Write-Host "Lint: $($Summary.Lint)"
  Write-Host "Typecheck: $($Summary.Typecheck)"
  Write-Host "Build: $($Summary.Build)"
  Write-Host "Validaciones Edge: $($Summary.EdgeChecks)"
  Write-Host 'Pasos pendientes:'
  if ($Summary.Pending.Count -eq 0) {
    Write-Host '- Ninguno.'
  }
  else {
    foreach ($step in $Summary.Pending) {
      Write-Host "- $step"
    }
  }

  if (-not ($securityOk -and $lintOk -and $typecheckOk -and $buildOk)) {
    $OverallFailure = $true
  }
  if ($OverallFailure) {
    exit 1
  }
}
catch {
  Write-Error $_.Exception.Message
  exit 1
}
finally {
  if ($null -ne $SupabaseSecretSecure) {
    $SupabaseSecretSecure.Dispose()
  }
  if ($null -ne $TurnstileSecretSecure) {
    $TurnstileSecretSecure.Dispose()
  }
  Pop-Location
}
