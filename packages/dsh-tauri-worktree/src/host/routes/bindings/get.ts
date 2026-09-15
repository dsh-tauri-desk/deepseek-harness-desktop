import { existsSync } from 'node:fs'
import { defineEventHandler } from 'dsh-tauri'
import { cleaner } from '../../service/cleaner'
import { ledger } from '../../service/ledger'

export default defineEventHandler(async () => ({
  bindings: ledger.list()
    .filter(binding => binding.worktreePath && existsSync(binding.worktreePath))
    .map(binding => ({
      sessionId: binding.sessionId,
      sourceSessionId: binding.sourceSessionId ?? '',
      hash: binding.hash,
      dirname: binding.dirname,
      worktreeKey: `${binding.hash}/${binding.dirname}`,
      worktreePath: binding.worktreePath,
      projectPath: binding.projectPath,
      log: Array.isArray(binding.log) ? binding.log : [],
    })),
  jobs: cleaner.unsettled().map(job => ({
    sessionId: job.sessionId,
    jobId: job.jobId,
    state: job.state,
    error: job.error,
    worktreeKey: job.worktreeKey,
    worktreePath: job.worktreePath,
  })),
}))
