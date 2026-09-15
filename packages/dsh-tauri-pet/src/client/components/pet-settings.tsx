import type { ChangeEvent, ReactElement } from 'react'
import type { PetSettingsProps } from './pet-settings.types'
import { ArrowDownToLine, Icon, Plus, useMountStyle } from 'dsh-tauri-ui/client'
import { useStore, useWatchImmediate } from 'dsh-tauri/client'
import { useEffect, useRef, useState } from 'react'
import { PET_DEFAULT_SIZE, PET_SETTINGS_STYLES_ID, PET_SIZE_MAX, PET_SIZE_MIN, PET_SIZE_STEP } from '../constants'
import { locale } from '../locales'
import {
  choosePet,
  clearPetSelection,
  enablePet,
  importPetArchive,
  loadPetCatalog,
  resizePet,
  togglePet,
} from '../service/pet'
import { store } from '../store'
import { PetCard } from './pet-card'
import petSettingsStyle from './pet-settings.cssr'

/** 读取 .zip 归档为 base64（桌面端命令按字符串收包）。 */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const value = String(reader.result ?? '')
      const comma = value.indexOf(',')
      resolve(comma >= 0 ? value.slice(comma + 1) : value)
    }
    reader.onerror = () => reject(new Error('PET_FILE_READ_FAILED: failed to read pet archive'))
    reader.readAsDataURL(file)
  })
}

/** 桌宠设置页：预设 / Chat / Codex 三类宠物卡片（选择、启用、取消选择）、开关、大小滑条与导入。 */
export function PetSettings(props: PetSettingsProps): ReactElement {
  useMountStyle(petSettingsStyle, PET_SETTINGS_STYLES_ID)
  locale.useLocale()
  const { status, presetPets, chatPets, codexPets, catalogLoaded } = useStore(store.pet)
  const [tab, setTab] = useState<'pets' | 'codex'>('pets')
  // 无缓存（首次挂载）时进入加载态，避免空列表闪烁；有缓存直接渲染、后台静默刷新。
  const [busy, setBusy] = useState(() => !catalogLoaded)
  const [error, setError] = useState<string | null>(null)
  const [size, setSize] = useState(status?.pet_size ?? PET_DEFAULT_SIZE)
  const committedSizeRef = useRef<number | null>(null)
  const enabled = Boolean(status?.enabled)
  const active = status?.active_pet ?? ''
  const statusSize = status?.pet_size ?? PET_DEFAULT_SIZE

  // 宿主状态里的尺寸变化（别的入口改过）同步到本地滑条；本地正在拖动的值不被覆盖。
  useWatchImmediate(statusSize, () => {
    if (statusSize !== committedSizeRef.current)
      setSize(statusSize)
  })

  useEffect(() => {
    let cancelled = false
    void loadPetCatalog().then((result) => {
      if (cancelled)
        return
      setBusy(false)
      if (!result.ok)
        setError(locale.text('listFailed'))
    })
    return () => {
      cancelled = true
    }
  }, [])

  /** 启用预设宠物：选择它，并确保桌宠被唤醒。 */
  async function enablePreset(id: string): Promise<void> {
    if (busy || active === id)
      return
    setBusy(true)
    setError(null)
    const result = await enablePet({ id })
    if (!result.ok)
      setError(locale.text('setPetFailed'))
    setBusy(false)
  }

  async function choose(id: string): Promise<void> {
    if (busy || active === id)
      return
    setBusy(true)
    setError(null)
    const result = await choosePet({ id })
    if (!result.ok)
      setError(locale.text('setPetFailed'))
    setBusy(false)
  }

  /** 取消选择：清空已选宠物；仍在启用时一并关闭桌宠（无内容可渲染，不留空窗口）。 */
  async function clearSelection(): Promise<void> {
    if (busy || active === '')
      return
    setBusy(true)
    setError(null)
    const result = await clearPetSelection()
    if (!result.ok)
      setError(locale.text('clearFailed'))
    setBusy(false)
  }

  /** 启用/关闭桌宠：纯持久开关，关闭后重启不再自动拉起。 */
  async function toggleEnabled(): Promise<void> {
    if (busy)
      return
    setBusy(true)
    setError(null)
    const result = await togglePet({ enabled: !enabled })
    if (!result.ok)
      setError(locale.text('toggleFailed'))
    setBusy(false)
  }

  async function commitSize(value: number): Promise<void> {
    setError(null)
    const result = await resizePet({ size: value })
    if (result.ok)
      committedSizeRef.current = value
    else
      setError(locale.text('setSizeFailed'))
  }

  async function createPet(): Promise<void> {
    if (busy)
      return
    setBusy(true)
    setError(null)
    const result = await props.onCreate(props.close)
    if (!result.ok) {
      setError(locale.text('createFailed'))
      setBusy(false)
    }
  }

  async function onImport(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || busy)
      return
    setBusy(true)
    setError(null)
    try {
      const result = await importPetArchive({ name: file.name, data: await readAsBase64(file) })
      if (!result.ok)
        setError(locale.text('importFailed'))
    }
    catch (importError) {
      console.error('[dsh-tauri-pet] import failed:', importError)
      setError(locale.text('importFailed'))
    }
    finally {
      setBusy(false)
    }
  }

  const petsPanel = (
    <>
      {busy && presetPets.length === 0 && chatPets.length === 0
        ? <div className="dshp-pet__loading">{locale.text('loading')}</div>
        : (
            <div className="dshp-pet__cards">
              {/* 预设宠物直连远端素材：没有下载/更新步骤，卡片动作只有「启用 / 已选」。 */}
              {presetPets.map(item => (
                <PetCard
                  key={item.id}
                  thumbnail={item.image ?? undefined}
                  name={item.name}
                  desc={item.desc ?? ''}
                  active={active === item.id}
                  disabled={busy}
                  actionLabel={locale.text(active === item.id ? 'clear' : 'enable')}
                  onAction={() => { void (active === item.id ? clearSelection() : enablePreset(item.id)) }}
                />
              ))}
              {chatPets.map(item => (
                <PetCard
                  key={item.id}
                  thumbnail={item.thumbnail}
                  thumbnailType={item.thumbnail ? 'spritesheet' : undefined}
                  name={item.name}
                  desc={item.description ?? ''}
                  active={active === item.id}
                  disabled={busy}
                  actionLabel={locale.text(active === item.id ? 'clear' : 'select')}
                  onAction={() => { void (active === item.id ? clearSelection() : choose(item.id)) }}
                />
              ))}
            </div>
          )}
    </>
  )

  const codexPanel = (
    <div className="dshp-pet__cards">
      {codexPets.length === 0
        ? <div className="dshp-pet__empty">{locale.text('emptyImported')}</div>
        : codexPets.map(item => (
            <PetCard
              key={item.id}
              thumbnail={item.thumbnail}
              thumbnailType={item.thumbnail ? 'spritesheet' : undefined}
              name={item.name}
              desc={item.description ?? ''}
              active={active === item.id}
              disabled={busy}
              actionLabel={locale.text(active === item.id ? 'clear' : 'select')}
              onAction={() => { void (active === item.id ? clearSelection() : choose(item.id)) }}
            />
          ))}
    </div>
  )

  return (
    <div className="dshp-pet__page">
      <div className="dshp-pet__tabs">
        <div className="dshp-pet__tab-list" role="tablist" aria-label={locale.text('name')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pets'}
            className={tab === 'pets' ? 'dshp-pet__tab-btn dshp-pet__tab-btnActive' : 'dshp-pet__tab-btn'}
            onClick={() => setTab('pets')}
          >
            Pets
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'codex'}
            className={tab === 'codex' ? 'dshp-pet__tab-btn dshp-pet__tab-btnActive' : 'dshp-pet__tab-btn'}
            onClick={() => setTab('codex')}
          >
            Codex
          </button>
        </div>
        <div className="dshp-pet__tab-tools">
          {tab === 'pets'
            ? (
                <>
                  <button type="button" className="dshp-pet__tool-btn" disabled={busy} onClick={() => { void createPet() }}>
                    <Icon as={Plus} />
                    {locale.text('create')}
                  </button>
                  <button type="button" className="dshp-pet__tool-btn" disabled={busy} onClick={() => { void toggleEnabled() }}>
                    {enabled ? locale.text('closePet') : locale.text('enablePet')}
                  </button>
                </>
              )
            : (
                <label className="dshp-pet__tool-btn" aria-disabled={busy}>
                  <Icon as={ArrowDownToLine} />
                  {locale.text('import')}
                  <input
                    type="file"
                    accept=".zip"
                    hidden
                    disabled={busy}
                    onChange={(event) => { void onImport(event) }}
                  />
                </label>
              )}
        </div>
      </div>
      <p className="dshp-pet__tab-desc">
        {tab === 'pets' ? locale.text('tabInstalledDesc') : locale.text('tabCodexDesc')}
      </p>
      <div className="dshp-pet__divider" role="separator" />
      {tab === 'pets' ? petsPanel : codexPanel}
      {error ? <div className="dshp-pet__error" role="alert">{error}</div> : null}
      <div className="dshp-pet__size-row">
        <span className="dshp-pet__size-label">{locale.text('sizeLabel')}</span>
        <input
          type="range"
          className="dshp-pet__size-slider"
          min={PET_SIZE_MIN}
          max={PET_SIZE_MAX}
          step={PET_SIZE_STEP}
          value={size}
          aria-label={locale.text('sizeLabel')}
          onChange={(event) => {
            const value = Number(event.target.value)
            setSize(value)
            void commitSize(value)
          }}
        />
      </div>
      <p className="dshp-pet__hint">{locale.text('sizeHint')}</p>
    </div>
  )
}
