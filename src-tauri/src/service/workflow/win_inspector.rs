//! Windows 极简模式（Minimal）修复：win32 terminal inspector 挂载 + 用户 preset。
//!
//! 极简模式在 Windows 上有两层故障，本模块处理后一层（挂载与 preset 落盘），
//! 前一层（插件安装）走预装插件流程（`service/plugin`）：
//!
//! 1. **终端检查缺失**：`@deepseek-ai/dsh-subprocess-local` 的
//!    `createProcessInspector()` 只在 linux/darwin 实现，win32 上 persistent
//!    shell spawn 时在 PTY 之前直接 throw
//!    `subprocess-local: terminal inspection is unsupported on platform win32`
//!    （上游未修，见 issue #12）。
//!    修复：社区插件 [clearkurt/dsh-win-terminal-inspector]（MIT）包装运行时
//!    实例的 `spawnTerminal`，利用公开测试钩子 `terminalInspector` 注入
//!    `WindowsProcessInspector`，不修改任何 node_modules 官方包。该插件由预装
//!    向导通过 `dsh plugin add github:clearkurt/dsh-win-terminal-inspector`
//!    装入 profile 的 node_modules（Git 依赖，主键即包名），**桌面端仓库不内置
//!    任何插件源码**；本模块随后写入 profile 的 `cordis.patch.yml` 显式入口
//!    挂载行，并创作 Windows 用户 preset。
//!
//! 2. **preset 自身在 Windows 不可用**：agent preset 的组成（`agent.cordis.yml`）
//!    由每次会话直接从磁盘文件挂载（`dsh-agent-presets::mountPreset`），
//!    **不受 profile 的 `cordis.patch.yml` 管辖**——在 patch 里覆写
//!    `terminal-bash` 行不会作用到极简模式；且 shipped preset 是只读的、
//!    升级会被覆盖。按官方规则，正确的做法是在用户根
//!    `${DSH_HOME}/.agent-presets/<id>/` **创作一个用户 preset**（复制 minimal
//!    后做 Windows 修正）：
//!    - `terminal-bash.shellPath` 指向本机 Git Bash（默认 `/bin/bash` 在
//!      Windows 上不是有效路径，spawn 必败）；
//!    - persistent-shell 组内放一个 `sandbox-policy`（`danger-full-access`）：
//!      Git Bash（MSYS）在 `workspace-write` 的受限令牌下无法初始化信号管道
//!      （cygheap/ACL 错误），必须让 shell 在非受限令牌下运行。
//!      代价：该 preset 的 shell 不受文件沙箱约束（与 clearkurt 的 minimal-win
//!      方案一致）；若要在受限模式下用 Git Bash，需改官方
//!      `dsh-sandbox-windows-acl` 的令牌构造，属后续工作。
//!
//! 幂等：patch 与 preset 均为“已存在即跳过”；`apply` 仅在插件确实已装入
//! profile 时才会写 patch（避免挂载一个不存在的包导致 loader 报错）。

#[cfg(windows)]
mod imp {
    use std::fs;
    use std::path::{Path, PathBuf};

    /// 插件在 profile package.json dependencies 中的依赖名（Git 依赖的主键）。
    const PLUGIN_DEP_NAME: &str = "dsh-win-terminal-inspector";

    /// cordis.patch.yml 追加的挂载行（顶层数组的一个 `- insert:` 元素）。
    ///
    /// name 用相对 profile 目录的显式入口（`./node_modules/.../index.js`），不用裸包名或目录：
    /// dsh loader 对 profile patch 条目的模块解析以 harness 安装为 baseUrl，
    /// 裸插件名无法可靠解析，Node ESM 也不支持相对目录导入；显式文件路径经
    /// `new URL(name, baseUrl)` 基于 profile 目录解析，稳定指向插件入口。
    const PATCH_ENTRY: &str = concat!(
        "- insert:\n",
        "    - id: win-terminal-inspector\n",
        "      name: ./node_modules/dsh-win-terminal-inspector/index.js\n",
    );

    /// 注入判定标记：patch 中出现该字符串即视为已挂载。
    const PATCH_MARKER: &str = "dsh-win-terminal-inspector";

    /// 社区插件异步 PID 兼容补丁的幂等标记。
    const ASYNC_PID_PATCH_MARKER: &str = "dsh-desktop: synchronize asynchronous node-pty pid";

    /// 插件中创建 spawn 串行队列的稳定锚点。
    const SPAWN_CHAIN_ANCHOR: &str = "  let chain = Promise.resolve();";

    /// 插件中 inspector 挂载的稳定锚点。
    const INSPECTOR_ATTACH_ANCHOR: &str = "        if (handle !== undefined && handle.terminal !== undefined) inspector.attach(handle.terminal);";

    /// 用户 preset 目录名（`$DSH_HOME/.agent-presets/<id>/`）。
    const WIN_PRESET_ID: &str = "minimal-win";

    /// 候选 Git Bash 安装位置（常见路径 + 环境变量覆盖）。
    const GIT_BASH_CANDIDATES: [&str; 4] = [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
        r"C:\Program Files (x86)\Git\usr\bin\bash.exe",
    ];

    /// 当前档案的 profile 目录：`<DSH_HOME>/profiles/<当前档案>`。
    fn profile_dir(app_handle: &tauri::AppHandle) -> PathBuf {
        crate::service::profile::profile_dir_of(
            app_handle,
            &crate::service::profile::active_profile(app_handle),
        )
    }

    /// dsh 用户数据目录（`$DSH_HOME`）。
    fn dsh_home(app_handle: &tauri::AppHandle) -> PathBuf {
        crate::config::get_dsh_data_path(app_handle)
    }

    /// 写入一个文件及其父目录，返回错误信息。
    fn write_file(path: &Path, content: &str) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("WIN_INSPECTOR_PARENT_DIR: create parent dir failed: {e}"))?;
        }
        fs::write(path, content)
            .map_err(|e| format!("WIN_INSPECTOR_WRITE: write {} failed: {e}", path.display()))
    }

    /// 插件是否已装入 profile：读取 profile 清单的 `dependencies` 键。
    fn is_plugin_installed(profile: &Path) -> bool {
        let Ok(content) = fs::read_to_string(profile.join("package.json")) else {
            return false;
        };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&content) else {
            return false;
        };
        manifest
            .get("dependencies")
            .and_then(serde_json::Value::as_object)
            .map(|deps| deps.contains_key(PLUGIN_DEP_NAME))
            .unwrap_or(false)
    }

    /// node-pty 1.2 的 ConPTY client pid 异步就绪时，同步插件包装器拿到的 handle 身份。
    ///
    /// `LocalTerminalHandle` 在构造时快照 `terminal.pid` 与 `rootIdentity`；Windows 下
    /// node-pty 1.2.0-beta.15 此刻固定返回 0，随后才在 `ready_datapipe` 更新真实 pid。
    /// 社区插件已持有 terminal、handle 与 inspector，故在挂载后短时轮询并回填是
    /// 不修改官方包源码的最小修复。返回值用于安全处理上游插件布局变化。
    #[derive(Debug, PartialEq, Eq)]
    enum AsyncPidPatchOutcome {
        AlreadyPatched,
        AnchorMissing,
        Patched(String),
    }

    fn patch_async_pid_source(source: &str) -> AsyncPidPatchOutcome {
        if source.contains(ASYNC_PID_PATCH_MARKER) {
            return AsyncPidPatchOutcome::AlreadyPatched;
        }
        if !source.contains(SPAWN_CHAIN_ANCHOR) || !source.contains(INSPECTOR_ATTACH_ANCHOR) {
            return AsyncPidPatchOutcome::AnchorMissing;
        }

        let helper = format!(
            r#"  // {ASYNC_PID_PATCH_MARKER}
  // node-pty >= 1.2 在 spawn 返回后才解析 ConPTY client pid，
  // LocalTerminalHandle 则已在构造函数中快照 pid/rootIdentity。
  const syncShellIdentity = (handle, inspector, terminal) => {{
    let tries = 0;
    const tick = () => {{
      if (handle.exited) return;
      const pid = typeof terminal?.pid === "number" ? terminal.pid : 0;
      if (pid > 0) {{
        handle.pid = pid;
        try {{
          const rootIdentity =
            inspector.processTree(pid).find((member) => member.pid === pid);
          if (rootIdentity !== undefined) {{
            handle.rootIdentity = rootIdentity;
            return;
          }}
        }} catch (_tableUnavailable) {{}}
      }}
      if (++tries < 60) setTimeout(tick, 100);
    }};
    tick();
  }};

"#
        );
        let patched = source.replacen(
            SPAWN_CHAIN_ANCHOR,
            &format!("{helper}{SPAWN_CHAIN_ANCHOR}"),
            1,
        );
        let attach = format!(
            "        if (handle !== undefined && handle.terminal !== undefined) {{\n          inspector.attach(handle.terminal);\n          syncShellIdentity(handle, inspector, handle.terminal);\n        }}"
        );
        AsyncPidPatchOutcome::Patched(patched.replacen(INSPECTOR_ATTACH_ANCHOR, &attach, 1))
    }

    /// 对 profile 中已安装的社区插件应用异步 PID 兼容补丁（幂等）。
    fn ensure_async_pid_patch(profile: &Path) -> Result<(), String> {
        let entry = profile.join("node_modules/dsh-win-terminal-inspector/index.js");
        if !entry.exists() {
            log::warn!(
                "win terminal inspector entry missing, skip async pid patch: {}",
                entry.display()
            );
            return Ok(());
        }
        let source = fs::read_to_string(&entry)
            .map_err(|e| format!("WIN_INSPECTOR_PATCH_READ: {} failed: {e}", entry.display()))?;
        match patch_async_pid_source(&source) {
            AsyncPidPatchOutcome::AlreadyPatched => {
                log::info!("win terminal inspector async pid patch already applied");
            }
            AsyncPidPatchOutcome::AnchorMissing => {
                log::warn!(
                    "win terminal inspector async pid patch anchors missing, skip: {}",
                    entry.display()
                );
            }
            AsyncPidPatchOutcome::Patched(patched) => {
                fs::write(&entry, patched).map_err(|e| {
                    format!("WIN_INSPECTOR_PATCH_WRITE: {} failed: {e}", entry.display())
                })?;
                log::info!(
                    "win terminal inspector async pid compatibility patched: {}",
                    entry.display()
                );
            }
        }
        Ok(())
    }

    /// 幂等地写入 web profile 的 `cordis.patch.yml` 挂载行。
    ///
    /// 用 YAML 库整体改写顶层数组，而非字符串拼接：新增的顶层 `- insert:`
    /// 元素由库序列化，避免手拼格式错乱。**代价**：库往返会丢弃文件中的用户
    /// 注释（评审已确认接受），但顶层数组语义保持不变（loader 只读数组结构）。
    fn ensure_patch(profile: &Path) -> Result<(), String> {
        let patch_path = profile.join("cordis.patch.yml");
        let existing = fs::read_to_string(&patch_path).unwrap_or_default();

        let mut doc = parse_patch_list(&existing)?;
        let seq = match &mut doc {
            serde_yaml::Value::Sequence(seq) => seq,
            _ => unreachable!("parse_patch_list only returns a sequence"),
        };
        // 迁移 + 幂等：已有本插件块时把旧的裸包名/目录写法改为显式入口文件；
        // 完全没有才追加新块。避免把旧写法当作「已挂载」直接跳过，导致修复对
        // 存量安装用户不生效（它们是注释-实现矛盾的历史受害者）。
        let mut has_ours = false;
        for el in seq.iter_mut() {
            if block_is_ours(el) {
                has_ours = true;
                if block_uses_legacy_name(el) {
                    // 整块替换为规范写法（仅 id + name，其余字段不涉及本插件）。
                    *el = plugin_insert_entry();
                }
            }
        }
        if !has_ours {
            seq.push(plugin_insert_entry());
        }

        let out = serde_yaml::to_string(&doc).map_err(|e| format!("PATCH_RENDER_FAILED: {e}"))?;
        write_file(&patch_path, &out).map_err(|e| format!("PATCH_WRITE_FAILED: {e}"))
    }

    /// 幂等地从 `cordis.patch.yml` 移除本插件对应的 `- insert:` 块。
    ///
    /// 场景：插件经 `dsh plugin remove` 卸载后，我们写入的挂载行不会随依赖被清掉，
    /// loader 会去挂载一个不存在的包（`Cannot find package`）导致 harness 启动/热加载
    /// 报错。因此在「插件未装入」时把顶层数组中属于本插件的条目整块删掉，其余条目
    /// 原样保留。无该块时无操作。
    ///
    /// 自愈保证：删除后若数组为空，序列化结果自然是 `[]`（而非纯注释/空——那是
    /// YAML `null`，`parsePatchList` 会抛「必须是顶层数组」直接崩掉启动）。
    fn prune_patch_if_uninstalled(profile: &Path) -> Result<(), String> {
        let patch_path = profile.join("cordis.patch.yml");
        let existing = match fs::read_to_string(&patch_path) {
            Ok(s) => s,
            Err(_) => return Ok(()), // 无 patch 文件则无需清理
        };

        let doc = match parse_patch_list(&existing) {
            Ok(d) => d,
            Err(_) => return Ok(()), // 无法解析为数组则不动原文件
        };
        let serde_yaml::Value::Sequence(seq) = doc else {
            return Ok(());
        };
        if !seq.iter().any(block_is_ours) {
            return Ok(());
        }

        let retained: Vec<serde_yaml::Value> =
            seq.into_iter().filter(|el| !block_is_ours(el)).collect();
        let out = serde_yaml::to_string(&serde_yaml::Value::Sequence(retained))
            .map_err(|e| format!("PATCH_RENDER_FAILED: {e}"))?;
        write_file(&patch_path, &out).map_err(|e| format!("PATCH_PRUNE_FAILED: {e}"))
    }

    /// 修复 dsh 可能留下的“仅注释”patch scaffold：YAML 解析为 `null` 而非
    /// 顶层数组，加载器（`parsePatchList`）会直接抛错导致 harness 启动失败。
    ///
    /// TODO(v1): 移除该自愈逻辑（旧版遗留的`仅注释/空` scaffold 修复），v1 起
    /// 直接按干净顶层数组处理。
    ///
    /// 幂等：文件不存在或已有实际内容（条目或 `[]`）时不动；仅注释/空则补 `[]`。
    fn ensure_patch_scaffold(profile: &Path) -> Result<(), String> {
        let patch_path = profile.join("cordis.patch.yml");
        let Ok(existing) = fs::read_to_string(&patch_path) else {
            return Ok(());
        };
        // 空串或纯注释解析为 `null` 才是需要修复的状态；其余内容（数组/映射）
        // 保持原样，不做无谓改写。
        let repair = if existing.trim().is_empty() {
            true
        } else {
            match serde_yaml::from_str::<serde_yaml::Value>(&existing) {
                Ok(v) => v.is_null(),
                Err(_) => false, // 非空但非法 YAML：当前行为保持原样
            }
        };
        if !repair {
            return Ok(());
        }

        // 用库生成合法的空顶层数组，保证 loader 可加载。
        let out = serde_yaml::to_string(&serde_yaml::Value::Sequence(Vec::new()))
            .map_err(|e| format!("PATCH_RENDER_FAILED: {e}"))?;
        write_file(&patch_path, &out).map_err(|e| format!("PATCH_WRITE_FAILED: {e}"))
    }

    /// 把 `cordis.patch.yml` 文本解析为顶层数组 `Value`；空/纯注释视为空数组。
    fn parse_patch_list(content: &str) -> Result<serde_yaml::Value, String> {
        if content.trim().is_empty() {
            return Ok(serde_yaml::Value::Sequence(Vec::new()));
        }
        let doc: serde_yaml::Value =
            serde_yaml::from_str(content).map_err(|e| format!("PATCH_PARSE_FAILED: {e}"))?;
        match &doc {
            serde_yaml::Value::Sequence(_) => Ok(doc),
            serde_yaml::Value::Null => Ok(serde_yaml::Value::Sequence(Vec::new())),
            _ => Err("PATCH_NOT_ARRAY: cordis.patch.yml must be a top-level array".to_string()),
        }
    }

    /// 顶层数组元素是否为本插件的 `- insert:` 挂载块（按注入标记字符串判定）。
    fn block_is_ours(el: &serde_yaml::Value) -> bool {
        serde_yaml::to_string(el)
            .map(|s| s.contains(PATCH_MARKER))
            .unwrap_or(false)
    }

    /// 挂载块是否仍使用无法被 Node ESM 稳定加载的裸包名或目录旧写法。
    fn block_uses_legacy_name(el: &serde_yaml::Value) -> bool {
        serde_yaml::to_string(el)
            .map(|s| !s.contains("name: ./node_modules/dsh-win-terminal-inspector/index.js"))
            .unwrap_or(false)
    }

    /// 生成本插件的顶层 `- insert:` 挂载元素（解析自 `PATCH_ENTRY` 模板）。
    fn plugin_insert_entry() -> serde_yaml::Value {
        let seq: serde_yaml::Value =
            serde_yaml::from_str(PATCH_ENTRY).expect("PATCH_ENTRY must remain valid YAML");
        match seq {
            serde_yaml::Value::Sequence(mut s) => s.remove(0),
            other => other,
        }
    }

    /// 在本机查找 Git Bash 可执行文件（环境变量优先，其次常见安装路径）。
    fn find_git_bash() -> Option<PathBuf> {
        if let Ok(p) = std::env::var("DSH_GIT_BASH_PATH") {
            let candidate = PathBuf::from(p);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        GIT_BASH_CANDIDATES
            .iter()
            .map(PathBuf::from)
            .find(|p| p.is_file())
    }

    /// 本机 Git Bash 的 bin 目录：bash.exe 所在目录（`<git>\bin`）与
    /// `<git>\usr\bin`（coreutils 所在，`ls`/`sed`/`find` 等）。两者都存在才会
    /// 加入结果；未找到 Git Bash 时返回空。
    pub fn git_bash_bin_dirs() -> Vec<PathBuf> {
        let Some(bash) = find_git_bash() else {
            return Vec::new();
        };
        let mut dirs = Vec::new();
        if let Some(bin_dir) = bash.parent() {
            dirs.push(bin_dir.to_path_buf());
        }
        // `<git>\usr\bin`：bash 在 `<git>\bin` 下，其父级即 Git 根目录
        if let Some(usr_bin) = bash
            .parent()
            .and_then(Path::parent)
            .map(|git_root| git_root.join("usr").join("bin"))
            .filter(|p| p.is_dir())
        {
            dirs.push(usr_bin);
        }
        dirs
    }

    /// 渲染 Windows 版极简 preset 的元数据（preset.yml）。
    fn render_preset_meta() -> String {
        concat!(
            "name: 极简模式 (Windows)\n",
            "description: 仅提供持久 bash（Git Bash）与 str_replace_editor 的双工具编码 Agent；Windows 专用（含 win32 终端检查与非受限令牌）。\n",
            "order: 3\n",
        )
        .to_string()
    }

    /// 渲染 Windows 版极简 preset 的组成（agent.cordis.yml）。
    ///
    /// 基于 shipped `minimal` preset 复制，做两处 Windows 修正：
    /// 1. `persistent-shell` 组内加 `sandbox-policy`（danger-full-access）：
    ///    Git Bash 在 workspace-write 受限令牌下无法初始化（MSYS 信号管道 ACL），
    ///    必须以非受限令牌运行；
    /// 2. `terminal-bash` 的 `shellPath` 指向本机 Git Bash，并固定
    ///    `--noprofile --norc -i`（登录 shell 会覆写 PS1，破坏受控提示符契约）。
    fn render_composition(shell_path: &str) -> String {
        let shell_path = shell_path.replace('\'', "''"); // YAML 单引号标量：单引号双写
        format!(
            r#"# Windows 版极简模式：基于 shipped `minimal` preset 复制并修正。
# 1) terminal-bash 的 shellPath 指向本机 Git Bash（默认 /bin/bash 在
#    Windows 上不是有效路径）；
# 2) persistent-shell 组内沙箱策略固定为 danger-full-access：Git Bash
#    （MSYS）在 workspace-write 的受限令牌下无法初始化信号管道
#    （cygheap/ACL），shell 必须运行在非受限令牌下。

- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: You are a helpful software engineer assistant.
    complete: true
    includeRuntimeContext: false

- id: persistent-shell
  name: cordis:group
  group: true
  isolate:
    terminals: true
    sandboxPolicy: true
  config:
    - id: pty
      name: '@deepseek-ai/dsh-terminal'

    - id: sandbox-policy
      name: '@deepseek-ai/dsh-sandbox-policy'
      config:
        mode: danger-full-access
        workspaceRoot: !!js process.env.DSH_CWD ?? process.cwd()

    - id: terminal-bash
      name: '@deepseek-ai/dsh-terminal-bash'
      config:
        timeoutMs: 300000
        shellPath: '{}'
        shellArgs: ['--noprofile', '--norc', '-i']

    - id: persistent-bash
      name: '@deepseek-ai/dsh-tool-bash-persistent'
      config:
        timeoutMs: 300000
        description: |-
          Run commands in a bash shell (Git Bash on Windows)
          * This shell runs unconfined (danger-full-access): no file sandbox on shell commands.
          * State is persistent across command calls and discussions with the user.

- id: filesystem
  name: cordis:group
  group: true
  isolate:
    fs: true
  config:
    - id: fs-local
      name: '@deepseek-ai/dsh-fs-local'
      config:
        cwd: !!js process.env.DSH_CWD ?? process.cwd()

    - id: str-replace-editor
      name: '@deepseek-ai/dsh-tool-str-replace-editor'
      config:
        maxOutputChars: 16000
"#,
            shell_path
        )
    }

    /// 在用户根创作 Windows 版极简 preset（`$DSH_HOME/.agent-presets/minimal-win/`）。
    ///
    /// 幂等：目录已存在则视为用户已拥有该 preset，跳过（shipped preset 之外的
    /// 用户根由用户自己管理，升级不覆盖）。Git Bash 未安装时跳过并告警，
    /// 不阻断主流程。
    fn ensure_win_minimal_preset(app_handle: &tauri::AppHandle) -> Result<(), String> {
        let Some(git_bash) = find_git_bash() else {
            log::warn!(
                "Git Bash not found; skipping minimal-win preset authoring (DSH_GIT_BASH_PATH to override)"
            );
            return Ok(());
        };

        let dir = dsh_home(app_handle)
            .join(".agent-presets")
            .join(WIN_PRESET_ID);
        let composition = dir.join("agent.cordis.yml");
        if composition.exists() {
            log::info!("minimal-win preset already exists, leaving as-is");
            return Ok(());
        }

        let shell = git_bash.to_string_lossy().into_owned();
        write_file(&composition, &render_composition(&shell))?;
        write_file(&dir.join("preset.yml"), &render_preset_meta())?;
        log::info!(
            "minimal-win preset authored at {} (shell: {})",
            dir.display(),
            git_bash.display()
        );
        Ok(())
    }

    /// 应用 Windows 极简模式修复的落盘部分：挂载 patch 行 + 创作用户 preset。
    ///
    /// 仅在插件已装入 profile 时写 patch（避免挂载不存在的包）；插件未装入时
    /// 清理可能残留的挂载行（`dsh plugin remove` 后避免 loader 报错）；preset
    /// 仅在 Git Bash 存在时创作。均为幂等，失败只返回错误、由调用方决定是否告警。
    pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
        let profile = profile_dir(app_handle);
        // 无论插件是否装入，先确保 patch 文件是 dsh 可加载的顶层数组：
        // dsh 初始化留下的“仅注释”scaffold 会让加载器启动崩溃。
        ensure_patch_scaffold(&profile)?;
        if !is_plugin_installed(&profile) {
            // 插件已卸载（如 `dsh plugin remove`）：清掉之前写入的挂载行，
            // 避免 loader 去挂载一个不存在的包导致 harness 启动/热加载报错。
            // 其余用户条目与注释原样保留；无该行时无操作。
            prune_patch_if_uninstalled(&profile)?;
            log::debug!("win terminal inspector not installed in profile, patch pruned if present");
            return Ok(());
        }

        ensure_patch(&profile)?;
        ensure_async_pid_patch(&profile)?;
        ensure_win_minimal_preset(app_handle)?;
        log::info!("win32 terminal support applied to {:?}", profile.display());
        Ok(())
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn temp_dir(tag: &str) -> PathBuf {
            std::env::temp_dir().join(format!("win-inspector-test-{}-{tag}", std::process::id()))
        }

        fn plugin_source_fixture() -> String {
            format!(
                r#"export function apply(ctx) {{
  let chain = Promise.resolve();
  const wrapped = (spec) => {{
    const run = chain.then(async () => {{
      const inspector = new WindowsProcessInspector();
      try {{
        const handle = await original.call(runtime, spec);
        if (handle !== undefined && handle.terminal !== undefined) inspector.attach(handle.terminal);
        return handle;
      }} finally {{}}
    }});
    return run;
  }};
}}
"#
            )
        }

        #[test]
        fn async_pid_patch_syncs_handle_after_terminal_pid_is_ready() {
            let AsyncPidPatchOutcome::Patched(patched) =
                patch_async_pid_source(&plugin_source_fixture())
            else {
                panic!("expected patched plugin source");
            };
            assert!(patched.contains(ASYNC_PID_PATCH_MARKER));
            assert!(patched.contains("if (++tries < 60) setTimeout(tick, 100);"));
            assert!(patched.contains("handle.pid = pid;"));
            assert!(patched.contains("handle.rootIdentity ="));
            assert!(patched.contains("syncShellIdentity(handle, inspector, handle.terminal);"));
            assert!(patched.contains("inspector.attach(handle.terminal);"));
        }

        #[test]
        fn async_pid_patch_is_idempotent() {
            let AsyncPidPatchOutcome::Patched(patched) =
                patch_async_pid_source(&plugin_source_fixture())
            else {
                panic!("expected patched plugin source");
            };
            assert_eq!(
                patch_async_pid_source(&patched),
                AsyncPidPatchOutcome::AlreadyPatched
            );
        }

        #[test]
        fn async_pid_patch_skips_changed_upstream_layout() {
            assert_eq!(
                patch_async_pid_source("export function apply() {}"),
                AsyncPidPatchOutcome::AnchorMissing
            );
        }

        #[test]
        fn async_pid_patch_updates_installed_plugin_file() {
            let dir = temp_dir("async-pid");
            let plugin_dir = dir.join("node_modules/dsh-win-terminal-inspector");
            std::fs::create_dir_all(&plugin_dir).unwrap();
            let entry = plugin_dir.join("index.js");
            std::fs::write(&entry, plugin_source_fixture()).unwrap();

            ensure_async_pid_patch(&dir).unwrap();
            let once = std::fs::read_to_string(&entry).unwrap();
            assert!(once.contains(ASYNC_PID_PATCH_MARKER));

            ensure_async_pid_patch(&dir).unwrap();
            let twice = std::fs::read_to_string(&entry).unwrap();
            assert_eq!(once, twice);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_append_strips_flow_empty_list() {
            // dsh 可能把 patch 文件初始化为“注释头 + []”
            let dir = temp_dir("a");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            std::fs::write(&patch, "# header comment\n[]\n").unwrap();

            ensure_patch(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            // `[]` 行被移除、挂载行存在、且没有残留 `[]`
            assert!(!out.contains("[]"));
            assert!(out.contains("- insert:"));
            assert!(out.contains("win-terminal-inspector"));

            // 幂等：再次调用不重复追加
            ensure_patch(&dir).unwrap();
            let again = std::fs::read_to_string(&patch).unwrap();
            assert_eq!(out, again);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_append_preserves_existing_block_entries() {
            let dir = temp_dir("b");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            std::fs::write(&patch, "- id: some-row\n  config:\n    a: 1\n").unwrap();

            ensure_patch(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            assert!(out.contains("some-row"));
            assert!(out.contains("win-terminal-inspector"));

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_prune_removes_only_our_insert_block() {
            let dir = temp_dir("i");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            // 我们的 insert 块与其他用户条目、注释共存
            std::fs::write(
                &patch,
                "# user comments\n- insert:\n    - id: win-terminal-inspector\n      name: dsh-win-terminal-inspector\n- id: some-row\n  config:\n    a: 1\n",
            )
            .unwrap();

            prune_patch_if_uninstalled(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            // 只删我们的块：其余条目原样保留（库往返会丢弃注释）
            assert!(!out.contains("win-terminal-inspector"));
            assert!(!out.contains("insert:"));
            assert!(out.contains("some-row"));

            // 幂等：再次调用内容不变
            prune_patch_if_uninstalled(&dir).unwrap();
            let again = std::fs::read_to_string(&patch).unwrap();
            assert_eq!(out, again);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_prune_self_repairs_comment_only_remainder() {
            let dir = temp_dir("j");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            // 我们的块是唯一的实际内容：删掉后只剩注释，必须补 `[]`，
            // 否则纯注释 YAML 解析为 null，下一次启动会崩溃（顶层数组错误）
            std::fs::write(
                &patch,
                "# Your patch layer for this dsh profile\n- insert:\n    - id: win-terminal-inspector\n      name: dsh-win-terminal-inspector\n",
            )
            .unwrap();

            prune_patch_if_uninstalled(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            // 标记块被删，剩余为空数组 → 序列化为 `[]`（loader 可加载的顶层数组；
            // 库往返丢弃注释，但数组语义自愈成立）
            assert!(!out.contains("win-terminal-inspector"));
            assert!(out.contains("[]\n"));

            // 幂等：再次调用内容不变
            prune_patch_if_uninstalled(&dir).unwrap();
            let again = std::fs::read_to_string(&patch).unwrap();
            assert_eq!(out, again);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_scaffold_repairs_comment_only_file() {
            let dir = temp_dir("f");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            // dsh 可能留下“仅注释”的 scaffold：YAML 解析为 null，加载器会崩溃
            std::fs::write(
                &patch,
                "# Your patch layer for this dsh profile\n# comments only, no entries\n",
            )
            .unwrap();

            ensure_patch_scaffold(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            assert!(out.contains("[]"));
            assert!(!out.contains("win-terminal-inspector"));

            // 幂等：再次调用内容不变
            ensure_patch_scaffold(&dir).unwrap();
            let again = std::fs::read_to_string(&patch).unwrap();
            assert_eq!(out, again);

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_scaffold_leaves_valid_arrays_untouched() {
            let dir = temp_dir("g");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            // 已有条目或 `[]` 都是合法数组，不应被改动
            for content in ["- id: some-row\n  config:\n    a: 1\n", "# header\n[]\n"] {
                std::fs::write(&patch, content).unwrap();
                ensure_patch_scaffold(&dir).unwrap();
                assert_eq!(std::fs::read_to_string(&patch).unwrap(), content);
            }

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn patch_uses_explicit_profile_relative_entry_file() {
            let dir = temp_dir("c");
            std::fs::create_dir_all(&dir).unwrap();
            ensure_patch(&dir).unwrap();
            let out = std::fs::read_to_string(dir.join("cordis.patch.yml")).unwrap();
            // Node ESM 不支持目录导入；必须显式指向插件导出的 index.js。
            assert!(
                out.contains("name: ./node_modules/dsh-win-terminal-inspector/index.js"),
                "patch must mount the explicit profile-relative entry file, got:\n{out}"
            );
            // 单独断言不含裸包名写法（`name: dsh-win-terminal-inspector` 后直接换行）
            assert!(
                !out.contains("name: dsh-win-terminal-inspector\n"),
                "patch must not use bare package name, got:\n{out}"
            );
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn ensure_patch_upgrades_existing_bare_name_entry() {
            let dir = temp_dir("m");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            // 旧写法（历史注释-实现矛盾处）：裸包名无法被 loader 按 baseUrl 解析
            std::fs::write(
                &patch,
                "- insert:\n    - id: win-terminal-inspector\n      name: dsh-win-terminal-inspector\n",
            )
            .unwrap();
            ensure_patch(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            // 存量旧条目必须被改写为显式入口文件，而不是当作「已挂载」跳过
            assert!(
                out.contains("name: ./node_modules/dsh-win-terminal-inspector/index.js"),
                "bare-name entry must be migrated to the explicit entry file, got:\n{out}"
            );
            assert!(
                !out.contains("name: dsh-win-terminal-inspector\n"),
                "bare-name form must be gone after migration, got:\n{out}"
            );
            // 幂等：再次运行不改写、不产生重复块
            ensure_patch(&dir).unwrap();
            let out2 = std::fs::read_to_string(&patch).unwrap();
            assert_eq!(out, out2);
            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn ensure_patch_upgrades_existing_directory_entry() {
            let dir = temp_dir("n");
            std::fs::create_dir_all(&dir).unwrap();
            let patch = dir.join("cordis.patch.yml");
            // Node 24 ESM 不支持相对目录导入，旧桌面端生成的写法会阻断启动。
            std::fs::write(
                &patch,
                "- insert:\n    - id: win-terminal-inspector\n      name: ./node_modules/dsh-win-terminal-inspector\n",
            )
            .unwrap();

            ensure_patch(&dir).unwrap();
            let out = std::fs::read_to_string(&patch).unwrap();
            assert!(
                out.contains("name: ./node_modules/dsh-win-terminal-inspector/index.js"),
                "directory entry must be migrated to the explicit entry file, got:\n{out}"
            );

            std::fs::remove_dir_all(&dir).ok();
        }

        #[test]
        fn composition_renders_windows_fixes() {
            let yaml = render_composition(r"C:\Program Files\Git\bin\bash.exe");
            assert!(yaml.contains("shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe'"));
            assert!(yaml.contains("mode: danger-full-access"));
            assert!(yaml.contains("sandboxPolicy: true"));
            assert!(yaml.contains("--noprofile"));
            assert!(yaml.contains("dsh-tool-bash-persistent"));
            assert!(yaml.contains("dsh-terminal-bash"));
        }

        #[test]
        fn git_bash_dirs_follow_finder() {
            // 不变量：找到 Git Bash 则 bin 目录必含其父目录；未找到则返回空
            match find_git_bash() {
                Some(bash) => {
                    let dirs = git_bash_bin_dirs();
                    assert!(dirs.contains(&bash.parent().unwrap().to_path_buf()));
                }
                None => assert!(git_bash_bin_dirs().is_empty()),
            }
        }

        #[test]
        fn plugin_installed_reads_manifest_deps() {
            let dir = temp_dir("d");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("package.json"),
                r#"{"name":"dsh-profile-web","dependencies":{"dsh-win-terminal-inspector":"github:clearkurt/dsh-win-terminal-inspector"}}"#,
            )
            .unwrap();
            assert!(is_plugin_installed(&dir));

            let empty = temp_dir("e");
            std::fs::create_dir_all(&empty).unwrap();
            std::fs::write(empty.join("package.json"), r#"{"name":"dsh-profile-web"}"#).unwrap();
            assert!(!is_plugin_installed(&empty));

            std::fs::remove_dir_all(&dir).ok();
            std::fs::remove_dir_all(&empty).ok();
        }
    }
}

#[cfg(not(windows))]
mod imp {
    /// 非 Windows 平台无操作：插件在运行时自身也会按 platform 判空。
    pub fn apply(_app_handle: &tauri::AppHandle) -> Result<(), String> {
        Ok(())
    }

    /// 非 Windows 无 Git Bash bin 目录。
    pub fn git_bash_bin_dirs() -> Vec<std::path::PathBuf> {
        Vec::new()
    }
}

/// 应用 Windows 极简模式修复的落盘部分（仅 Windows 生效，幂等）。
///
/// 由预装插件安装流程在安装成功、以及服务启动自愈时调用；插件未装入 profile
/// 时无操作。
pub fn apply(app_handle: &tauri::AppHandle) -> Result<(), String> {
    imp::apply(app_handle)
}

/// 本机 Git Bash 的 bin 目录（供服务 PATH 注入）。
///
/// 返回 bash.exe 所在目录（`<git>\bin`）与 `<git>\usr\bin`（`ls`/`sed`/`find` 等
/// coreutils 所在）。原因：persistent bash 跑在 `--noprofile --norc` 下不执行
/// profile 脚本，PATH 完全继承服务进程；若服务 PATH 不含 Git 目录，会话内只有
/// 内建命令、外部命令全部 `command not found`（MSYS 运行时在部分环境下不会自动
/// 补 `/usr/bin`）。仅 Windows 且找到 Git Bash 时返回非空；非 Windows 返回空。
pub fn git_bash_bin_dirs() -> Vec<std::path::PathBuf> {
    imp::git_bash_bin_dirs()
}
