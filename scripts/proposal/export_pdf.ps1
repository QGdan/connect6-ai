param(
  [Parameter(Mandatory = $true)][string]$DocxPath,
  [Parameter(Mandatory = $true)][string]$PdfPath,
  [bool]$Visible = $false
)

$ErrorActionPreference = "Stop"

$docxFull = (Resolve-Path $DocxPath).Path
$pdfFull = [System.IO.Path]::GetFullPath($PdfPath)
$pdfDir = [System.IO.Path]::GetDirectoryName($pdfFull)
if (-not (Test-Path $pdfDir)) {
  New-Item -ItemType Directory -Path $pdfDir -Force | Out-Null
}

$word = $null
$doc = $null

try {
  $word = New-Object -ComObject Word.Application
  $word.Visible = $Visible
  $word.DisplayAlerts = 0

  $doc = $word.Documents.Open($docxFull)
  $doc.Fields.Update() | Out-Null
  $doc.Repaginate()
  $pageCount = $doc.ComputeStatistics(2) # wdStatisticPages
  $doc.Save() | Out-Null

  $wdFormatPDF = 17
  $doc.ExportAsFixedFormat($pdfFull, $wdFormatPDF)

  $doc.Close()
  $doc = $null

  [PSCustomObject]@{
    status    = "ok"
    docx_path = $docxFull
    pdf_path  = $pdfFull
    page_count = [int]$pageCount
  } | ConvertTo-Json -Compress
}
catch {
  if ($doc -ne $null) {
    try { $doc.Close() } catch {}
  }
  throw
}
finally {
  if ($word -ne $null) {
    try { $word.Quit() } catch {}
    try { [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) } catch {}
  }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
