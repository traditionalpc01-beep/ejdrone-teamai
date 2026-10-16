param([string]$File, [int]$Line = 1, [int]$MaxChars = 1800)
$all = [System.IO.File]::ReadAllLines($File)
$o = $all[$Line-1] | ConvertFrom-Json
"LINE $Line startedAt=$($o.startedAt) messageCount=$($o.request.messageCount)"
$msgs = $o.request.messages
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
      elseif ($c.type -eq 'tool_use') { $parts += "[tool_use:$($c.name)] " + ($c.input | ConvertTo-Json -Depth 10 -Compress) }
      elseif ($c.type -eq 'tool_result') {
        $t = ''
        if ($c.content -is [string]) { $t = $c.content } else { $t = ($c.content | ForEach-Object { $_.text }) -join ' ' }
        $parts += "[tool_result] $t"
      }
    }
    $text = $parts -join ' || '
  }
  if ($text.Length -gt $MaxChars) { $text = $text.Substring(0, $MaxChars) + ' ...[trunc]' }
  "--- [$j] $role ---"
  $text
}