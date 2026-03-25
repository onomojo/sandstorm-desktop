import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { resolve } from 'path'

describe('build script (scripts/build.sh)', () => {
  const buildScript = readFileSync(resolve(__dirname, '../../scripts/build.sh'), 'utf-8')

  it('uses --only better-sqlite3 for electron-rebuild', () => {
    expect(buildScript).toContain('npx electron-rebuild --only better-sqlite3')
  })

  it('does not use bare electron-rebuild without --only', () => {
    const lines = buildScript.split('\n')
    const rebuildLines = lines.filter(
      (line) => line.includes('electron-rebuild') && !line.trimStart().startsWith('#')
    )
    for (const line of rebuildLines) {
      expect(line).toContain('--only')
    }
  })

  it('does not use set +e workaround for rebuild failures', () => {
    expect(buildScript).not.toContain('set +e')
  })

  it('does not contain cpu-features warning message', () => {
    expect(buildScript).not.toContain('cpu-features')
  })
})
