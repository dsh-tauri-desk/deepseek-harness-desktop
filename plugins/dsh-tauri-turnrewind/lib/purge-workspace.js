import process from 'node:process'
import { purgeWorkspace, resolveRootDir } from './core/maintenance.js'

function usage() {
  console.error('Usage: node purge-workspace.js <workspace-dir> [--home <dsh-home>]')
  console.error('')
  console.error('Removes the turnrewind snapshot repository and all ledger rows bound to')
  console.error('one workspace. Stop the DSH host process before running this command.')
  console.error('Defaults to the release data home (~/.dsh); pass --home or set DSH_HOME')
  console.error('to target the debug home (~/.dsh.dev).')
}

function main() {
  const args = process.argv.slice(2)
  const positional = []
  let home
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--home') {
      home = args[index + 1]
      index += 1
      continue
    }
    positional.push(args[index])
  }
  if (positional.length !== 1) {
    usage()
    process.exit(1)
  }

  const rootDir = resolveRootDir(home)
  const summary = purgeWorkspace(rootDir, positional[0])
  console.error(`turnrewind root: ${summary.rootDir}`)
  console.error(`snapshot repo: ${summary.repoDir} (${summary.repoExisted ? 'removed' : 'not found'})`)
  if (summary.ledger)
    console.error(`ledger rows removed: ${JSON.stringify(summary.ledger)}`)
  else
    console.error('ledger: not found, nothing to purge')
}

main()
