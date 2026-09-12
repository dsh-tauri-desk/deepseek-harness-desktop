<p align="center">
  <a href="https://github.com/dsh-tauri-desk/deepseek-harness-desktop">
    <img src="public/favicon.svg" width="96" alt="DeepSeek Harness Desktop" />
  </a>
</p>

<h1 align="center">DeepSeek Harness Desktop</h1>

<p align="center">
  Ejecuta <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> en tu escritorio, al instante —<br />
  sin Node.js, sin pnpm, sin Docker. Descarga, instala y listo.
</p>

<p align="center">
  <a href="https://github.com/dsh-tauri-desk/deepseek-harness-desktop/releases">
    <img src="https://img.shields.io/github/v/release/dsh-tauri-desk/deepseek-harness-desktop?style=flat-square&label=release&color=4D6BFE" alt="Release" />
  </a>
  <img src="https://img.shields.io/github/downloads/dsh-tauri-desk/deepseek-harness-desktop/total?style=flat-square&label=downloads&color=4D6BFE" alt="Downloads" />
  <img src="https://img.shields.io/github/stars/dsh-tauri-desk/deepseek-harness-desktop?style=flat-square&label=stars&color=4D6BFE" alt="Stars" />
  <img src="https://img.shields.io/github/license/dsh-tauri-desk/deepseek-harness-desktop?style=flat-square&label=license&color=4D6BFE" alt="MIT License" />
  <img src="https://img.shields.io/badge/Windows%20%7C%20macOS%20%7C%20Linux-black?style=flat-square" alt="Windows | macOS | Linux" />
  <img src="https://img.shields.io/badge/dsh-0.1.5--rc.2-4D6BFE?style=flat-square" alt="dsh 0.1.5-rc.2" />
</p>

<p align="center">
  <samp><a href="./README.en.md">English</a> · <strong>Español</strong> · <a href="https://dshtauri.mintlifysite.com">Documentación</a> · <a href="./README.md">中文</a></samp>
</p>

<p align="center">
 <a href="https://trendshift.io/repositories/151676?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-151676" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/151676/daily?language=Rust" alt="dsh-tauri-desk%2Fdeepseek-harness-desktop | Trendshift" width="250" height="55"/></a>
</p>

<p align="center">
  <img src="./docs/images/hero-en.png" width="100%" alt="Banner promocional de DSH Desktop" />
</p>

<table>
  <tr>
    <td><a href="docs/PREVIEW.md"><img src="./docs/images/previews/preview-1.png" alt="preview 1" /></a></td>
    <td><a href="docs/PREVIEW.md"><img src="/docs/images/previews/preview-2.png" alt="preview 2" /></a></td>
    <td><a href="docs/PREVIEW.md"><img src="/docs/images/previews/preview-4.png" alt="preview 4" /></a></td>
    <td><a href="docs/PREVIEW.md"><img src="/docs/images/previews/preview-5.png" alt="preview 5" /></a></td>
  </tr>
</table>

## Características

- ⚡️ **Cero configuración** — No tenés que instalar Node ni el núcleo Harness manualmente: el primer arranque descarga solo lo que falte (necesita conexión en ese momento) y reutiliza tu entorno local sin modificarlo.
- 🔄 **Actualización del núcleo** — Sincroniza la última versión del Harness oficial dentro de la app, los cambios surten efecto sin reinstalar; permite gestionar múltiples versiones del núcleo.
- 🖥️ **Configuración** — Un solo diálogo para Debug / Perfiles / Plugins / Núcleo, con etiquetas bilingües (zh/en) y soporte de modo oscuro.
- 🗂️ **Aislamiento por perfiles** — Los perfiles están aislados entre sí en la configuración; plugins, parches y ajustes se mantienen independientes sin interferirse.
- 🧩 **Gestión de plugins** — El panel de plugins administra los instalados; ante un problema ofrece entradas de actualización / desinstalación más detalles del error.
- 🎁 **Plugins integrados** — Incluye plugins empaquetados; más plugins integrados de calidad en camino.
- 🪶 **Nativo y liviano** — Un shell Tauri 2 (no Electron): instaladores más chicos, menos memoria, ventanas nativas.
- ⌨️ **Integración con la terminal** — La instalación registra automáticamente el comando `dsh`, listo en una terminal nueva; no sobrescribe tu configuración actual del shell.
- 🧭 **Asistente inicial** — En el primer arranque elegí los plugins recomendados, o volvé a elegirlos más tarde en la configuración.
- 🚀 **Auto-actualización** — Actualizaciones dentro de la app; sin volver a descargar.
- 🐾 **Mascotas de escritorio** — Administrá fuentes Pets y Codex con presets listos para usar (transmitidos desde sus hosts de assets, sin descarga), importá paquetes Codex `.zip` y mostrá estados de actividad de las conversaciones.

## Preinstalados

Plugins ofrecidos en el asistente del primer arranque; marcá los que necesites e instalalos a demanda:

- [DSH Win Terminal Inspector](https://github.com/clearkurt/dsh-win-terminal-inspector) — Corrección solo-Windows para el modo Minimal
- [DSH Market](https://github.com/dsh-market/dsh-market) — explorá, buscá e instalá plugins de la comunidad con un clic (Recomendado)
- [DSH Better Sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) — barra lateral derecha estilo VSCode, aislada por sesión (Recomendado)
- [DSH Notification](https://github.com/omdsh-dev/dsh-notification) — notificaciones de escritorio al completar un turno

> La lista de preinstalados la mantiene el proyecto desktop. Para pedir un preset nuevo o actualizado, abrí un issue en [deepseek-harness-desktop](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/issues).
>
> La lista actual también incluye [DSH Session Context Menu](https://github.com/baihejiangnan/dsh-session-context-menu) para acciones contextuales en conversaciones, workspaces, entradas y enlaces.

## Plugins integrados

Plugins propios incluidos con el instalador:

- [DSH Tauri](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri) — provee el canal de comunicación con el shell Tauri 2
- [DSH Tauri UI](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-ui) — provee una barra lateral de ajustes personalizada para el shell Tauri 2
- [DSH Tauri Worktree](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-worktree) — crea un Git worktree aislado por sesión, con checkout a rama local o flujos de archivar-y-abandonar
- [DSH Tauri Panel](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-panel) — shell de barra lateral: fila de logo compacta, área de paneles (New Session + ítems de terceros vía `sidebar.panel.action`) y el servicio `panel.protocol`
- [DSH Tauri Panel Extension](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-panel-extension) — gestión de Skills y MCP con importación de repositorios de skills
- [DSH Tauri Panel Scheduler](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/tree/main/packages/dsh-tauri-panel-scheduler) — crea tareas programadas diarias, por intervalo, días hábiles y semanales; las ejecuta en sesiones Agent independientes y conserva el historial
- [DSH Tauri Turn Rewind](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/tree/main/packages/dsh-tauri-turnrewind) — registra snapshots Git privados por turno del Agent, muestra tarjetas de cambios y revierte un turno de forma segura con protección de conflictos
- [DSH Tauri Session](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-session) — reemplaza el borrado de workspaces por archivado y agrega una página de chats archivados con búsqueda, orden, agrupado, filtro por proyecto y restauración
- [DSH Tauri Pet](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/tree/main/packages/dsh-tauri-pet) — administra mascotas Chat / Codex, descargas de presets, importación de paquetes y estados de actividad
- [DSH Tauri Rightclick](https://github.com/dsh-tauri-desk/dsh-tauri-plugins/tree/main/packages/dsh-tauri-rightclick) — menús contextuales estilo nativo para sesiones, workspaces, texto, enlaces y entradas
- Más plugins en camino...

## Inicio rápido

Descargá el instalador de tu plataforma desde [Releases](https://github.com/dsh-tauri-desk/deepseek-harness-desktop/releases), instalá y abrí.

**macOS (Homebrew):** también podés instalarlo con un comando vía Homebrew:

```bash
brew install dsh-tauri-desk/desktop/deepseek-harness
```

El primer arranque descarga el runtime de Node y el núcleo Harness (si `dsh` ya está instalado, se usa la versión instalada), y te lleva directo al harness en `http://127.0.0.1:3080`; después todo corre local, sin red.

**Requisitos:** Windows 10+ · macOS 10.15+ · Linux (AppImage / .deb) · red en el primer arranque

> **Nota Wayland en Linux (PikaOS / GNOME Wayland / Ubuntu 22.04+):** el AppImage puede crashear o verse negro en Wayland por WebKitGTK; la app corrige sola el caso común. <details><summary>Si igual crashea / se ve negro:</summary><br>**Preferí el `.deb`** (verificado en PikaOS 4 Wayland), o ejecutá a mano `WEBKIT_DISABLE_COMPOSITING_MODE=1 WEBKIT_DISABLE_DMABUF_RENDERER=1 GDK_BACKEND=x11 ./AppImage`. Si no aparecen los iconos, copiá los iconos `hicolor` de la app a `~/.local/share/icons` y ejecutá `update-desktop-database`.<br></details>

## Comunidad

- [Unite a la comunidad de Discord](https://discord.gg/RT9As6Cj8B)

<table>
  <tr>
    <td align="center"><strong>Grupo QQ</strong><br /><img src="./docs/images/community/qq-qrcode.jpg" width="360" alt="QR del grupo QQ" /></td>
    <td align="center"><strong>Grupo WeChat</strong><br /><img src="./docs/images/community/wx-qrcode.png" width="360" alt="QR del grupo WeChat" /></td>
  </tr>
</table>

## Desarrollo

¿Querés participar del desarrollo? Mirá [docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md).

## Cómo funciona

```text
┌──────────────────────────────────────────────┐
│ Tauri WebView (React)                        │
│   máquina de estados → progreso → iframe     │
│   carga la UI web de dsh + controles         │
└──────────────────────┬───────────────────────┘
                       │ comandos invoke + eventos
┌──────────────────────┴───────────────────────┐
│ Backend Rust (Tauri)                         │
│   service/download  instalador + extracción  │
│   service/core      versiones del núcleo     │
│   service/profile   gestión de perfiles dsh  │
│   service/plugin    quitar / actualizar      │
│   service/cli       shim del comando + PATH  │
│   service/update    auto-actualización       │
│   service/workflow  ciclo de vida de dsh     │
│   task              health checks            │
└──────┬───────────────────────────┬───────────┘
       │                           │
  runtime/ (Node.js v22.22.0)   dependencies/dsh/ (paquete prearmado)
       └─────────────┬─────────────┘
                     ▼
   dsh --profile <perfil> --host 127.0.0.1 --port 3080
                     │  DSH_HOME=~/.dsh
                     ▼
        http://127.0.0.1:3080/  ← UI integrada
```

El paquete Harness prearmado lo publica [deepseek-harness-pkg](https://github.com/dsh-tauri-desk/deepseek-harness-pkg). Cada arranque compara contra el último release y te propone descargar si el local quedó viejo — conservando lo local si GitHub es inalcanzable. Un núcleo local instalado vía CLI tiene preferencia si existe.

## Notas

> [!WARNING]
> **Vista previa** — el `dsh` oficial evoluciona rápido con cambios incompatibles; este proyecto lo sigue de cerca.
>
> [!NOTE]
> **Seguridad** — `dsh` puede ejecutar código en tu máquina. Solo para aprender / investigar / probar; usalo en un entorno confiable y aislado.

## Relacionados

- [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) — la plataforma agent `dsh` oficial
- [deepseek-harness-pkg](https://github.com/dsh-tauri-desk/deepseek-harness-pkg) — paquetes Harness prearmados que consume esta app
- [n8n-desktop](https://github.com/tangtao646/n8n-desktop) — implementación de referencia

## Licencia

[MIT](./LICENSE) con [condición no comercial](./LICENSE.details) © deepseek-harness-desktop contributors
