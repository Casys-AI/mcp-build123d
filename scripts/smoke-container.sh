#!/usr/bin/env bash
# Smoke the published provider contract through both transports. The HTTP call
# and native stdio call each perform an actual OCCT Box calculation.
set -euo pipefail

image="${1:?usage: smoke-container.sh IMAGE}"
container="mcp-build123d-smoke-${RANDOM}"

cleanup() {
  docker rm --force "$container" >/dev/null 2>&1 || true
}
trap cleanup EXIT

docker run --detach --name "$container" --publish 127.0.0.1::3014 "$image" >/dev/null
port="$(docker port "$container" 3014/tcp | sed -E 's/.*:([0-9]+)$/\1/')"

for _ in $(seq 1 30); do
  if curl --fail --silent "http://127.0.0.1:${port}/health" >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent "http://127.0.0.1:${port}/health" >/dev/null

http_response="$(curl --fail --silent \
  --header 'Content-Type: application/json' \
  --header 'MCP-Protocol-Version: 2026-07-28' \
  --header 'Mcp-Method: tools/call' \
  --header 'Mcp-Name: build123d_execute' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"build123d_execute","arguments":{"script":"from build123d import *\nresult = Box(10, 10, 10)"}}}' \
  "http://127.0.0.1:${port}/mcp")"
printf '%s' "$http_response" | jq --exit-status \
  '((.result.structuredContent.metrics.volume_mm3 - 1000) | fabs) < 0.000001' >/dev/null

stdio_response="$(printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}},"name":"build123d_execute","arguments":{"script":"from build123d import *\nresult = Box(10, 10, 10)"}}}' \
  | timeout 30 docker run --rm --interactive --entrypoint deno "$image" \
    run -A server.ts --stdio)"
printf '%s' "$stdio_response" | jq --exit-status \
  '((.result.structuredContent.metrics.volume_mm3 - 1000) | fabs) < 0.000001' >/dev/null
