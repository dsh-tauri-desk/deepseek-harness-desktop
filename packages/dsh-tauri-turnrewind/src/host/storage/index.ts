import { DSH_HOME, fsAtomicDriver } from 'dsh-tauri'
import { join } from 'pathe'
import { createStorage } from 'unstorage'
import { LEDGER_SUBDIR, SNAPSHOT_FEATURE_DIR } from '../config/constants'

export const storage = createStorage({ driver: fsAtomicDriver({ base: join(DSH_HOME, SNAPSHOT_FEATURE_DIR, LEDGER_SUBDIR) }) })
