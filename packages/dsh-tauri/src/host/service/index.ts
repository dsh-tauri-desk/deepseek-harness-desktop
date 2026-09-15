type ServiceMethod = (...args: any[]) => any

/** 编译期约束成员全为函数（散装状态留在模块作用域）；运行时原样返回，零开销。 */
export function defineService<T extends Record<string, ServiceMethod>>(service: T): T {
  return service
}
