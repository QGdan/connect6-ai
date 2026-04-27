param(
  [string]$FinalDir = "docs/proposal/final",
  [string]$PythonExe = "python",
  [ValidateSet("true", "false")][string]$Toc = "true"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Resolve-FinalDirPath {
  param([string]$RepoRoot, [string]$InputPath)
  if ([System.IO.Path]::IsPathRooted($InputPath)) {
    return (Resolve-Path $InputPath).Path
  }
  return (Resolve-Path (Join-Path $RepoRoot $InputPath)).Path
}

function Write-ReportMarkdown {
  param(
    [string]$OutputPath,
    [string]$Status,
    [System.Collections.IEnumerable]$Results
  )

  $lines = @()
  $lines += "# BUILD REPORT"
  $lines += ""
  $lines += "- Status: $Status"
  $lines += "- GeneratedAt: $(Get-Date -Format s)"
  $lines += ""

  foreach ($item in $Results) {
    $srcName = [System.IO.Path]::GetFileName($item.source_md)
    $lines += "## $srcName"
    $lines += ""
    $lines += "- Source: ``$($item.source_md)``"
    $lines += "- DOCX: ``$($item.output_docx)``"
    $lines += "- PDF: ``$($item.output_pdf)``"
    $lines += "- PageCount: $($item.page_count)"
    $lines += "- ForbiddenPhraseCount(replace_doctor_phrase): $($item.forbidden_phrase_count)"
    $lines += "- PhaseTwoMentions(phase_two_keyword): $($item.phase_two_mentions)"
    $lines += "- Checks:"
    $lines += "  - page_count_gte_18: $($item.checks.page_count_gte_18)"
    $lines += "  - no_replace_doctor_phrase: $($item.checks.no_replace_doctor_phrase)"
    $lines += "  - contains_phase_two: $($item.checks.contains_phase_two)"
    $lines += "  - all_passed: $($item.all_passed)"
    $lines += ""
  }

  $lines | Set-Content -Encoding utf8 $OutputPath
}

function Write-SubmitChecklist {
  param(
    [string]$OutputPath,
    [System.Collections.IEnumerable]$Results,
    [bool]$AllPassed
  )

  $lines = @()
  $lines += "# SUBMIT CHECKLIST"
  $lines += ""
  $lines += "## Files"
  foreach ($item in $Results) {
    $mdExists = Test-Path $item.source_md
    $docxExists = Test-Path $item.output_docx
    $pdfExists = Test-Path $item.output_pdf
    $lines += "- [$(if ($mdExists) { "x" } else { " " })] ``$($item.source_md)``"
    $lines += "- [$(if ($docxExists) { "x" } else { " " })] ``$($item.output_docx)``"
    $lines += "- [$(if ($pdfExists) { "x" } else { " " })] ``$($item.output_pdf)``"
  }
  $lines += "- [$(if (Test-Path (Join-Path (Split-Path $OutputPath -Parent) 'BUILD_REPORT.json')) { "x" } else { " " })] ``BUILD_REPORT.json``"
  $lines += "- [$(if (Test-Path (Join-Path (Split-Path $OutputPath -Parent) 'BUILD_REPORT.md')) { "x" } else { " " })] ``BUILD_REPORT.md``"
  $lines += ""
  $lines += "## Content Rules"
  $lines += "- [$(if ($AllPassed) { "x" } else { " " })] No forbidden phrase: replace_doctor_phrase"
  $lines += "- [$(if ($AllPassed) { "x" } else { " " })] Phase two statement exists: phase_two_keyword"
  $lines += "- [$(if ($AllPassed) { "x" } else { " " })] Page count >= 18 (all versions)"
  $lines += ""
  $lines += "## Manual Review"
  $lines += "- [ ] Replace cover placeholders with official information"
  $lines += "- [ ] Confirm school template (if provided) and remap styles if needed"
  $lines += "- [ ] Recheck table of contents update in Word"
  $lines += "- [ ] Simulate final zip package before submission"

  $lines | Set-Content -Encoding utf8 $OutputPath
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$finalDirPath = Resolve-FinalDirPath -RepoRoot $repoRoot -InputPath $FinalDir

$buildDocxScript = Join-Path $repoRoot "scripts/proposal/build_docx.py"
$exportPdfScript = Join-Path $repoRoot "scripts/proposal/export_pdf.ps1"

if (-not (Test-Path $buildDocxScript)) { throw "Missing script: $buildDocxScript" }
if (-not (Test-Path $exportPdfScript)) { throw "Missing script: $exportPdfScript" }

$mdFiles = Get-ChildItem -Path $finalDirPath -Filter *.md -File | Where-Object {
  $_.BaseName -notin @("BUILD_REPORT", "SUBMIT_CHECKLIST")
}

if ($mdFiles.Count -lt 2) {
  throw "Expected at least 2 markdown files in $finalDirPath, found $($mdFiles.Count)."
}

$tenChapterMd = $mdFiles | Where-Object {
  $_.BaseName -match "10"
} | Sort-Object Name | Select-Object -First 1
if (-not $tenChapterMd) {
  throw "Could not identify the 10-chapter markdown (filename should include '10')."
}

$kwDeclarationA = -join @([char]0x7533, [char]0x62A5) # declaration keyword A
$kwDeclarationB = -join @([char]0x4F53, [char]0x4F8B) # declaration keyword B
$declarationMd = $mdFiles | Where-Object {
  $_.BaseName -match [regex]::Escape($kwDeclarationA) -or $_.BaseName -match [regex]::Escape($kwDeclarationB)
} | Sort-Object Name | Select-Object -First 1
if (-not $declarationMd) {
  throw "Could not identify the declaration markdown (filename should include declaration keyword)."
}
if ($declarationMd.FullName -eq $tenChapterMd.FullName) {
  throw "Markdown selection failed: 10-chapter and declaration markdown resolved to the same file."
}

$targets = @($tenChapterMd, $declarationMd)
$results = @()

$forbiddenPhrase = -join @([char]0x66FF, [char]0x4EE3, [char]0x533B, [char]0x751F)
$phaseTwoKeyword = -join @([char]0x4E8C, [char]0x671F)

foreach ($target in $targets) {
  $docxPath = [System.IO.Path]::ChangeExtension($target.FullName, ".docx")
  $pdfPath = [System.IO.Path]::ChangeExtension($target.FullName, ".pdf")

  Write-Host "Build DOCX from: $($target.Name)"
  & $PythonExe $buildDocxScript --input $target.FullName --output $docxPath --profile buct_default --toc $Toc
  if ($LASTEXITCODE -ne 0) {
    throw "build_docx.py failed for: $($target.FullName)"
  }

  Write-Host "Export PDF from: $([System.IO.Path]::GetFileName($docxPath))"
  $pdfJson = & $exportPdfScript -DocxPath $docxPath -PdfPath $pdfPath -Visible:$false
  $pdfObj = $pdfJson | ConvertFrom-Json

  $content = Get-Content -Raw -Encoding utf8 $target.FullName
  $forbiddenPhraseCount = ([regex]::Matches($content, [regex]::Escape($forbiddenPhrase))).Count
  $phaseTwoMentions = ([regex]::Matches($content, [regex]::Escape($phaseTwoKeyword))).Count
  $pageCount = [int]$pdfObj.page_count

  $checks = [pscustomobject]@{
    page_count_gte_18 = $pageCount -ge 18
    no_replace_doctor_phrase = $forbiddenPhraseCount -eq 0
    contains_phase_two = $phaseTwoMentions -ge 1
  }

  $allPassed = $checks.page_count_gte_18 -and $checks.no_replace_doctor_phrase -and $checks.contains_phase_two

  $results += [pscustomobject]@{
    source_md = $target.FullName
    output_docx = $docxPath
    output_pdf = $pdfPath
    page_count = $pageCount
    forbidden_phrase_count = $forbiddenPhraseCount
    phase_two_mentions = $phaseTwoMentions
    checks = $checks
    all_passed = $allPassed
  }
}

$overallPassed = @($results | Where-Object { -not $_.all_passed }).Count -eq 0
$status = if ($overallPassed) { "pass" } else { "fail" }

$reportJsonPath = Join-Path $finalDirPath "BUILD_REPORT.json"
$reportMdPath = Join-Path $finalDirPath "BUILD_REPORT.md"
$checklistPath = Join-Path $finalDirPath "SUBMIT_CHECKLIST.md"

$reportObj = [pscustomobject]@{
  status = $status
  generated_at = Get-Date -Format s
  final_dir = $finalDirPath
  results = $results
}

$reportObj | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 $reportJsonPath
Write-ReportMarkdown -OutputPath $reportMdPath -Status $status -Results $results
Write-SubmitChecklist -OutputPath $checklistPath -Results $results -AllPassed $overallPassed

if (-not $overallPassed) {
  Write-Error "Build completed with validation failures. See $reportMdPath"
  exit 1
}

Write-Host "Build completed successfully."
Write-Host "Report: $reportMdPath"
