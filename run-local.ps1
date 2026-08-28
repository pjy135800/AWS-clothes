$ErrorActionPreference = "Stop"

$localNode = Get-Command node -ErrorAction SilentlyContinue
$bundledNode = "C:\Users\LG\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if ($localNode) {
  & $localNode.Source server.js
} elseif (Test-Path $bundledNode) {
  & $bundledNode server.js
} else {
  Write-Host "Node.js를 찾지 못했습니다. Node 18 이상을 설치한 뒤 다시 실행해 주세요."
  exit 1
}
