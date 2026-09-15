export type InvokeArgs = Record<string, unknown> | number[] | ArrayBuffer | Uint8Array
export type UnlistenFn = () => void

export interface InvokeOptions {
  headers: HeadersInit
}

export interface TauriEvent<T> {
  event: string
  id: number
  payload: T
}

export type EventCallback<T> = (event: TauriEvent<T>) => void

export interface Options {
  target?: string | EventTarget
}
