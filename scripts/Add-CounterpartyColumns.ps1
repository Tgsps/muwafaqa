<#
.SYNOPSIS
  Adds the four remaining columns to mwf_counterparty via the Dataverse Web API.

.DESCRIPTION
  Source of truth: docs/data-model-phase1.md, section 1 (Counterparty).
  - Idempotent: a column that already exists is skipped (never modified, never deleted).
  - Touches only the table mwf_counterparty.
  - Every request carries MSCRM.SolutionUniqueName so the columns land in the solution.
  - The access token is obtained from the Azure CLI at run time and kept in memory only.
    It is never written to disk or printed.

.PARAMETER EnvironmentUrl
  Base URL of the Dataverse environment, e.g. https://<org>.crm.dynamics.com (no trailing slash needed).

.PARAMETER SolutionUniqueName
  Unique name of the unmanaged solution that receives the columns. Default: Muwafaqa.

.PARAMETER DryRun
  Print the planned requests without calling Azure CLI or Dataverse.

.EXAMPLE
  az login
  ./scripts/Add-CounterpartyColumns.ps1 -EnvironmentUrl https://<org>.crm.dynamics.com -DryRun
  ./scripts/Add-CounterpartyColumns.ps1 -EnvironmentUrl https://<org>.crm.dynamics.com
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$EnvironmentUrl,
    [string]$SolutionUniqueName = 'Muwafaqa',
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

$EnvironmentUrl = $EnvironmentUrl.TrimEnd('/')
$ApiBase = "$EnvironmentUrl/api/data/v9.2"
$Table = 'mwf_counterparty'
$LanguageCode = 1033   # English (Base language)

# ---------- helpers ----------

function New-Label([string]$Text) {
    @{
        '@odata.type'   = 'Microsoft.Dynamics.CRM.Label'
        LocalizedLabels = @(
            @{
                '@odata.type' = 'Microsoft.Dynamics.CRM.LocalizedLabel'
                Label         = $Text
                LanguageCode  = $LanguageCode
            }
        )
    }
}

function Get-Headers {
    @{
        Authorization              = "Bearer $script:Token"
        'OData-MaxVersion'         = '4.0'
        'OData-Version'            = '4.0'
        Accept                     = 'application/json'
        'Content-Type'             = 'application/json; charset=utf-8'
        'MSCRM.SolutionUniqueName' = $SolutionUniqueName
    }
}

function Get-ErrorText($ErrorRecord) {
    if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) { return $ErrorRecord.ErrorDetails.Message }
    return $ErrorRecord.Exception.Message
}

# GET that returns $null on 404 and throws on any other error.
function Invoke-DvGet([string]$Path) {
    try {
        Invoke-RestMethod -Method Get -Uri "$ApiBase/$Path" -Headers (Get-Headers)
    }
    catch {
        $status = $null
        if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
        if ($status -eq 404) { return $null }
        throw "GET $Path failed: $(Get-ErrorText $_)"
    }
}

function Invoke-DvPost([string]$Path, [hashtable]$Body) {
    $json = $Body | ConvertTo-Json -Depth 20
    try {
        Invoke-RestMethod -Method Post -Uri "$ApiBase/$Path" -Headers (Get-Headers) `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($json)) | Out-Null
    }
    catch {
        throw "POST $Path failed: $(Get-ErrorText $_)"
    }
}

# ---------- column definitions (literal from docs/data-model-phase1.md section 1) ----------
# NOTE: the document does not specify max lengths for these text columns.
# 100 is the platform default and is used here. Change here if a different length is wanted.

$choiceOptions = @(
    @{ Value = 867640000; Label = 'Supplier' }
    @{ Value = 867640001; Label = 'Customer' }
    @{ Value = 867640002; Label = 'Contractor' }
    @{ Value = 867640003; Label = 'Partner' }
    @{ Value = 867640004; Label = 'Other' }
)

$columns = @(
    @{
        LogicalName = 'mwf_counterpartytype'
        Kind        = 'Picklist'
        Body        = @{
            '@odata.type'  = 'Microsoft.Dynamics.CRM.PicklistAttributeMetadata'
            SchemaName     = 'mwf_counterpartytype'
            DisplayName    = New-Label 'Type'
            Description    = New-Label 'Role of the counterparty.'
            RequiredLevel  = @{ Value = 'ApplicationRequired' }   # Business Required
            OptionSet      = @{
                '@odata.type'  = 'Microsoft.Dynamics.CRM.OptionSetMetadata'
                IsGlobal       = $false
                OptionSetType  = 'Picklist'
                Options        = @(
                    foreach ($o in $choiceOptions) {
                        @{
                            Value = $o.Value
                            Label = New-Label $o.Label
                        }
                    }
                )
            }
        }
    }
    @{
        LogicalName = 'mwf_commercialregistration'
        Kind        = 'String'
        Body        = @{
            '@odata.type'  = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
            SchemaName     = 'mwf_commercialregistration'
            DisplayName    = New-Label 'Commercial Registration'
            Description    = New-Label 'Fictitious values only, e.g. TEST-CR-0001.'
            RequiredLevel  = @{ Value = 'None' }                  # Optional
            MaxLength      = 100
            FormatName     = @{ Value = 'Text' }
        }
    }
    @{
        LogicalName = 'mwf_contactname'
        Kind        = 'String'
        Body        = @{
            '@odata.type'  = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
            SchemaName     = 'mwf_contactname'
            DisplayName    = New-Label 'Contact'
            Description    = New-Label 'Free text role or department label. No person names.'
            RequiredLevel  = @{ Value = 'None' }                  # Optional
            MaxLength      = 100
            FormatName     = @{ Value = 'Text' }
        }
    }
    @{
        LogicalName = 'mwf_email'
        Kind        = 'String'
        Body        = @{
            '@odata.type'  = 'Microsoft.Dynamics.CRM.StringAttributeMetadata'
            SchemaName     = 'mwf_email'
            DisplayName    = New-Label 'Email'
            Description    = New-Label 'Reserved example domains only (example.com, example.test).'
            RequiredLevel  = @{ Value = 'None' }                  # Optional
            MaxLength      = 100
            FormatName     = @{ Value = 'Email' }
        }
    }
)

# ---------- dry run ----------

if ($DryRun) {
    Write-Host "DRY RUN. No network calls. Target: $ApiBase  Solution: $SolutionUniqueName" -ForegroundColor Yellow
    foreach ($c in $columns) {
        Write-Host ""
        Write-Host "POST EntityDefinitions(LogicalName='$Table')/Attributes   [$($c.LogicalName)]" -ForegroundColor Cyan
        Write-Host "  header MSCRM.SolutionUniqueName: $SolutionUniqueName"
        Write-Host ($c.Body | ConvertTo-Json -Depth 20)
    }
    return
}

# ---------- authenticate (token kept in memory only) ----------

$script:Token = (az account get-access-token --resource $EnvironmentUrl --query accessToken -o tsv)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($script:Token)) {
    throw 'Could not get an access token. Run "az login" first, and check the environment URL.'
}

# ---------- preconditions (read-only) ----------

$solution = Invoke-DvGet "solutions?`$select=uniquename&`$filter=uniquename eq '$SolutionUniqueName'"
if (-not $solution -or $solution.value.Count -eq 0) {
    throw "Solution '$SolutionUniqueName' not found. Stopping."
}

$entity = Invoke-DvGet "EntityDefinitions(LogicalName='$Table')?`$select=LogicalName,OwnershipType,PrimaryNameAttribute"
if (-not $entity) { throw "Table '$Table' not found. Stopping." }
Write-Host "Table $($entity.LogicalName): OwnershipType=$($entity.OwnershipType), PrimaryNameAttribute=$($entity.PrimaryNameAttribute)"
if ($entity.OwnershipType -ne 'OrganizationOwned') {
    throw "Expected OrganizationOwned (data model D4) but found '$($entity.OwnershipType)'. Stopping."
}

# ---------- create (idempotent) ----------

$results = @()
foreach ($c in $columns) {
    $name = $c.LogicalName
    $existing = Invoke-DvGet "EntityDefinitions(LogicalName='$Table')/Attributes(LogicalName='$name')?`$select=LogicalName,AttributeType"
    if ($existing) {
        Write-Host "SKIP    $name (already exists, AttributeType=$($existing.AttributeType))" -ForegroundColor Yellow
        $results += [pscustomobject]@{ Column = $name; Action = 'skipped (exists)' }
        continue
    }
    Invoke-DvPost "EntityDefinitions(LogicalName='$Table')/Attributes" $c.Body
    Write-Host "CREATED $name" -ForegroundColor Green
    $results += [pscustomobject]@{ Column = $name; Action = 'created' }
}

# ---------- report ----------

Write-Host ""
Write-Host "Custom columns on $Table now:"
$attrs = Invoke-DvGet "EntityDefinitions(LogicalName='$Table')/Attributes?`$select=LogicalName,AttributeType,RequiredLevel,IsCustomAttribute"
$attrs.value |
    Where-Object { $_.IsCustomAttribute } |
    Select-Object LogicalName, AttributeType, @{ n = 'RequiredLevel'; e = { $_.RequiredLevel.Value } } |
    Sort-Object LogicalName |
    Format-Table -AutoSize

$opt = Invoke-DvGet "EntityDefinitions(LogicalName='$Table')/Attributes(LogicalName='mwf_counterpartytype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?`$select=LogicalName&`$expand=OptionSet(`$select=Options)"
if ($opt) {
    Write-Host "Options of mwf_counterpartytype:"
    $opt.OptionSet.Options |
        Select-Object Value, @{ n = 'Label'; e = { $_.Label.UserLocalizedLabel.Label } } |
        Format-Table -AutoSize
}

Write-Host "Summary:"
$results | Format-Table -AutoSize
