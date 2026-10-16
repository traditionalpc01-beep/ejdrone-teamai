param([string]$File, [int]$LastN = 1, [int]$MaxChars = 400, [int]$FirstN = 0)

$all = [System.IO.File]::ReadAllLines($File)
"TOTAL LINES: $($all.Count)"
$start = if ($FirstN -gt 0) { 0 } else { [Math]::Max(0, $all.Count - $LastN) }
$end = if ($FirstN -gt 0) { [Math]::Min($all.Count, $FirstN) } else { $all.Count }
for ($i = $start; $i -lt $end; $i++) {
  $line = $all[$i]
  "===== LINE $($i+1) | len=$($line.Length) ====="
  try { $o = $line | ConvertFrom-Json } catch { "  PARSE_FAIL: $($_.Exception.Message)"; continue }
  "  startedAt=$($o.startedAt) messageCount=$($o.request.messageCount)"
  $msgs = $o.request.messages
  if ($null -eq $msgs) { "  (no messages)"; }
  else {
    "  MESSAGES: $($msgs.Count)"
    $j = 0
    foreach ($m in $msgs) {
      $j++
      $role = $m.role
      $text = ''
      if ($m.content -is [string]) { $text = $m.content }
      elseif ($m.content) {
        $parts = @()
        foreach ($c in $m.content) {
          if ($c.type -eq 'text') { $parts += $c.text }
          elseif ($c.type -eq 'tool_use') { $parts += "[tool_use:$($c.name)] " + ($c.input | ConvertTo-Json -Depth 8 -Compress) }
          elseif ($c.type -eq 'tool_result') {
            $t = ''
            if ($c.content -is [string]) { $t = $c.content } else { $t = ($c.content | ForEach-Object { $_.text }) -join ' ' }
            $parts += "[tool_result] $t"
          }
        }
        $text = $parts -join ' || '
      }
      if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) + ' ...[trunc]' }
      "[$j] $role :: $text"
    }
  }
  $resp = $o.response
  if ($resp) {
    $rtext = ''
    if ($resp.content) {
      $rp = @()
      foreach ($c in $resp.content) {
        if ($c.type -eq 'text') { $rp += $c.text }
        elseif ($c.type -eq 'tool_use') { $rp += "[tool_use:$($c.name)] " + ($c.input | ConvertTo-Json -Depth 8 -Compress) }
      }
      $rtext = $rp -join ' || '
    } elseif ($resp -is [string]) { $rtext = $resp }
    if ($rtext.Length -gt 1500) { $rtext = $rtext.Substring(0, 1500) + ' ...[trunc]' }
    "  --- RESPONSE --- $rtext"
  }
}