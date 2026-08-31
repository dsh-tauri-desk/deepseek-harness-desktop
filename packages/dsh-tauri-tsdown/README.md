# dsh-tauri-tsdown

`dsh-tauri-tsdown` 是本 monorepo 内部使用的 tsdown 配置与类型辅助包，用于统一各插件的 ESM 构建、声明文件生成和导出配置。

## 使用范围

该包标记为 private，不应被应用直接安装或作为运行时插件启用。开发者通常只需要在工作区根目录运行：

```bash
pnpm build
```

各工作区插件会复用此包提供的构建约定。

## 许可证

[MIT](../../LICENSE.md) © [Hairyf](https://github.com/hairyf)
