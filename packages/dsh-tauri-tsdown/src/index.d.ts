/* eslint-disable ts/explicit-function-return-type */
export interface DshConfig {
  /**
   * Package-level publint toggle (defaults to `true`). Turn it off for packages
   * whose client bundle inlines CJS deps (e.g. css-render) that publint's static
   * scan mistakes for `exports.__esModule + exports.default` — the assignment
   * lives in a sealed module wrapper and never reaches the real module exports.
   */
  publint?: UserConfig['publint']
  server?: UserConfig
  client?: UserConfig
}

export const defineDshConfig = (options?: DshConfig) => any
