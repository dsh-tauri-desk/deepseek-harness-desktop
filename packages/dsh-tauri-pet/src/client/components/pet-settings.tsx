import type { ChangeEvent, ReactElement } from 'react'
import type { PetListItem, PetSettingsProps } from '../types'
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { MAID_DEEPSEEK_WHALE_PREVIEW } from '../assets/maid-deepseek-whale'
import { BUILTIN_PET_ID, PET_DEFAULT_SIZE, PET_SIZE_MAX, PET_SIZE_MIN, PET_SIZE_STEP } from '../constants'
import { text, usePetLocale } from '../locales'
import {
  fetchPetList,
  fetchPetStatus,
  hidePet,
  importPet,
  setActivePet,
  setPetEnabled,
  setPetSize,
  showPet,
} from '../service/pet'
import { beginPetStatusFetch, commitPetStatusFetch, getPetUiSnapshot, setPetStatus, subscribePetUi } from '../store'
import { IconImport, IconPlus } from './icons'

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
    ? 'dshpet-cardAction dshpet-cardActionActive'
    : 'dshpet-cardAction'
  const thumbnailClassName = props.thumbnailType === 'spritesheet'
    ? 'dshpet-cardThumb dshpet-cardThumbSprite'
    : 'dshpet-cardThumb'

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
        <span className="dshpet-cardName">{props.name}</span>
        {props.desc ? <span className="dshpet-cardDesc">{props.desc}</span> : null}
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

export function PetSettings(props: PetSettingsProps): ReactElement {
  usePetLocale()
  const { status } = useSyncExternalStore(subscribePetUi, getPetUiSnapshot, getPetUiSnapshot)
  const [tab, setTab] = useState<'pets' | 'codex'>('pets')
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [chatPets, setChatPets] = useState<PetListItem[]>([])
  const [codexPets, setCodexPets] = useState<PetListItem[]>([])
  const [size, setSize] = useState(status?.pet_size ?? PET_DEFAULT_SIZE)
  const committedSizeRef = useRef<number | null>(null)
  const enabled = Boolean(status?.enabled)
  const visible = Boolean(status?.visible)
  const active = status?.active_pet ?? BUILTIN_PET_ID
  const statusSize = status?.pet_size ?? PET_DEFAULT_SIZE

  useEffect(() => {
    if (statusSize !== committedSizeRef.current)
      setSize(statusSize)
  }, [statusSize])

  useEffect(() => {
    let cancelled = false
    const revision = beginPetStatusFetch()
    void Promise.all([fetchPetStatus(), fetchPetList('chat'), fetchPetList('codex')])
      .then(([nextStatus, nextChatPets, nextCodexPets]) => {
        if (cancelled)
          return
        commitPetStatusFetch(revision, nextStatus)
        setChatPets(nextChatPets)
        setCodexPets(nextCodexPets)
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
      <div className="dshpet-cards">
        <PetCard
          thumbnail={MAID_DEEPSEEK_WHALE_PREVIEW}
          thumbnailType="gif"
          name={text('petNameWhale')}
          desc={text('petDescWhale')}
          active={active === BUILTIN_PET_ID}
          disabled={busy || active === BUILTIN_PET_ID}
          actionLabel={text(active === BUILTIN_PET_ID ? 'selected' : 'select')}
          onAction={() => { void choose(BUILTIN_PET_ID) }}
        />
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
