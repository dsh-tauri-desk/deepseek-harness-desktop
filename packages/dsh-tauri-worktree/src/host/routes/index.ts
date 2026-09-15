import { defineRoutes } from 'dsh-tauri'
import { WORKTREE_API_PREFIX } from '../../shared/constants'
import attach from './attach/post'
import bindings from './bindings/get'
import checkout from './checkout/post'
import deleteWorktree from './delete'
import postWorktree from './post'
import status from './status/get'

export const routes = defineRoutes((disposer) => {
  disposer.post({ kind: 'exact', path: WORKTREE_API_PREFIX }, postWorktree)
  disposer.delete({ kind: 'exact', path: WORKTREE_API_PREFIX }, deleteWorktree)
  disposer.get({ kind: 'exact', path: `${WORKTREE_API_PREFIX}/bindings` }, bindings)
  disposer.get({ kind: 'exact', path: `${WORKTREE_API_PREFIX}/status` }, status)
  disposer.post({ kind: 'exact', path: `${WORKTREE_API_PREFIX}/attach` }, attach)
  disposer.post({ kind: 'exact', path: `${WORKTREE_API_PREFIX}/checkout` }, checkout)
})
