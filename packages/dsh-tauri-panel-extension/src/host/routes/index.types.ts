export interface ExtensionRouteDeps {
  profileDirPath: string
  remountProvider: () => Promise<void>
}
