param([string]$File)

$all = [System.IO.File]::ReadAllLines($File)
"=== $File : $($all.Count) lines ==="
for ($i = 0; $i -lt $all.Count; $i++) {
  $line = $all[$i]
  try { $o = $line | ConvertFrom-Json } catch { "[$($i+1)] PARSE_FAIL len=$($line.Length)"; continue }
  $keys = ($o.PSObject.Properties.Name) -join ','
  $msgs = $o.request.body.messages
  $mc = if ($msgs) { $msgs.Count } else { '-' }
  $reqKeys = if ($o.request) { ($o.request.PSObject.Properties.Name) -join '/' } else { '-' }
  $bodyKeys = if ($o.request.body) { ($o.request.body.PSObject.Properties.Name) -join '/' } else { '-' }
  "[$($i+1)] len=$($line.Length) type=$($o.type) msgs=$mc reqKeys=$reqKeys bodyKeys=$bodyKeys"
}