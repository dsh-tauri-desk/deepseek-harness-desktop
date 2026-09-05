import type { ChangeEvent, ReactElement } from 'react'
import type { PetListItem, PetSettingsProps, PresetDownloadProgress, PresetPetItem } from '../types'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { BUILTIN_PET_ID, PET_DEFAULT_SIZE, PET_SIZE_MAX, PET_SIZE_MIN, PET_SIZE_STEP } from '../constants'
import { text, usePetLocale } from '../locales'
import {
  downloadPresetPet,
  fetchPetList,
  fetchPetStatus,
  fetchPresetDownloadProgress,
  fetchPresetPets,
  hidePet,
  importPet,
  setActivePet,
  setPetEnabled,
  setPetSize,
  showPet,
} from '../service/pet'
import { beginPetStatusFetch, commitPetStatusFetch, getPetUiSnapshot, setPetStatus, subscribePetUi } from '../store'
import { progressPercent, resolvePresetCardAction } from '../utils/preset-card'
import { IconImport, IconPlus } from './icons'

/** 预设宠物下载轮询间隔（ms）。 */
const PRESET_DOWNLOAD_POLL_MS = 400

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
  /** 下载进度（仅下载/解压中显示进度条）。 */
  progress?: PresetDownloadProgress | null
  /** 下载尺寸标签（`[number]mb`）。 */
  sizeLabel?: string
  thumbnail?: string
  thumbnailType?: 'gif' | 'spritesheet'
}

function PetCard(props: PetCardProps): ReactElement {
  const actionClassName = props.active
    ? 'dshpet-cardAction dshpet-cardActionActive'
    : 'dshpet-cardAction'
  const thumbnailClassName = props.thumbnailType === 'spritesheet'
    ? 'dshpet-cardThumb dshpet-cardThumbSprite'
    : 'dshpet-cardThumb'
  const percent = props.progress ? progressPercent(props.progress) : null

  return (
    <div className="dshpet-cardItem">
      {props.thumbnail
        ? props.thumbnailType === 'spritesheet'
          ? (
              <span className={thumbnailClassName} aria-hidden="true">
                <img src={props.thumbnail} alt="" aria-hidden="true" />
              </span>
            )
          : <img className={thumbnailClassName} src={props.thumbnail} alt="" aria-hidden="true" />
        : <div className="dshpet-cardThumb dshpet-cardThumbPlaceholder" aria-hidden="true">PET</div>}
      <span className="dshpet-cardBody">
        <span className="dshpet-cardNameRow">
          <span className="dshpet-cardName">{props.name}</span>
          {props.sizeLabel ? <span className="dshpet-cardSize">{props.sizeLabel}</span> : null}
        </span>
        {props.desc ? <span className="dshpet-cardDesc">{props.desc}</span> : null}
        {props.progress
          ? (
              <span
                className="dshpet-cardProgress"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={percent ?? undefined}
              >
                <span
                  className={percent === null ? 'dshpet-cardProgressFill dshpet-cardProgressIndeterminate' : 'dshpet-cardProgressFill'}
                  style={percent === null ? undefined : { width: `${percent}%` }}
                />
              </span>
            )
          : null}
      </span>
      <button
        type="button"
        className={actionClassName}
        disabled={props.disabled}
        onClick={props.onAction}
      >
        {props.actionLabel}
      </button>
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

/** 预设宠物卡片右侧动作（已选/下载中/启用/下载），纯状态机见 utils/preset-card。 */
export function presetCardAction(
  item: Pick<PresetPetItem, 'id' | 'installed' | 'phase'>,
  active: string,
  progress: PresetDownloadProgress | null | undefined,
): 'download' | 'downloading' | 'enable' | 'selected' {
  return resolvePresetCardAction(item, active, progress)
}

export function PetSettings(props: PetSettingsProps): ReactElement {
  usePetLocale()
  const { status } = useSyncExternalStore(subscribePetUi, getPetUiSnapshot, getPetUiSnapshot)
  const [tab, setTab] = useState<'pets' | 'codex'>('pets')
  // 无缓存（首次挂载）时进入加载态，避免空列表闪烁；有缓存直接渲染、后台静默刷新。
  const [busy, setBusy] = useState(() => cachedPresetPets === null)
  const [error, setError] = useState<string | null>(null)
  const [chatPets, setChatPets] = useState<PetListItem[]>(() => cachedChatPets ?? [])
  const [codexPets, setCodexPets] = useState<PetListItem[]>(() => cachedCodexPets ?? [])
  const [presetPets, setPresetPets] = useState<PresetPetItem[]>(() => cachedPresetPets ?? [])
  /** 各预设宠物下载进度（key = preset id；phase=done/failed 后由轮询清理）。 */
  const [downloads, setDownloads] = useState<Record<string, PresetDownloadProgress>>({})
  const downloadTimersRef = useRef<Record<string, ReturnType<typeof setInterval>>>({})
  const [size, setSize] = useState(status?.pet_size ?? PET_DEFAULT_SIZE)
  const committedSizeRef = useRef<number | null>(null)
  /**
   * 尺寸提交串行链：range 拖动连续 onChange 时按顺序逐个提交，防止多个 setPetSize
   * 请求乱序完成、旧值覆盖最终值；链任务执行时只取「最新的 pending 值」，
   * 拖动期间快速滑动只提交最终值。
   */
  const sizeCommitChainRef = useRef<Promise<void>>(Promise.resolve())
  /** 链上任务实际提交的值（拖动期间每次 onChange 覆盖为最新）。 */
  const pendingSizeRef = useRef<number | null>(null)
  const enabled = Boolean(status?.enabled)
  const visible = Boolean(status?.visible)
  const active = status?.active_pet ?? BUILTIN_PET_ID
  const statusSize = status?.pet_size ?? PET_DEFAULT_SIZE

  useEffect(() => {
    if (statusSize !== committedSizeRef.current)
      setSize(statusSize)
  }, [statusSize])

  const refreshPresets = useCallback(async (): Promise<void> => {
    try {
      const [nextPresetPets, nextStatus] = await Promise.all([fetchPresetPets(), fetchPetStatus()])
      cachedPresetPets = nextPresetPets
      setPresetPets(nextPresetPets)
      const revision = beginPetStatusFetch()
      commitPetStatusFetch(revision, nextStatus)
      setPetStatus(nextStatus)
    }
    catch (refreshError) {
      console.error('[dsh-tauri-pet] refresh preset pets failed:', refreshError)
      setError(text('listFailed'))
    }
  }, [])

  /** 轮询下载进度；终态后清理定时器并刷新清单。 */
  const pollPresetDownload = useCallback((id: string): void => {
    if (downloadTimersRef.current[id])
      return
    const timer = setInterval(() => {
      void fetchPresetDownloadProgress(id).then((progress) => {
        setDownloads(previous => ({ ...previous, [id]: progress }))
        if (progress.phase === 'done' || progress.phase === 'failed') {
          if (downloadTimersRef.current[id]) {
            clearInterval(downloadTimersRef.current[id])
            delete downloadTimersRef.current[id]
          }
          if (progress.phase === 'failed')
            setError(progress.error ?? text('downloadFailed'))
          else
            void refreshPresets()
        }
      }).catch(() => {
        if (downloadTimersRef.current[id]) {
          clearInterval(downloadTimersRef.current[id])
          delete downloadTimersRef.current[id]
        }
      })
    }, PRESET_DOWNLOAD_POLL_MS)
    downloadTimersRef.current[id] = timer
  }, [refreshPresets])

  useEffect(() => {
    let cancelled = false
    const revision = beginPetStatusFetch()
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
        // 跨挂载恢复进行中的下载：清单 phase 标记 downloading/extracting 的项重新轮询，
        // 避免「返回应用再进设置」丢失进度视图、重复点击触发 PET_PRESET_BUSY。
        // 占位进度先写入 downloads，让不确定进度条在第一次轮询返回前立即出现。
        const resumed: Record<string, PresetDownloadProgress> = {}
        for (const item of nextPresetPets) {
          if (item.phase === 'downloading' || item.phase === 'extracting') {
            resumed[item.id] = { phase: item.phase, received: 0, total: 0 }
            pollPresetDownload(item.id)
          }
        }
        if (Object.keys(resumed).length > 0)
          setDownloads(previous => ({ ...previous, ...resumed }))
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
      for (const timer of Object.values(downloadTimersRef.current))
        clearInterval(timer)
      downloadTimersRef.current = {}
    }
  }, [pollPresetDownload])

  async function startDownload(id: string): Promise<void> {
    if (busy)
      return
    setBusy(true)
    setError(null)
    try {
      await downloadPresetPet(id)
      pollPresetDownload(id)
    }
    catch (downloadError) {
      // PET_PRESET_BUSY：下载已在后台进行（例如清单 phase 尚未刷新、跨挂载竞态）。
      // 恢复轮询接管既有下载，而不是报错或再次触发。
      if (String(downloadError).includes('PET_PRESET_BUSY'))
        pollPresetDownload(id)
      else
        setError(text('downloadFailed'))
    }
    finally {
      setBusy(false)
    }
  }

  /** 启用预设宠物：选择它，并确保桌宠被唤醒（自动触发唤醒）。 */
  async function enablePreset(id: string): Promise<void> {
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
  }

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

  async function toggleVisibility(): Promise<void> {
    if (busy)
      return
    setBusy(true)
    setError(null)
    try {
      const nextStatus = !enabled
        ? await setPetEnabled(true)
        : visible
          ? await hidePet()
          : await showPet()
      setPetStatus(nextStatus)
    }
    catch (toggleError) {
      console.error('[dsh-tauri-pet] visibility failed:', toggleError)
      setError(text('toggleFailed'))
    }
    finally {
      setBusy(false)
    }
  }

  function commitSize(value: number): void {
    setError(null)
    // 记录最新值并把提交任务追加到串行链尾：任何时刻链上只有一个在途请求，
    // 完成顺序与发起顺序一致，最终值必然最后落盘。
    pendingSizeRef.current = value
    sizeCommitChainRef.current = sizeCommitChainRef.current.then(async () => {
      const latest = pendingSizeRef.current
      if (latest === null)
        return
      pendingSizeRef.current = null
      try {
        const nextStatus = await setPetSize(latest)
        committedSizeRef.current = latest
        setPetStatus(nextStatus)
      }
      catch (sizeError) {
        console.error('[dsh-tauri-pet] set size failed:', sizeError)
        setError(text('setSizeFailed'))
      }
    })
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
      setCodexPets(await fetchPetList('codex'))
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
        ? <div className="dshpet-loading">{text('loading')}</div>
        : (
            <div className="dshpet-cards">
              {presetPets.map((item) => {
                const progress = downloads[item.id] ?? null
                const action = presetCardAction(item, active, progress)
                const downloading = action === 'downloading'
                return (
                  <PetCard
                    key={item.id}
                    thumbnail={item.image ?? undefined}
                    name={item.name}
                    desc={item.desc ?? ''}
                    sizeLabel={item.size_mb != null ? `${Math.round(item.size_mb)}mb` : undefined}
                    progress={downloading ? progress : null}
                    active={action === 'selected'}
                    disabled={busy || downloading || action === 'selected'}
                    actionLabel={action === 'selected' ? text('selected') : action === 'enable' ? text('enable') : downloading ? text('downloading') : text('download')}
                    onAction={() => {
                      if (action === 'enable')
                        void enablePreset(item.id)
                      else if (action === 'download')
                        void startDownload(item.id)
                    }}
                  />
                )
              })}
              {chatPets.map(item => (
                <PetCard
                  key={item.id}
                  thumbnail={item.thumbnail}
                  thumbnailType={item.thumbnail ? 'spritesheet' : undefined}
                  name={item.name}
                  desc={item.description ?? ''}
                  active={active === item.id}
                  disabled={busy || active === item.id}
                  actionLabel={text(active === item.id ? 'selected' : 'select')}
                  onAction={() => { void choose(item.id) }}
                />
              ))}
            </div>
          )}
    </>
  )

  const codexPanel = (
    <div className="dshpet-cards">
      {codexPets.length === 0
        ? <div className="dshpet-empty">{text('emptyImported')}</div>
        : codexPets.map(item => (
            <PetCard
              key={item.id}
              thumbnail={item.thumbnail}
              thumbnailType={item.thumbnail ? 'spritesheet' : undefined}
              name={item.name}
              desc={item.description ?? ''}
              active={active === item.id}
              disabled={busy || active === item.id}
              actionLabel={text(active === item.id ? 'selected' : 'select')}
              onAction={() => { void choose(item.id) }}
            />
          ))}
    </div>
  )

  return (
    <div className="dshpet-page">
      <div className="dshpet-tabs">
        <div className="dshpet-tabList" role="tablist" aria-label={text('name')}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'pets'}
            className={tab === 'pets' ? 'dshpet-tabBtn dshpet-tabBtnActive' : 'dshpet-tabBtn'}
            onClick={() => setTab('pets')}
          >
            Pets
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'codex'}
            className={tab === 'codex' ? 'dshpet-tabBtn dshpet-tabBtnActive' : 'dshpet-tabBtn'}
            onClick={() => setTab('codex')}
          >
            Codex
          </button>
        </div>
        <div className="dshpet-tabTools">
          {tab === 'pets'
            ? (
                <>
                  <button type="button" className="dshpet-toolBtn" disabled={busy} onClick={() => { void createPet() }}>
                    <IconPlus />
                    {text('create')}
                  </button>
                  <button type="button" className="dshpet-toolBtn" disabled={busy} onClick={() => { void toggleVisibility() }}>
                    {visible ? text('collapsePet') : text('wakePet')}
                  </button>
                </>
              )
            : (
                <label className="dshpet-toolBtn" aria-disabled={busy}>
                  <IconImport />
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
      <p className="dshpet-tabDesc">
        {tab === 'pets' ? text('tabInstalledDesc') : text('tabCodexDesc')}
      </p>
      <div className="dshpet-divider" role="separator" />
      {tab === 'pets' ? petsPanel : codexPanel}
      {error ? <div className="dshpet-error" role="alert">{error}</div> : null}
      <div className="dshpet-sizeRow">
        <span className="dshpet-sizeLabel">{text('sizeLabel')}</span>
        <input
          type="range"
          className="dshpet-sizeSlider"
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
      <p className="dshpet-hint">{text('sizeHint')}</p>
    </div>
  )
}
