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

  it('does not rebuild cpu-features as a target', () => {
    // The build script may mention cpu-features in comments explaining why --only is used,
    // but it should never pass cpu-features as a rebuild target
    const lines = buildScript.split('\n')
    const rebuildLines = lines.filter(
      (line) => line.includes('electron-rebuild') && !line.trimStart().startsWith('#')
    )
    for (const line of rebuildLines) {
      expect(line).not.toContain('cpu-features')
    }
  })
})
