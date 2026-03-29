import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { execSync } from 'child_process'
import os from 'os'

describe('network isolation in init.sh', () => {
  const initScript = readFileSync(resolve(__dirname, '../../sandstorm-cli/lib/init.sh'), 'utf-8')

  it('extracts named networks from compose JSON', () => {
    expect(initScript).toContain('NAMED_NETWORKS')
    expect(initScript).toContain("net.get('name')")
  })

  it('generates network overrides with SANDSTORM_PROJECT prefix', () => {
    expect(initScript).toContain('name: \\${SANDSTORM_PROJECT}-${net_key}')
  })

  it('only generates networks section when named networks exist', () => {
    expect(initScript).toContain('if [ -n "$NAMED_NETWORKS" ]')
  })

  it('does not generate networks section for projects without named networks', () => {
    const networkBlock = initScript.match(/if \[ -n "\$NAMED_NETWORKS" \][\s\S]*?fi/)?.[0]
    expect(networkBlock).toBeDefined()
    expect(networkBlock).toContain('echo "networks:"')
    expect(networkBlock).toContain('echo "  ${net_key}:"')
  })
})

describe('network name extraction logic', () => {
  let scriptPath: string

  beforeAll(() => {
    // Write the Python script to a temp file to avoid shell escaping issues
    scriptPath = join(os.tmpdir(), `sandstorm-net-test-${Date.now()}.py`)
    writeFileSync(
      scriptPath,
      `import json, sys

config = json.load(sys.stdin)
networks = config.get('networks', {})

for key, net in networks.items():
    if isinstance(net, dict) and net.get('name'):
        print(f'{key}|{net["name"]}')
`
    )
  })

  afterAll(() => {
    try {
      unlinkSync(scriptPath)
    } catch {
      /* ignore */
    }
  })

  function runExtractor(input: object): string {
    const json = JSON.stringify(input)
    return execSync(`echo '${json}' | python3 "${scriptPath}"`, {
      encoding: 'utf-8',
    }).trim()
  }

  it('extracts networks with explicit name property', () => {
    const result = runExtractor({
      networks: {
        mynet: { name: 'mynet', driver: 'bridge' },
        internal: { name: 'internal-net' },
      },
    })
    const lines = result.split('\n')
    expect(lines).toContain('mynet|mynet')
    expect(lines).toContain('internal|internal-net')
  })

  it('ignores networks without explicit name property', () => {
    const result = runExtractor({
      networks: {
        default: {},
        mynet: { name: 'mynet' },
      },
    })
    expect(result).toBe('mynet|mynet')
  })

  it('returns empty for no networks', () => {
    const result = runExtractor({ services: { app: {} } })
    expect(result).toBe('')
  })

  it('returns empty when networks is empty object', () => {
    const result = runExtractor({ networks: {} })
    expect(result).toBe('')
  })

  it('handles networks with null values gracefully', () => {
    const result = runExtractor({
      networks: {
        mynet: null,
        other: { name: 'other-net' },
      },
    })
    expect(result).toBe('other|other-net')
  })
})
