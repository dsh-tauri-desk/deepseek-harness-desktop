export interface PlatformPluginLoader {
  import: (name: string) => Promise<unknown>
  unwrapExports: (exports: unknown) => unknown
}

export interface FilesystemSkillPlugin {
  name: string
  apply: (context: unknown, config?: unknown) => void
}

export interface PluginFiber {
  dispose: () => Promise<void>
}

export interface ProviderRuntime {
  fiber: PluginFiber | undefined
  chain: Promise<void>
  disposed: boolean
}
