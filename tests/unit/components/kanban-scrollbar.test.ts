import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'

describe('Kanban board scrollbar CSS', () => {
  const css = readFileSync('src/renderer/index.css', 'utf-8')

  it('has board-scoped scrollbar width and height of 16px', () => {
    expect(css).toMatch(/\[data-testid="kanban-columns"\]::-webkit-scrollbar\s*\{[^}]*width:\s*16px/)
    expect(css).toMatch(/\[data-testid="kanban-columns"\]::-webkit-scrollbar\s*\{[^}]*height:\s*16px/)
  })

  it('has board-scoped scrollbar-thumb border-radius of 8px', () => {
    expect(css).toMatch(/\[data-testid="kanban-columns"\]::-webkit-scrollbar-thumb\s*\{[^}]*border-radius:\s*8px/)
  })

  it('global scrollbar rule still has width and height of 6px', () => {
    const globalScrollbarMatch = css.match(/::-webkit-scrollbar\s*\{([^}]*)\}/)
    expect(globalScrollbarMatch).not.toBeNull()
    const globalBlock = globalScrollbarMatch![1]
    expect(globalBlock).toMatch(/width:\s*6px/)
    expect(globalBlock).toMatch(/height:\s*6px/)
  })
})
