/** Profile discovery (pure reads; same contract as dsh-plugin-install). */

import { homedir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

/** Profile that boots this UI: `--profile <name>` on the CLI invocation. */
export function argvProfile(argv: readonly string[] = process.argv): string | undefined {
  const flag = argv.indexOf('--profile')
  if (flag !== -1 && flag + 1 < argv.length && !argv[flag + 1].startsWith('-'))
    return argv[flag + 1]
  return undefined
}

/** Directory of a profile under DSH_HOME (default `~/.dsh`). */
export function profileDir(profile: string, dshHome: string | undefined = process.env.DSH_HOME): string {
  const home = dshHome ?? join(homedir(), '.dsh')
  return join(home, 'profiles', profile)
}
