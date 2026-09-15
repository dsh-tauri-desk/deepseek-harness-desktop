# macOS 签名与公证

项目通过 GitHub Releases 分发 DMG，因此使用 `Developer ID Application` 证书，而不是用于 Mac App Store 的 `Apple Distribution` 证书。发布工作流会完成 Hardened Runtime 签名、Apple 公证和 ticket staple，并在构建后用 `codesign`、`stapler` 与 Gatekeeper 再次校验产物。

## 准备证书

需要有效的 Apple Developer Program 会员资格。只有团队的 Account Holder 能创建 `Developer ID Application` 证书。

1. 在 macOS 的“钥匙串访问”中打开“证书助理 → 从证书颁发机构请求证书”，生成 CSR 并存储到磁盘。
2. 打开 [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/certificates/list)，新建 `Developer ID Application` 证书并上传 CSR。
3. 下载 `.cer` 并双击安装到 `login` 钥匙串。
4. 在“我的证书”中展开该证书，确认下面存在对应私钥。
5. 执行以下命令，输出应包含 `Developer ID Application: ... (TEAM_ID)`：

```bash
security find-identity -v -p codesigning
```

在“钥匙串访问 → 我的证书”中将证书连同私钥导出为有密码保护的 `.p12` 文件。不要把 CSR 私钥、`.p12`、密码或后续生成的文本提交到仓库。

## 配置 GitHub Actions Secrets

先把 `.p12` 转成单行 Base64 并复制到剪贴板：

```bash
openssl base64 -A -in /path/to/DeveloperIDApplication.p12 | pbcopy
```

再进入 GitHub 仓库的 Settings → Secrets and variables → Actions，添加以下 Repository secrets：

| Secret | 值 |
| --- | --- |
| `APPLE_CERTIFICATE` | 剪贴板中的 `.p12` Base64 文本 |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_ID` | Apple Developer 账户邮箱 |
| `APPLE_PASSWORD` | 在 [Apple Account](https://account.apple.com/) 创建的 App 专用密码，不是账户登录密码 |
| `APPLE_TEAM_ID` | [Membership details](https://developer.apple.com/account/#/membership/) 中的 Team ID |

`TAURI_SIGNING_PRIVATE_KEY` 与 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 是 Tauri 自动更新文件的签名凭据，和 Apple 代码签名是两套独立凭据，仍需保留。

当前 Tauri 2 bundler 会从 `APPLE_CERTIFICATE` 自动建立临时 Keychain、导入证书并在结束后清理，因此不需要额外保存 `KEYCHAIN_PASSWORD`。工作流只把 Apple 凭据传给 macOS 构建；任一 Secret 缺失都会在打包前失败。

## 本地验证

证书安装到本机 Keychain 后，可以临时设置公证凭据并构建。`APPLE_PASSWORD` 必须是 App 专用密码：

```bash
export APPLE_SIGNING_IDENTITY='Developer ID Application: Your Name (TEAM_ID)'
export APPLE_ID='your-apple-id@example.com'
export APPLE_PASSWORD='xxxx-xxxx-xxxx-xxxx'
export APPLE_TEAM_ID='TEAM_ID'
pnpm tauri build --bundles app,dmg
```

构建完成后验证 `.app`。同时指定 `app,dmg` 会保留可供校验的 app；Tauri 会在生成 DMG 前对它完成公证与 staple：

```bash
APP_PATH='src-tauri/target/release/bundle/macos/Deepseek Harness Desktop.app'
codesign --verify --deep --strict --verbose=2 "$APP_PATH"
xcrun stapler validate "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
```

终端中的敏感环境变量用完后应关闭该终端窗口。不要把这些 `export` 写进仓库文件或 shell 配置。

## 发布

推送 `v*` tag 会构建 Intel 与 Apple Silicon 两个经过签名和公证的 DMG。也可以先从 Actions 手动运行 `Build & Release` 并只选择一个 macOS 架构；手动构建同样执行完整签名、公证与校验。
