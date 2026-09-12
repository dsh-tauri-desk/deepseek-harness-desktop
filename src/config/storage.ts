import { createStorage } from 'unstorage'
import { tauriStorageDriver } from './storage.driver'

export const storage = createStorage({
  driver: tauriStorageDriver({ path: '.store.dat' }),
})
