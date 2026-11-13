#Requires -Version 7.0
<# Synthetic fixtures only; no network requests or external test modules. #>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$downloader = Join-Path $PSScriptRoot 'Download-ESVBible.ps1'
$testRoot = Join-Path $PSScriptRoot ('../tmp/esv-tests/' + [guid]::NewGuid().ToString('N'))
$global:EsvDownloaderTestState = @{}
$global:EsvDownloaderTestState.Requests = [System.Collections.Generic.List[object]]::new()
$global:EsvDownloaderTestState.Pauses = [System.Collections.Generic.List[double]]::new()
$global:EsvDownloaderTestState.Responses = [System.Collections.Generic.Queue[object]]::new()
$global:EsvDownloaderTestState.FileFailures = 0
$global:EsvDownloaderTestState.FileFailureSuffix = ''
$global:EsvDownloaderTestState.Moves = [System.Collections.Generic.List[string]]::new()
$global:EsvDownloaderTestState.HeldLock = $null
$global:EsvDownloaderTestState.LockSource = $false
$global:EsvDownloaderTestState.ReleaseOnPause = $false
$fixture = @'
<!doctype html><html><body>
<span class="verse" data-ref="39004006">Previous book.</span>
<h3>Fixture heading &amp; title</h3><h4>A fixture superscription.</h4>
<p><span class="verse" data-ref="40001001"><b class="chapter-num">1&nbsp;</b><u>First &amp; “quoted” </u><span class="small-caps"><u><span class="small-caps-upper">L</span><span class="small-caps-lower">ord</span></u></span><u> line.</u><sup class="crossref"><a title="See fixture" href="/John+1.1/" data-passage="John 1:1">a</a></sup><sup class="footnote"><a href="#f1" title="&lt;span&gt;Or &lt;i&gt;alternative&lt;/i&gt;&lt;/span&gt;">1</a></sup></span></p>
<p class="line"><span class="verse" data-ref="40001001">Second line.</span></p>
<h3>Next heading</h3><p><span class="verse" data-ref="40001002"><b class="verse-num">2&nbsp;</b>Second verse.</span></p>
<h3>Neighbor heading</h3><span class="verse" data-ref="40002001">Next chapter.</span>
</body></html>
'@

function Assert($Condition, [string] $Message) {
    if (-not $Condition) { throw "Assertion failed: $Message" }
}
function Start-Sleep {
    param([double] $Milliseconds = 0, [double] $Seconds = 0)
    $global:EsvDownloaderTestState.Pauses.Add($Milliseconds + 1000 * $Seconds)
    if ($global:EsvDownloaderTestState.ReleaseOnPause -and $null -ne $global:EsvDownloaderTestState.HeldLock -and $Milliseconds -eq 1000) {
        $global:EsvDownloaderTestState.HeldLock.Dispose()
        $global:EsvDownloaderTestState.HeldLock = $null
    }
}
function Invoke-WebRequest {
    param($Uri, $UserAgent, $WebSession, $OutFile, [switch] $PassThru, [switch] $SkipHttpErrorCheck, $TimeoutSec)
    $global:EsvDownloaderTestState.Requests.Add([pscustomobject]@{ Uri = $Uri; UserAgent = $UserAgent })
    if ($global:EsvDownloaderTestState.Responses.Count -eq 0) { throw 'Unexpected network request.' }
    $response = $global:EsvDownloaderTestState.Responses.Dequeue()
    if ($global:EsvDownloaderTestState.LockSource) {
        # The invoked mock inherits the downloader's current temporaryStem.
        $global:EsvDownloaderTestState.HeldLock = [IO.File]::Open($temporaryStem + '.source.html', 'CreateNew', 'ReadWrite', 'None')
    }
    if ($OutFile) { [System.IO.File]::WriteAllText($OutFile, $response.Body) }
    return [pscustomobject]@{ StatusCode = $response.Status; Headers = $response.Headers
        RawContentStream = [IO.MemoryStream]::new([Text.Encoding]::UTF8.GetBytes($response.Body)) }
}
function Move-Item {
    param($LiteralPath, $Destination, [switch] $Force)
    $global:EsvDownloaderTestState.Moves.Add($LiteralPath)
    $matchesSuffix = $LiteralPath.EndsWith($global:EsvDownloaderTestState.FileFailureSuffix)
    if ($global:EsvDownloaderTestState.FileFailureSuffix -eq '.html' -and $LiteralPath.EndsWith('.source.html')) { $matchesSuffix = $false }
    if ($global:EsvDownloaderTestState.FileFailures -gt 0 -and $matchesSuffix) {
        $global:EsvDownloaderTestState.FileFailures--
        throw [IO.IOException]::new('Fixture sharing violation: file in use.')
    }
    Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination -Force:$Force
}
function Queue-Response([int] $Status = 200, [string] $Body = $fixture, [hashtable] $Headers = @{}) {
    $global:EsvDownloaderTestState.Responses.Enqueue([pscustomobject]@{ Status = $Status; Body = $Body; Headers = $Headers })
}
function Invoke-Fixture([string] $Folder, [int] $Attempts = 1) {
    & $downloader -OutputDirectory (Join-Path $testRoot $Folder) -Book 40 -Chapter 1 -MaxAttempts $Attempts
}

Queue-Response
Invoke-Fixture 'valid'
$stem = Join-Path $testRoot 'valid/40-Matthew/001'
$document = Get-Content -LiteralPath ($stem + '.json') -Raw | ConvertFrom-Json
Assert ($document.VerseCount -eq 2) 'exclude neighboring books and chapters'
Assert ($document.Verses[0].Text -eq ('First & “quoted” LORD line.' + "`nSecond line.")) 'merge nested spans, Unicode and poetry without note markers'
Assert ($document.Verses[0].Footnotes[0].Text -eq 'Or alternative') 'decode embedded footnote HTML'
Assert ($document.Verses[0].Footnotes[0].Href -eq 'https://www.esv.org/Matthew+1/#f1') 'resolve footnote links against their chapter URL'
Assert ($document.Verses[0].CrossReferences[0].Passage -eq 'John 1:1') 'preserve cross-reference target'
Assert ($document.Headings.Count -eq 3 -and $document.Headings[2].BeforeVerse -eq 2) 'retain headings and superscription only for the target chapter'
Assert ((Get-Content -LiteralPath ($stem + '.html') -Raw) -match 'First &amp;') 'escape generated HTML'
Assert ($global:EsvDownloaderTestState.Requests[0].UserAgent.StartsWith('Mozilla/')) 'Mozilla User-Agent'
Assert ($global:EsvDownloaderTestState.Requests[0].Uri -eq 'https://www.esv.org/Matthew+1/') 'chapter URL'
Assert ($global:EsvDownloaderTestState.Pauses[0] -ge 5000 -and $global:EsvDownloaderTestState.Pauses[0] -le 8000) 'default request delay'

$count = $global:EsvDownloaderTestState.Requests.Count
Invoke-Fixture 'valid'
Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count) 'resume without a network request'
[System.IO.File]::AppendAllText($stem + '.source.html', 'corruption')
Queue-Response
Invoke-Fixture 'valid'
Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count + 1) 'replace a saved chapter whose checksum failed'
Remove-Item -LiteralPath ($stem + '.html')
Queue-Response
Invoke-Fixture 'valid'
Assert (Test-Path -LiteralPath ($stem + '.html')) 'repair a missing generated file'

$sourceHash = (Get-FileHash -LiteralPath ($stem + '.source.html')).Hash
Queue-Response -Body '<html><body>Unavailable</body></html>'
$errorText = ''
try { & $downloader -OutputDirectory (Join-Path $testRoot 'valid') -Book 40 -Chapter 1 -MaxAttempts 1 -Force } catch { $errorText = $_.Exception.Message }
Assert ($errorText -match 'Some chapters failed') 'report a failed forced replacement'
Assert ((Get-FileHash -LiteralPath ($stem + '.source.html')).Hash -eq $sourceHash) 'retain good files after a failed forced replacement'

$folderLock = [IO.File]::Open((Join-Path $testRoot 'valid/.download.lock'), 'Open', 'ReadWrite', 'None')
$count = $global:EsvDownloaderTestState.Requests.Count
try {
    $errorText = ''
    try { Invoke-Fixture 'valid' } catch { $errorText = $_.Exception.Message }
    Assert ($errorText -match 'Cannot lock') 'reject overlapping runs'
    Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count) 'no requests from an overlapping run'
}
finally { $folderLock.Dispose() }

Queue-Response -Status 429 -Headers @{ 'Retry-After' = '37' }
Queue-Response
Invoke-Fixture 'rate-limit' 2
Assert ($global:EsvDownloaderTestState.Pauses.Contains(37000)) 'honor Retry-After before retrying'

Queue-Response -Status 429 -Headers @{ 'Retry-After' = ([datetimeoffset]::UtcNow.AddSeconds(90).ToString('r')) }
Queue-Response
Invoke-Fixture 'rate-limit-date' 2
Assert (@($global:EsvDownloaderTestState.Pauses | Where-Object { $_ -ge 80000 -and $_ -le 90000 }).Count -eq 1) 'honor an HTTP-date Retry-After'

Queue-Response -Status 429 -Headers @{ 'Retry-After' = '3600' }
$count = $global:EsvDownloaderTestState.Requests.Count
$errorText = ''
try { Invoke-Fixture 'rate-limit-long' 3 } catch { $errorText = $_.Exception.Message }
Assert ($errorText -match 'Stopped at Matthew 1' -and $global:EsvDownloaderTestState.Requests.Count -eq $count + 1) 'stop rather than retry early when Retry-After exceeds the wait limit'

foreach ($status in 403, 429) {
    $count = $global:EsvDownloaderTestState.Requests.Count
    Queue-Response -Status $status
    $errorText = ''
    try { Invoke-Fixture "stop-$status" } catch { $errorText = $_.Exception.Message }
    Assert ($errorText -match 'Stopped at Matthew 1') "stop on HTTP $status"
    Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count + 1) "no extra requests after HTTP $status"
}

foreach ($bad in @('<html><body>Please sign in</body></html>', ($fixture -replace '</html>', ''),
    ($fixture -replace '<span class="verse" data-ref="40001002">', '<span class="verse" data-ref="40001002"><span>'))) {
    Queue-Response -Body $bad
    $folder = 'bad-' + [guid]::NewGuid().ToString('N')
    $errorText = ''
    try { Invoke-Fixture $folder } catch { $errorText = $_.Exception.Message }
    Assert ($errorText -match 'Some chapters failed') 'reject login, incomplete HTML and unbalanced verse spans'
    Assert (-not (Test-Path (Join-Path $testRoot "$folder/40-Matthew/001.json"))) 'never publish invalid content'
}
$count = $global:EsvDownloaderTestState.Requests.Count
$errorText = ''
try { & $downloader -OutputDirectory (Join-Path $testRoot 'invalid-scope') -Book 40 -Chapter 29 } catch { $errorText = $_.Exception.Message }
Assert ($errorText -match 'only 28 chapters') 'reject invalid chapter selection'
Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count) 'validate scope before requests'
Assert (@(Get-ChildItem -LiteralPath $testRoot -Recurse -Filter '.esv-*').Count -eq 0) 'clean partial files after errors'

# Fail at each publication step, including after the source has already moved.
foreach ($suffix in '.source.html', '.html', '.json') {
    $global:EsvDownloaderTestState.FileFailureSuffix = $suffix
    $global:EsvDownloaderTestState.FileFailures = 1
    $count = $global:EsvDownloaderTestState.Requests.Count
    Queue-Response
    $folder = 'local-retry-' + $suffix.TrimStart('.')
    $log = Invoke-Fixture $folder 3 *>&1 | Out-String
    Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count + 1) "retry $suffix publication without another HTTP request"
    Assert (Test-Path (Join-Path $testRoot "$folder/40-Matthew/001.json")) "complete $suffix publication after a transient failure"
    Assert ($log -match 'LOCAL.*operation=Move' -and $log -match 'source=' -and $log -match 'destination=' -and
        $log -match 'IOException' -and $log -match 'HResult=' -and $log -match 'attempt=1/5' -and
        $log -match 'LOCAL RECOVERED') 'log operation, both paths, exception, attempt and recovery'
}
$global:EsvDownloaderTestState.FileFailureSuffix = '.json'
$global:EsvDownloaderTestState.FileFailures = 10
$count = $global:EsvDownloaderTestState.Requests.Count
Queue-Response
$errorText = ''
try { Invoke-Fixture 'local-exhausted' 3 } catch { $errorText = $_.Exception.Message }
Assert ($errorText -match 'Stopped at Matthew 1' -and $errorText -match 'Local file operation') 'stop when local retries are exhausted'
Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count + 1) 'exhausted local retries never trigger another HTTP request'
Assert (-not (Test-Path (Join-Path $testRoot 'local-exhausted/40-Matthew/001.json'))) 'never mark an interrupted save complete'
Assert (@(Get-ChildItem -LiteralPath (Join-Path $testRoot 'local-exhausted') -Recurse -Filter '.esv-*.json').Count -eq 1) 'retain unpublished files for diagnosis after exhausted retries'
$global:EsvDownloaderTestState.FileFailures = 0

if ($IsWindows) {
    # Actual Windows sharing violations exercise writes and resume reads, rather
    # than only injected exceptions at publication. Release during the local wait.
    $global:EsvDownloaderTestState.LockSource = $true
    $global:EsvDownloaderTestState.ReleaseOnPause = $true
    Queue-Response
    $count = $global:EsvDownloaderTestState.Requests.Count
    try { $log = Invoke-Fixture 'real-lock' 3 *>&1 | Out-String }
    finally {
        $global:EsvDownloaderTestState.LockSource = $false
        if ($null -ne $global:EsvDownloaderTestState.HeldLock) { $global:EsvDownloaderTestState.HeldLock.Dispose() }
    }
    Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count + 1) 'an actual locked source write recovers with one HTTP request'
    Assert ($log -match 'operation=Write source' -and $log -match 'HResult=80070020' -and $log -match 'LOCAL RECOVERED') 'identify an actual Windows sharing violation'

    $lockedJson = Join-Path $testRoot 'real-lock/40-Matthew/001.json'
    $global:EsvDownloaderTestState.HeldLock = [IO.File]::Open($lockedJson, 'Open', 'ReadWrite', 'None')
    $count = $global:EsvDownloaderTestState.Requests.Count
    try { $log = Invoke-Fixture 'real-lock' 3 *>&1 | Out-String }
    finally { if ($null -ne $global:EsvDownloaderTestState.HeldLock) { $global:EsvDownloaderTestState.HeldLock.Dispose() } }
    Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count) 'a locked saved JSON read recovers without treating the chapter as corrupt'
    Assert ($log -match 'operation=Read JSON' -and $log -match 'SKIP Matthew 1') 'log and recover a resume read'

    $global:EsvDownloaderTestState.HeldLock = [IO.File]::Open((Join-Path $testRoot 'real-lock/40-Matthew/001.source.html'), 'Open', 'ReadWrite', 'None')
    try { $log = Invoke-Fixture 'real-lock' 3 *>&1 | Out-String }
    finally { if ($null -ne $global:EsvDownloaderTestState.HeldLock) { $global:EsvDownloaderTestState.HeldLock.Dispose() } }
    Assert ($global:EsvDownloaderTestState.Requests.Count -eq $count) 'a locked hash read recovers without another HTTP request'
    Assert ($log -match 'operation=Hash' -and $log -match 'LOCAL RECOVERED') 'identify the failing hash operation'

    $global:EsvDownloaderTestState.ReleaseOnPause = $false
    $global:EsvDownloaderTestState.HeldLock = [IO.File]::Open($lockedJson, 'Open', 'ReadWrite', 'None')
    $errorText = ''
    try { Invoke-Fixture 'real-lock' 3 *>&1 | Out-Null } catch { $errorText = $_.Exception.Message }
    finally { $global:EsvDownloaderTestState.HeldLock.Dispose(); $global:EsvDownloaderTestState.HeldLock = $null }
    Assert ($errorText -match 'Local file operation failed' -and $global:EsvDownloaderTestState.Requests.Count -eq $count) 'an exhausted resume read stops without another HTTP request'
}
Write-Host 'PASS: extraction, resume, corruption recovery, file retention, local retries without repeat requests, operation diagnostics, throttling and HTTP error handling.'
