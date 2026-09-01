import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { resolve } from 'pathe'
import { describe, expect, it } from 'vitest'
import { projectDirname } from './git'

describe('projectDirname', () => {
  it('resolves relative project paths before deriving the title', () => {
    expect(projectDirname('.')).toBe(workspaceTitleOf(resolve('.')))
  })

  it('accepts a trailing path separator', () => {
    expect(projectDirname('/workspace/example/')).toBe('example')
  })
})
