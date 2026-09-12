import type { ChangeEvent, ReactElement } from 'react'
import type { PetListItem, PetSettingsProps, PresetPetItem } from '../types'
import { ArrowDownToLine, Icon, Plus, useMountStyle } from 'dsh-tauri-ui/client'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { PET_DEFAULT_SIZE, PET_SIZE_MAX, PET_SIZE_MIN, PET_SIZE_STEP } from '../constants'
import { text, usePetLocale } from '../locales'
import {
  fetchPetList,
  fetchPetStatus,
  fetchPresetPets,
  importPet,
  setActivePet,
  setPetEnabled,
  setPetSize,
} from '../service/pet'
import { beginPetStatusFetch, commitPetStatusFetch, getPetUiSnapshot, setPetStatus, subscribePetUi } from '../store'
import petSettingsStyle from './pet-settings.cssr'

/** 模块级清单缓存：跨组件挂载复用，避免反复打开设置页闪烁（初次仍显示加载占位）。 */
let cachedPresetPets: PresetPetItem[] | null = null
let cachedChatPets: PetListItem[] | null = null
let cachedCodexPets: PetListItem[] | null = null

interface PetCardProps {
  actionLabel: string
  active: boolean
  desc: string
  disabled: boolean
  name: string
  onAction: () => void
  thumbnail?: string
  thumbnailType?: 'gif' | 'spritesheet'
}

function PetCard(props: PetCardProps): ReactElement {
  const actionClassName = props.active
    ? 'dshp-pet__card-action dshp-pet__card-actionActive'
    : 'dshp-pet__card-action'
  const thumbnailClassName = props.thumbnailType === 'spritesheet'
    ? 'dshp-pet__card-thumb dshp-pet__card-thumbSprite'
    : 'dshp-pet__card-thumb'

  return (
    <div className="dshp-pet__card-item">
      {props.thumbnail
        ? props.thumbnailType === 'spritesheet'
          ? (
              <span className={thumbnailClassName} aria-hidden="true">
                <img src={props.thumbnail} alt="" aria-hidden="true" />
              </span>
            )
          : <img className={thumbnailClassName} src={props.thumbnail} alt="" aria-hidden="true" />
        : <div className="dshp-pet__card-thumb dshp-pet__card-thumbPlaceholder" aria-hidden="true">PET</div>}
      <span className="dshp-pet__card-body">
        <span className="dshp-pet__card-nameRow">
          <span className="dshp-pet__card-name">{props.name}</span>
        </span>
        {props.desc ? <span className="dshp-pet__card-desc">{props.desc}</span> : null}
      </span>
      <span className="dshp-pet__card-actions">
        <button
          type="button"
          className={actionClassName}
          disabled={props.disabled}
          onClick={props.onAction}
        >
          {props.actionLabel}
        </button>
      </span>
    </div>
  )
}

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

/**
 * 桌宠设置页：预设 / Chat / Codex 三类宠物卡片（选择、启用、取消选择）、开关、大小滑条与导入。
 */
export function PetSettings(props: PetSettingsProps): ReactElement {
  useMountStyle(petSettingsStyle, 'dsh-tauri-pet-settings-styles')
  usePetLocale()
  const { status } = useSyncExternalStore(subscribePetUi, getPetUiSnapshot, getPetUiSnapshot)
  const [tab, setTab] = useState<'pets' | 'codex'>('pets')
  // 无缓存（首次挂载）时进入加载态，避免空列表闪烁；有缓存直接渲染、后台静默刷新。
  const [busy, setBusy] = useState(() => cachedPresetPets === null)
  const [error, setError] = useState<string | null>(null)
  const [chatPets, setChatPets] = useState<PetListItem[]>(() => cachedChatPets ?? [])
  const [codexPets, setCodexPets] = useState<PetListItem[]>(() => cachedCodexPets ?? [])
  const [presetPets, setPresetPets] = useState<PresetPetItem[]>(() => cachedPresetPets ?? [])
  const [size, setSize] = useState(status?.pet_size ?? PET_DEFAULT_SIZE)
  const committedSizeRef = useRef<number | null>(null)
  const enabled = Boolean(status?.enabled)
  const active = status?.active_pet ?? ''
  const statusSize = status?.pet_size ?? PET_DEFAULT_SIZE

  useEffect(() => {
    if (statusSize !== committedSizeRef.current)
      setSize(statusSize)
  }, [statusSize])

  useEffect(() => {
    let cancelled = false
    const revision = beginPetStatusFetch()
    // 预设直连远端素材：清单拉回来即可直接启用，没有安装/下载状态需要跟踪。
    void Promise.all([fetchPetStatus(), fetchPetList('chat'), fetchPetList('codex'), fetchPresetPets()])
      .then(([nextStatus, nextChatPets, nextCodexPets, nextPresetPets]) => {
        if (cancelled)
          return
        commitPetStatusFetch(revision, nextStatus)
        cachedChatPets = nextChatPets
        cachedCodexPets = nextCodexPets
        cachedPresetPets = nextPresetPets
        setChatPets(nextChatPets)
        setCodexPets(nextCodexPets)
        setPresetPets(nextPresetPets)
      })
      .catch((loadError) => {
        if (cancelled)
          return
        console.error('[dsh-tauri-pet] initial load failed:', loadError)
        setError(text('listFailed'))
      })
      .finally(() => {
        if (!cancelled)
          setBusy(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /** 启用预设宠物：选择它，并确保桌宠被唤醒（自动触发唤醒）。 */
  const enablePreset = useCallback(async (id: string): Promise<void> => {
    if (busy || active === id)
      return
    setBusy(true)
    setError(null)
    try {
      let nextStatus = await setActivePet(id)
      if (!nextStatus.enabled)
        nextStatus = await setPetEnabled(true)
      setPetStatus(nextStatus)
    }
    catch (enableError) {
      console.error('[dsh-tauri-pet] enable preset failed:', enableError)
      setError(text('setPetFailed'))
    }
    finally {
      setBusy(false)
    }
  }, [active, busy])

  async function choose(id: string): Promise<void> {
    if (busy || active === id)
      return
    setBusy(true)
    setError(null)
    try {
      setPetStatus(await setActivePet(id))
    }
    catch (chooseError) {
      console.error('[dsh-tauri-pet] choose failed:', chooseError)
      setError(text('setPetFailed'))
    }
    finally {
      setBusy(false)
    }
  }

  /**
   * 取消选择：清空已选宠物；仍在启用时一并关闭桌宠（无内容可渲染，不留空窗口）。
   *
   * 先关闭再清空：若第二步失败，最坏情况也只是保留选择但窗口已销毁，
   * 不会留下一个空窗口。任一步失败都从后端重拉状态，避免界面与持久层不一致。
   */
  async function clearSelection(): Promise<void> {
    if (busy || active === '')
      return
    setBusy(true)
    setError(null)
    try {
      if (enabled)
        setPetStatus(await setPetEnabled(false))
      setPetStatus(await setActivePet(''))
    }
    catch (clearError) {
      console.error('[dsh-tauri-pet] clear selection failed:', clearError)
      setError(text('clearFailed'))
      try {
        setPetStatus(await fetchPetStatus())
      }
      catch {
        // 后端不可达时保留最后已知状态，下次成功请求会自动同步。
      }
    }
    finally {
      setBusy(false)
    }
  }

  /** 启用/关闭桌宠：纯持久开关，关闭后重启不再自动拉起。 */
  async function toggleEnabled(): Promise<void> {
    if (busy)
      return
    setBusy(true)
    setError(null)
    try {
      setPetStatus(await setPetEnabled(!enabled))
    }
    catch (toggleError) {
      console.error('[dsh-tauri-pet] toggle pet failed:', toggleError)
      setError(text('toggleFailed'))
    }
    finally {
      setBusy(false)
    }
  }

  async function commitSize(value: number): Promise<void> {
    setError(null)
    try {
      const nextStatus = await setPetSize(value)
      committedSizeRef.current = value
      setPetStatus(nextStatus)
    }
    catch (sizeError) {
      console.error('[dsh-tauri-pet] set size failed:', sizeError)
      setError(text('setSizeFailed'))
    }
  }

  async function createPet(): Promise<void> {
    if (busy)
      return
    setBusy(true)
    setError(null)
    try {
      await props.onCreate(props.close)
    }
    catch (createError) {
      console.error('[dsh-tauri-pet] create session failed:', createError)
      setError(text('createFailed'))
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
      await importPet(file.name, await readAsBase64(file))
      const nextCodexPets = await fetchPetList('codex')
      cachedCodexPets = nextCodexPets
      setCodexPets(nextCodexPets)
    }
    catch (importError) {
      console.error('[dsh-tauri-pet] import failed:', importError)
      setError(text('importFailed'))
    }
    finally {
      setBusy(false)
    }
  }

  const petsPanel = (
    <>
      {busy && presetPets.length === 0 && chatPets.length === 0
        ? <div className="dshp-pet__loading">{text('loading')}</div>
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
                  actionLabel={text(active === item.id ? 'clear' : 'enable')}
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
                  actionLabel={text(active === item.id ? 'clear' : 'select')}
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
        ? <div className="dshp-pet__empty">{text('emptyImported')}</div>
        : codexPets.map(item => (
            <PetCard
              key={item.id}
              thumbnail={item.thumbnail}
              thumbnailType={item.thumbnail ? 'spritesheet' : undefined}
              name={item.name}
              desc={item.description ?? ''}
              active={active === item.id}
              disabled={busy}
              actionLabel={text(active === item.id ? 'clear' : 'select')}
              onAction={() => { void (active === item.id ? clearSelection() : choose(item.id)) }}
            />
          ))}
    </div>
  )

  return (
    <div className="dshp-pet__page">
      <div className="dshp-pet__tabs">
        <div className="dshp-pet__tab-list" role="tablist" aria-label={text('name')}>
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
                    {text('create')}
                  </button>
                  <button type="button" className="dshp-pet__tool-btn" disabled={busy} onClick={() => { void toggleEnabled() }}>
                    {enabled ? text('closePet') : text('enablePet')}
                  </button>
                </>
              )
            : (
                <label className="dshp-pet__tool-btn" aria-disabled={busy}>
                  <Icon as={ArrowDownToLine} />
                  {text('import')}
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
        {tab === 'pets' ? text('tabInstalledDesc') : text('tabCodexDesc')}
      </p>
      <div className="dshp-pet__divider" role="separator" />
      {tab === 'pets' ? petsPanel : codexPanel}
      {error ? <div className="dshp-pet__error" role="alert">{error}</div> : null}
      <div className="dshp-pet__size-row">
        <span className="dshp-pet__size-label">{text('sizeLabel')}</span>
        <input
          type="range"
          className="dshp-pet__size-slider"
          min={PET_SIZE_MIN}
          max={PET_SIZE_MAX}
          step={PET_SIZE_STEP}
          value={size}
          aria-label={text('sizeLabel')}
          onChange={(event) => {
            const value = Number(event.target.value)
            setSize(value)
            void commitSize(value)
          }}
        />
      </div>
      <p className="dshp-pet__hint">{text('sizeHint')}</p>
    </div>
  )
}
