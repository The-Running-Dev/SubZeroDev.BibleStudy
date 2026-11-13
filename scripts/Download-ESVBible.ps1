#Requires -Version 7.0
<#
.SYNOPSIS
Downloads ESV.org chapter pages for local study, without an API key.
.DESCRIPTION
Downloads sequentially with a Mozilla User-Agent and a random 5-8 second pause
before each request. Starts with Matthew, continues through Revelation, then
Genesis through Malachi. Saves the original response (.source.html), a standalone
chapter (.html), and structured verses, headings, notes and references (.json).
Valid saved chapters are skipped. JSON is written last as the completion marker.
Local file operations retry independently of HTTP requests (five attempts by
default). Failures log UTC time, operation, full paths, exception and HResult.
Exhausted local retries stop the run and retain unpublished files for diagnosis.
Run again after an interruption to resume. No external modules are needed.
Stops on access denial or exhausted rate-limit retries; never works around a block.
Downloaded content stays under the repository's ignored bibles directory by default.
This downloads files only; it does not import ESV into the study application's catalog.
.EXAMPLE
pwsh -File ./scripts/Download-ESVBible.ps1 -Book 40 -Chapter 1
.EXAMPLE
pwsh -File ./scripts/Download-ESVBible.ps1
.EXAMPLE
pwsh -File ./scripts/Download-ESVBible.ps1 -Book 19 -Chapter 3 -Force
#>
[CmdletBinding()]
param(
    [string] $OutputDirectory = (Join-Path $PSScriptRoot '../bibles/ESV'),
    [ValidateRange(1, 66)] [int[]] $Book = @((40..66) + (1..39)),
    [ValidateRange(1, 150)] [int[]] $Chapter,
    [ValidateRange(1, 5)] [int] $MaxAttempts = 3,
    [ValidateRange(1, 10)] [int] $LocalFileAttempts = 5,
    [ValidateRange(100, 10000)] [int] $LocalRetryDelayMilliseconds = 1000,
    [ValidateRange(1000, 60000)] [int] $DelayMilliseconds = 5000,
    [ValidateRange(0, 60000)] [int] $JitterMilliseconds = 3000,
    [switch] $Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$catalog = @'
Genesis,50
Exodus,40
Leviticus,27
Numbers,36
Deuteronomy,34
Joshua,24
Judges,21
Ruth,4
1 Samuel,31
2 Samuel,24
1 Kings,22
2 Kings,25
1 Chronicles,29
2 Chronicles,36
Ezra,10
Nehemiah,13
Esther,10
Job,42
Psalms,150
Proverbs,31
Ecclesiastes,12
Song of Solomon,8
Isaiah,66
Jeremiah,52
Lamentations,5
Ezekiel,48
Daniel,12
Hosea,14
Joel,3
Amos,9
Obadiah,1
Jonah,4
Micah,7
Nahum,3
Habakkuk,3
Zephaniah,3
Haggai,2
Zechariah,14
Malachi,4
Matthew,28
Mark,16
Luke,24
John,21
Acts,28
Romans,16
1 Corinthians,16
2 Corinthians,13
Galatians,6
Ephesians,6
Philippians,4
Colossians,4
1 Thessalonians,5
2 Thessalonians,3
1 Timothy,6
2 Timothy,4
Titus,3
Philemon,1
Hebrews,13
James,5
1 Peter,5
2 Peter,3
1 John,5
2 John,1
3 John,1
Jude,1
Revelation,22
'@ | ConvertFrom-Csv -Header Name, Chapters

function Get-HtmlAttribute([string] $Tag, [string] $Name) {
    $match = [regex]::Match($Tag, '(?i)\b' + [regex]::Escape($Name) + '\s*=\s*(?:"([^"]*)"|''([^'']*)'')')
    if ($match.Success) { return [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value + $match.Groups[2].Value) }
    return ''
}

function ConvertTo-PlainText([string] $Html) {
    $text = [regex]::Replace($Html, '(?is)<sup\b[^>]*class=["''][^"'']*\b(?:crossref|footnote)\b[^"'']*["''][^>]*>.*?</sup>', '')
    $text = [regex]::Replace($text, '(?is)<b\b[^>]*class=["''][^"'']*(?:verse-num|chapter-num)[^"'']*["''][^>]*>.*?</b>', '')
    # Small-cap divine names should remain LORD/GOD in plain-text exports.
    $text = [regex]::Replace($text, '(?is)<span\b[^>]*class="small-caps-lower"[^>]*>(.*?)</span>', {
        param($m) $m.Groups[1].Value.ToUpperInvariant()
    })
    $text = [regex]::Replace($text, '(?s)<[^>]+>', '')
    return ([regex]::Replace([System.Net.WebUtility]::HtmlDecode($text), '\s+', ' ')).Trim()
}

function Get-Annotations([string] $Html, [string] $Kind, [string] $SourceUrl) {
    foreach ($m in [regex]::Matches($Html, '(?is)<sup\b[^>]*class=["''][^"'']*\b' + $Kind + '\b[^"'']*["''][^>]*>(.*?)</sup>')) {
        $anchor = [regex]::Match($m.Groups[1].Value, '(?is)<a\b[^>]*>')
        if (-not $anchor.Success) { throw "A $Kind annotation has no link; page markup may have changed." }
        $tag = $anchor.Value
        $href = Get-HtmlAttribute $tag 'href'
        [pscustomobject]@{
            Marker = ConvertTo-PlainText $m.Groups[1].Value
            Text = ConvertTo-PlainText (Get-HtmlAttribute $tag 'title')
            Passage = Get-HtmlAttribute $tag 'data-passage'
            Href = if ($href) { ([uri]::new([uri]$SourceUrl, $href)).AbsoluteUri } else { '' }
        }
    }
}

function ConvertFrom-ChapterHtml([string] $Html, [int] $Number, [string] $Name, [int] $ChapterNumber, [string] $SourceUrl) {
    $prefix = '{0:D2}{1:D3}' -f $Number, $ChapterNumber
    $verses = [ordered]@{}
    $headings = [System.Collections.Generic.List[object]]::new()
    $pendingHeadings = [System.Collections.Generic.List[object]]::new()
    $depth = 0
    $reference = ''
    $start = 0
    $previousEnd = 0
    $previousReference = ''
    # Match balanced verse spans, including nested small-caps spans. A verse may
    # span multiple paragraphs/poetry lines and consequently repeat its data-ref.
    $tokens = [regex]::Matches($Html, '(?is)<h[34]\b[^>]*>.*?</h[34]>|<span\b[^>]*>|</span\s*>')
    foreach ($token in $tokens) {
        if ($token.Value -match '^<h([34])\b') {
            $pendingHeadings.Add([pscustomobject]@{
                Level = [int]$Matches[1]
                Text = ConvertTo-PlainText $token.Value
                CrossReferences = @(Get-Annotations $token.Value 'crossref' $SourceUrl)
                Footnotes = @(Get-Annotations $token.Value 'footnote' $SourceUrl)
            })
            continue
        }
        if ($token.Value -match '^<span\b') {
            if ($depth -gt 0) { $depth++; continue }
            if ((Get-HtmlAttribute $token.Value 'class') -notmatch '(?:^|\s)verse(?:\s|$)') { continue }
            $reference = Get-HtmlAttribute $token.Value 'data-ref'
            if ($reference -notmatch '^\d{8}$') { throw 'Unexpected verse reference format.' }
            $depth = 1
            $start = $token.Index + $token.Length
            if ($reference.StartsWith($prefix)) {
                foreach ($heading in $pendingHeadings) {
                    $headings.Add([pscustomobject]@{
                        BeforeVerse = [int]$reference.Substring(5)
                        Level = $heading.Level
                        Text = $heading.Text
                        CrossReferences = $heading.CrossReferences
                        Footnotes = $heading.Footnotes
                    })
                }
            }
            $pendingHeadings.Clear()
        }
        elseif ($depth -gt 0) {
            $depth--
            if ($depth -ne 0) { continue }
            if ($reference.StartsWith($prefix)) {
                $fragment = $Html.Substring($start, $token.Index - $start)
                $text = ConvertTo-PlainText $fragment
                if (-not $verses.Contains($reference)) {
                    $verses[$reference] = [pscustomobject]@{
                        Number = [int]$reference.Substring(5)
                        Reference = $reference
                        Text = $text
                        Footnotes = @(Get-Annotations $fragment 'footnote' $SourceUrl)
                        CrossReferences = @(Get-Annotations $fragment 'crossref' $SourceUrl)
                    }
                }
                else {
                    if ($previousReference -ne $reference) { throw "Nonadjacent duplicate verse $reference." }
                    $gap = $Html.Substring($previousEnd, $start - $previousEnd)
                    $separator = if ($gap -match '(?i)</?p\b|<br\b|</?section\b') { "`n" } else { ' ' }
                    $verses[$reference].Text += $separator + $text
                    $verses[$reference].Footnotes += @(Get-Annotations $fragment 'footnote' $SourceUrl)
                    $verses[$reference].CrossReferences += @(Get-Annotations $fragment 'crossref' $SourceUrl)
                }
            }
            $previousEnd = $token.Index + $token.Length
            $previousReference = $reference
        }
    }
    if ($depth -ne 0) { throw 'Unclosed verse span; response may be truncated.' }
    if ($verses.Count -eq 0) { throw "No verses found for $Name $ChapterNumber; refusing to save a login/block/error page." }
    $lastNumber = 0
    foreach ($verse in $verses.Values) {
        if ($verse.Number -le $lastNumber -or [string]::IsNullOrWhiteSpace($verse.Text)) { throw 'Empty or out-of-order verse.' }
        $lastNumber = $verse.Number
    }
    if ($verses.Values[0].Number -ne 1 -or $Html -notmatch '(?i)</html\s*>') { throw 'Missing first verse or incomplete HTML document.' }
    # Some ESV verse numbers are intentionally absent; do not renumber them.
    return [pscustomobject]@{
        SchemaVersion = 1
        Translation = 'ESV'
        BookNumber = $Number
        Book = $Name
        Chapter = $ChapterNumber
        SourceUrl = $SourceUrl
        DownloadedAt = [datetime]::UtcNow.ToString('o')
        Attribution = 'Scripture text from ESV.org. English Standard Version. Copyright Crossway. Original response retained in the accompanying .source.html file.'
        VerseCount = $verses.Count
        Headings = @($headings.ToArray())
        Verses = @($verses.Values)
    }
}

function ConvertTo-LocalHtml($Document) {
    $encode = { param($value) [System.Net.WebUtility]::HtmlEncode([string]$value) }
    $body = [System.Text.StringBuilder]::new()
    [void]$body.AppendLine('<!doctype html><html lang="en"><meta charset="utf-8">')
    [void]$body.AppendLine('<style>body{max-width:48rem;margin:2rem auto;padding:0 1rem;font:18px/1.6 Georgia,serif}p{white-space:pre-line}small{font-size:.75em}li{font-size:.9em}</style>')
    $title = & $encode "$($Document.Book) $($Document.Chapter) (ESV)"
    [void]$body.AppendLine("<title>$title</title><body><h1>$title</h1>")
    foreach ($verse in $Document.Verses) {
        foreach ($heading in $Document.Headings | Where-Object BeforeVerse -EQ $verse.Number) {
            [void]$body.AppendLine("<h$($heading.Level)>$(& $encode $heading.Text)</h$($heading.Level)>")
            foreach ($note in @($heading.Footnotes) + @($heading.CrossReferences)) {
                [void]$body.AppendLine("<small>$(& $encode $note.Marker): $(& $encode $note.Text)</small>")
            }
        }
        [void]$body.AppendLine("<p id='v$($verse.Number)'><sup>$($verse.Number)</sup> $(& $encode $verse.Text)</p>")
        if ($verse.Footnotes.Count -or $verse.CrossReferences.Count) {
            [void]$body.AppendLine('<ul>')
            foreach ($note in @($verse.Footnotes) + @($verse.CrossReferences)) {
                [void]$body.AppendLine("<li>$(& $encode $note.Marker): $(& $encode $note.Text)</li>")
            }
            [void]$body.AppendLine('</ul>')
        }
    }
    [void]$body.AppendLine("<hr><p><small>$(& $encode $Document.Attribution)<br>Source: <a href='$(& $encode $Document.SourceUrl)'>$(& $encode $Document.SourceUrl)</a></small></p></body></html>")
    return $body.ToString()
}

function Invoke-LocalFileOperation([string] $Operation, [string] $Path, [scriptblock] $Action, [string] $Destination = '') {
    for ($fileAttempt = 1; $fileAttempt -le $LocalFileAttempts; $fileAttempt++) {
        try {
            $result = & $Action
            if ($fileAttempt -gt 1) {
                Write-Host "LOCAL RECOVERED utc=$([datetimeoffset]::UtcNow.ToString('o')) operation=$Operation source='$Path' destination='$Destination' attempt=$fileAttempt/$LocalFileAttempts"
            }
            return $result
        }
        catch {
            $cause = $_.Exception.GetBaseException()
            $details = "operation=$Operation source='$Path' destination='$Destination' attempt=$fileAttempt/$LocalFileAttempts exception=$($cause.GetType().FullName) HResult=$('{0:X8}' -f $cause.HResult) message=$($cause.Message)"
            Write-Warning "LOCAL utc=$([datetimeoffset]::UtcNow.ToString('o')) $details stack=$($_.ScriptStackTrace)"
            if ($fileAttempt -eq $LocalFileAttempts -or
                ($cause -isnot [IO.IOException] -and $cause -isnot [UnauthorizedAccessException])) {
                $failure = [IO.IOException]::new("Local file operation failed: $details", $_.Exception)
                $failure.Data['EsvLocalFileFailure'] = $true
                throw $failure
            }
            $wait = [math]::Min(10000, $LocalRetryDelayMilliseconds * $fileAttempt)
            Write-Host "LOCAL WAIT $wait milliseconds; retrying $Operation without another HTTP request"
            Start-Sleep -Milliseconds $wait
        }
    }
}

function Test-LocalFileFailure([Exception] $Exception) {
    while ($null -ne $Exception) {
        if ($Exception.Data.Contains('EsvLocalFileFailure')) { return $true }
        $Exception = $Exception.InnerException
    }
    return $false
}

function Get-LocalFileHash([string] $Path) {
    return (Invoke-LocalFileOperation 'Hash' $Path { Get-FileHash -LiteralPath $Path -Algorithm SHA256 }).Hash
}

function Assert-SavedChapter([string] $Stem, [int] $Number, [int] $ChapterNumber) {
    foreach ($suffix in '.source.html', '.html', '.json') {
        if (-not (Test-Path -LiteralPath ($Stem + $suffix))) { throw "Saved chapter file is missing: '$Stem$suffix'." }
    }
    $jsonPath = $Stem + '.json'
    $document = (Invoke-LocalFileOperation 'Read JSON' $jsonPath { [IO.File]::ReadAllText($jsonPath) }) | ConvertFrom-Json
    if ($document.SchemaVersion -ne 1 -or $document.Translation -ne 'ESV' -or
        $document.BookNumber -ne $Number -or $document.Chapter -ne $ChapterNumber -or
        $document.Verses.Count -lt 1 -or $document.VerseCount -ne $document.Verses.Count -or
        $document.Verses[0].Number -ne 1) { throw 'Saved chapter metadata is invalid.' }
    $prefix = '{0:D2}{1:D3}' -f $Number, $ChapterNumber
    $previous = 0
    foreach ($verse in $document.Verses) {
        if ($verse.Reference -ne ($prefix + ('{0:D3}' -f [int]$verse.Number)) -or
            $verse.Number -le $previous -or [string]::IsNullOrWhiteSpace($verse.Text)) { throw 'Saved verse is invalid.' }
        $previous = $verse.Number
    }
    if ((Get-LocalFileHash ($Stem + '.source.html')) -ne $document.SourceSha256 -or
        (Get-LocalFileHash ($Stem + '.html')) -ne $document.HtmlSha256) {
        throw 'Saved HTML checksum mismatch.'
    }
}

# Validate the complete requested scope before making any network requests.
$bookNumbers = @($Book | Select-Object -Unique)
foreach ($number in $bookNumbers) {
    foreach ($chapterNumber in $Chapter) {
        if ($chapterNumber -gt [int]$catalog[$number - 1].Chapters) { throw "$($catalog[$number - 1].Name) has only $($catalog[$number - 1].Chapters) chapters." }
    }
}
$outputPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
[void](Invoke-LocalFileOperation 'Create directory' $outputPath { [IO.Directory]::CreateDirectory($outputPath) })
# Prevent two runs from requesting the same chapters or replacing each other's files.
$lockPath = Join-Path $outputPath '.download.lock'
try { $downloadLock = [System.IO.File]::Open($lockPath, 'OpenOrCreate', 'ReadWrite', 'None') }
catch { throw "Cannot lock $lockPath. Another downloader may be using this folder. $($_.Exception.Message)" }
$userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36'
$session = [Microsoft.PowerShell.Commands.WebRequestSession]::new()
$downloaded = 0
$skipped = 0
$consecutiveFailures = 0
$failed = [System.Collections.Generic.List[string]]::new()

try {
    foreach ($number in $bookNumbers) {
        $entry = $catalog[$number - 1]
        $bookPath = Join-Path $outputPath ('{0:D2}-{1}' -f $number, ($entry.Name -replace ' ', '-'))
        [void](Invoke-LocalFileOperation 'Create directory' $bookPath { [IO.Directory]::CreateDirectory($bookPath) })
        $chapters = if ($Chapter) { @($Chapter | Sort-Object -Unique) } else { @(1..[int]$entry.Chapters) }
        foreach ($chapterNumber in $chapters) {
            $label = "$($entry.Name) $chapterNumber"
            $stem = Join-Path $bookPath ('{0:D3}' -f $chapterNumber)
            if (-not $Force -and (Test-Path -LiteralPath ($stem + '.json'))) {
                try {
                    Assert-SavedChapter $stem $number $chapterNumber
                    Write-Host "SKIP $label (already valid)"
                    $skipped++
                    continue
                }
                catch {
                    if (Test-LocalFileFailure $_.Exception) { throw }
                    Write-Warning "${label}: saved chapter failed validation; downloading again. $($_.Exception.Message)"
                }
            }
            $url = 'https://www.esv.org/' + [uri]::EscapeDataString($entry.Name).Replace('%20', '+') + '+' + $chapterNumber + '/'
            $success = $false
            for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
                $temporaryStem = Join-Path $bookPath ('.esv-' + [guid]::NewGuid().ToString('N'))
                $stopRun = $false
                $retainTemporaryFiles = $false
                $status = 0
                $retrySeconds = [math]::Min(300, 15 * [math]::Pow(2, $attempt - 1))
                try {
                    $pause = $DelayMilliseconds + (Get-Random -Minimum 0 -Maximum ($JitterMilliseconds + 1))
                    Start-Sleep -Milliseconds $pause
                    Write-Host "GET  $label (attempt $attempt/$MaxAttempts)"
                    $response = Invoke-WebRequest -Uri $url -UserAgent $userAgent -WebSession $session `
                        -SkipHttpErrorCheck -TimeoutSec 60
                    $status = [int]$response.StatusCode
                    if ($status -in 401, 403) { $stopRun = $true; throw "HTTP $status access denied; stopping requests." }
                    if ($status -eq 429) {
                        $retryAfter = @($response.Headers['Retry-After']) -join ''
                        $seconds = 0
                        $date = [datetimeoffset]::MinValue
                        if ([int]::TryParse($retryAfter, [ref]$seconds)) { $retrySeconds = [math]::Max($retrySeconds, $seconds) }
                        elseif ([datetimeoffset]::TryParse($retryAfter, [ref]$date)) {
                            $retrySeconds = [math]::Max($retrySeconds, [math]::Ceiling(($date - [datetimeoffset]::UtcNow).TotalSeconds))
                        }
                        if ($attempt -eq $MaxAttempts -or $retrySeconds -gt 1800) { $stopRun = $true }
                        throw 'HTTP 429 rate limit.'
                    }
                    if ($status -ne 200) { throw "HTTP $status." }
                    # Buffer the response before touching disk so a sharing violation
                    # never repeats the network request, including the initial write.
                    $buffer = [IO.MemoryStream]::new()
                    try {
                        $response.RawContentStream.Position = 0
                        $response.RawContentStream.CopyTo($buffer)
                        $sourceBytes = $buffer.ToArray()
                    }
                    finally { $buffer.Dispose(); $response.RawContentStream.Dispose() }
                    $sourcePath = $temporaryStem + '.source.html'
                    Invoke-LocalFileOperation 'Write source' $sourcePath { [IO.File]::WriteAllBytes($sourcePath, $sourceBytes) }
                    $html = Invoke-LocalFileOperation 'Read source' $sourcePath { [IO.File]::ReadAllText($sourcePath) }
                    $document = ConvertFrom-ChapterHtml $html $number $entry.Name $chapterNumber $url
                    $htmlPath = $temporaryStem + '.html'
                    $localHtml = ConvertTo-LocalHtml $document
                    Invoke-LocalFileOperation 'Write HTML' $htmlPath { [IO.File]::WriteAllText($htmlPath, $localHtml) }
                    $document | Add-Member SourceSha256 (Get-LocalFileHash $sourcePath)
                    $document | Add-Member HtmlSha256 (Get-LocalFileHash $htmlPath)
                    $jsonPath = $temporaryStem + '.json'
                    $json = $document | ConvertTo-Json -Depth 12
                    Invoke-LocalFileOperation 'Write JSON' $jsonPath { [IO.File]::WriteAllText($jsonPath, $json) }
                    Assert-SavedChapter $temporaryStem $number $chapterNumber
                    foreach ($suffix in '.source.html', '.html', '.json') {
                        $fromPath = $temporaryStem + $suffix
                        $toPath = $stem + $suffix
                        Invoke-LocalFileOperation 'Move' $fromPath { Move-Item -LiteralPath $fromPath -Destination $toPath -Force } $toPath
                    }
                    Write-Host "OK   $label ($($document.VerseCount) verses)"
                    $downloaded++
                    $consecutiveFailures = 0
                    $success = $true
                    break
                }
                catch {
                    if (Test-LocalFileFailure $_.Exception) {
                        $stopRun = $true
                        $retainTemporaryFiles = $true
                        Write-Warning "Retaining unpublished files at '$temporaryStem.*'; local failure will not trigger an HTTP retry."
                    }
                    $reason = $_.Exception.Message
                    Write-Warning "${label}: $reason"
                    if ($stopRun) {
                        $failed.Add("${label}: $reason")
                        throw "Stopped at ${label}: $reason Re-run later to resume; saved chapters are retained."
                    }
                    if ($status -ge 400 -and $status -lt 500 -and $status -ne 429) { break }
                    if ($attempt -lt $MaxAttempts) {
                        Write-Host "WAIT $retrySeconds seconds before retrying $label"
                        Start-Sleep -Seconds $retrySeconds
                    }
                }
                finally {
                    if (-not $retainTemporaryFiles) {
                        foreach ($suffix in '.source.html', '.html', '.json') {
                            $cleanupPath = $temporaryStem + $suffix
                            if (Test-Path -LiteralPath $cleanupPath) {
                                try { Invoke-LocalFileOperation 'Remove temporary file' $cleanupPath { Remove-Item -LiteralPath $cleanupPath -Force } }
                                catch { Write-Warning "Temporary file retained: '$cleanupPath'. $($_.Exception.Message)" }
                            }
                        }
                    }
                }
            }
            if (-not $success) {
                $failed.Add("${label}: $reason")
                $consecutiveFailures++
                if ($consecutiveFailures -ge 3) { throw 'Three consecutive chapters failed; stopping requests. Re-run later to resume.' }
            }
        }
    }
    if ($failed.Count -gt 0) { throw ("Some chapters failed. Re-run to retry them; valid chapters will be skipped.`n" + ($failed -join "`n")) }
}
finally {
    if ($session -is [System.IDisposable]) { $session.Dispose() }
    $downloadLock.Dispose()
    Write-Host "`nDownloaded: $downloaded | Already valid: $skipped | Failed: $($failed.Count)"
    Write-Host "Folder: $outputPath"
}
