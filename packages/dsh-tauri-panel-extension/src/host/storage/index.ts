import { DSH_HOME, fsAtomicDriver } from 'dsh-tauri'
import { join } from 'pathe'
import { createStorage } from 'unstorage'
import { SKILL_DATA_DIRECTORY } from '../config/constants'

export const storage = createStorage({ driver: fsAtomicDriver({ base: join(DSH_HOME, SKILL_DATA_DIRECTORY) }) })
