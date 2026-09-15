import type { ReactElement } from 'react'
import type { SkillRowView } from '../apis/index.type'
import type { OpenTarget, SkillEditorState, SkillsTabProps } from './skills-tab.types'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ArrowRotateRight, GraduationCap, Icon, LogoGithub, useMountStyle } from 'dsh-tauri-ui/client'
import { orderBy, uniq } from 'dsh-tauri/client'
import { useEffect, useMemo, useState } from 'react'
import { getSkill, getSkills, postOpen, postRootsAdd, postSkillDelete, postSkillPolicy, postSkillSave, postSkillsRefresh } from '../apis'
import { MarkdownPreview } from '../components/markdown'
import { IMPORT_REFRESH_DELAYS_MS, SKILL_REFRESH_INTERVAL_MS, SKILL_REFRESH_TIMEOUT_MS, SKILLS_TAB_STYLE_ID, SOURCE_LOCALE_KEYS } from '../constants'
import { useTimers } from '../hooks/use-timers'
import skillsTabStyle from './skills-tab.cssr'
import { normalizeRepository, policyTag } from './skills-tab.utils'

export function SkillsTab({ t, createSkill }: SkillsTabProps): ReactElement {
  useMountStyle(skillsTabStyle, SKILLS_TAB_STYLE_ID)
  const [skills, setSkills] = useState<SkillRowView[] | null>(null)
  const [editor, setEditor] = useState<SkillEditorState | null>(null)
  const [preview, setPreview] = useState(false)
  const [confirmName, setConfirmName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [outcome, setOutcome] = useState<{ ok: boolean, text: string } | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [reload, setReload] = useState(0)
  const [query, setQuery] = useState('')
  const [sourceFilter, setSourceFilter] = useState('all')
  const [importOpen, setImportOpen] = useState(false)
  const [repositoryUrl, setRepositoryUrl] = useState('')
  const { mounted, later } = useTimers()

  useEffect(() => {
    let current = true
    void getSkills().then(
      (body) => {
        if (current)
          setSkills(body.skills)
      },
      (error: unknown) => {
        if (current) {
          setSkills([])
          setOutcome({ ok: false, text: `${t('failed')}: ${error instanceof Error ? error.message : String(error)}` })
        }
      },
    )
    return () => {
      current = false
    }
  }, [reload, t])

  const doRefresh = async (): Promise<void> => {
    setBusy(true)
    try {
      const body = await postSkillsRefresh()
      setSkills(body.skills)
      setOutcome({ ok: true, text: t('refreshed') })
    }
    catch {
      setReload(value => value + 1)
    }
    finally { setBusy(false) }
  }

  const refreshUntil = (predicate: (rows: SkillRowView[]) => boolean): void => {
    const deadline = Date.now() + SKILL_REFRESH_TIMEOUT_MS
    const tick = (): void => {
      if (Date.now() > deadline)
        return
      later(() => void getSkills().then((body) => {
        if (!mounted.current)
          return
        setSkills(body.skills)
        if (!predicate(body.skills))
          tick()
      }, tick), SKILL_REFRESH_INTERVAL_MS)
    }
    tick()
  }

  const openExisting = async (skill: SkillRowView): Promise<void> => {
    setBusy(true)
    try {
      const body = await getSkill(skill.name)
      setPreview(!skill.editable)
      setEditor({ mode: skill.editable ? 'edit' : 'view', name: skill.name, description: skill.description, whenToUse: skill.whenToUse ?? '', modelInvocable: skill.invocation.modelInvocable, userInvocable: skill.invocation.userInvocable, content: body.content })
    }
    catch (error) { setOutcome({ ok: false, text: `${t('failed')}: ${error instanceof Error ? error.message : String(error)}` }) }
    finally { setBusy(false) }
  }

  const doSave = async (): Promise<void> => {
    if (editor === null)
      return
    const name = editor.name.trim()
    setBusy(true)
    setFormError(null)
    try {
      await postSkillSave({ name: editor.name.trim(), description: editor.description, whenToUse: editor.whenToUse.trim() || undefined, modelInvocable: editor.modelInvocable, userInvocable: editor.userInvocable, content: editor.content })
      setEditor(null)
      setOutcome({ ok: true, text: t('saved') })
      refreshUntil(rows => rows.some(row => row.name === name))
    }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)) }
    finally { setBusy(false) }
  }

  const doDelete = async (): Promise<void> => {
    if (confirmName === null)
      return
    const name = confirmName
    setBusy(true)
    try {
      await postSkillDelete({ name })
      setOutcome({ ok: true, text: t('saved') })
      refreshUntil(rows => !rows.some(row => row.name === name))
    }
    catch (error) { setOutcome({ ok: false, text: `${t('failed')}: ${error instanceof Error ? error.message : String(error)}` }) }
    finally {
      setBusy(false)
      setConfirmName(null)
    }
  }

  const doToggle = async (skill: SkillRowView): Promise<void> => {
    const enabled = skill.invocation.modelInvocable || skill.invocation.userInvocable
    setBusy(true)
    try {
      await postSkillPolicy({ name: skill.name, enabled: !enabled })
      setOutcome({ ok: true, text: t(enabled ? 'skillDisabledMsg' : 'skillEnabled') })
      refreshUntil((rows) => {
        const row = rows.find(item => item.name === skill.name)
        return row !== undefined && row.invocation.modelInvocable === !enabled && row.invocation.userInvocable === !enabled
      })
    }
    catch (error) { setOutcome({ ok: false, text: `${t('failed')}: ${error instanceof Error ? error.message : String(error)}` }) }
    finally { setBusy(false) }
  }

  const doOpen = async (target: OpenTarget): Promise<void> => {
    try {
      await postOpen(target)
    }
    catch (error) { setOutcome({ ok: false, text: `${t('failed')}: ${error instanceof Error ? error.message : String(error)}` }) }
  }

  const doCreate = async (): Promise<void> => {
    setBusy(true)
    try {
      await createSkill()
    }
    catch (error) { setOutcome({ ok: false, text: `${t('skillCreatorFailed')}: ${error instanceof Error ? error.message : String(error)}` }) }
    finally {
      if (mounted.current)
        setBusy(false)
    }
  }

  const doImport = async (): Promise<void> => {
    const url = normalizeRepository(repositoryUrl)
    if (url === null) {
      setFormError(t('importRepositoryInvalid'))
      return
    }
    setBusy(true)
    setFormError(null)
    try {
      await postRootsAdd(url)
      setOutcome({ ok: true, text: t('importRepositorySuccess') })
      setImportOpen(false)
      setRepositoryUrl('')
      for (const delay of IMPORT_REFRESH_DELAYS_MS) {
        await new Promise<void>(resolve => later(resolve, delay))
        if (!mounted.current)
          return
        setSkills((await getSkills()).skills)
      }
    }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)) }
    finally {
      if (mounted.current)
        setBusy(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const filtered = useMemo(() => orderBy((skills ?? []).filter(skill => (sourceFilter === 'all' || skill.source === sourceFilter) && (needle === '' || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))), [skill => skill.repository === undefined]), [needle, skills, sourceFilter])
  const sources = skills === null ? [] : uniq(skills.map(skill => skill.source))
  const readOnly = editor?.mode === 'view'

  return (
    <div className="dshp-extension__section" style={{ margin: '0' }}>
      <div className="dshp-extension__head">
        <Icon as={GraduationCap} />
        <h3>{t('skillsTitle')}</h3>
        <span className="dshp-extension__spacer" />
        <Button variant="ghost" size="sm" onClick={() => void doOpen({ target: 'user-skills' })}>{t('openUserSkills')}</Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            setFormError(null)
            setImportOpen(true)
          }}
        >
          {t('importRepository')}
        </Button>
        <Button variant="primary" size="sm" disabled={busy} onClick={() => void doCreate()}>{t('newSkill')}</Button>

      </div>
      <p className="dshp-extension__intro">{t('skillsIntro')}</p>
      {outcome && (
        <div className="dshp-extension__banner" data-kind={outcome.ok ? 'ok' : 'error'} role="status">
          <StateDot state={outcome.ok ? 'done' : 'error'} size={10} />
          <div className="dshp-extension__banner-body">{outcome.text}</div>
        </div>
      )}
      <div className="dshp-extension__list-head">
        <h3>{t('skillsTab')}</h3>
        {skills && (
          <span className="dshp-extension__count">
            {filtered.length}
            /
            {skills.length}
          </span>
        )}
        <span className="dshp-extension__spacer" />
        <input className="dshp-extension__search" type="search" placeholder={t('searchSkills')} aria-label={t('searchSkills')} value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" className="dshp-extension__refresh" aria-label={t('refresh')} title={t('refresh')} disabled={busy} onClick={() => void doRefresh()}><Icon as={ArrowRotateRight} /></button>
      </div>
      {sources.length > 1 && <div className="dshp-extension__chips" role="group" aria-label={t('source')}>{[{ id: 'all', label: t('filterAll') }, ...sources.map(source => ({ id: source, label: t(SOURCE_LOCALE_KEYS[source] ?? 'sourceCustom') }))].map(chip => <button key={chip.id} type="button" className="dshp-extension__chip" data-active={sourceFilter === chip.id ? 'true' : undefined} onClick={() => setSourceFilter(chip.id)}>{chip.label}</button>)}</div>}
      {skills === null && <p className="dshp-extension__empty">{t('loading')}</p>}
      {skills !== null && filtered.length === 0 && <p className="dshp-extension__empty">{skills.length === 0 ? t('emptySkills') : t('noMatch')}</p>}
      {filtered.length > 0 && (
        <ul className="dshp-extension__cards">
          {filtered.map((skill) => {
            const tag = policyTag(skill)
            return (
              <li className="dshp-extension__card" key={`${skill.source}/${skill.name}`}>
                <div className="dshp-extension__card-top">
                  <strong className="dshp-extension__card-title" title={skill.name}>{skill.name}</strong>
                  <span className="dshp-extension__tag" data-kind="source">{t(SOURCE_LOCALE_KEYS[skill.source] ?? 'sourceCustom')}</span>
                  {tag.key && <span className="dshp-extension__tag" data-kind={tag.off ? 'off' : undefined}>{t(tag.key)}</span>}
                </div>
                <p className="dshp-extension__card-desc" title={skill.description}>{skill.description}</p>
                <div className="dshp-extension__card-row">
                  {skill.policyEditable && <button type="button" className="dshp-extension__switch" role="switch" aria-checked={skill.invocation.modelInvocable || skill.invocation.userInvocable} aria-label={t('toggleSkill')} title={t('toggleSkillHint')} disabled={busy} onClick={() => void doToggle(skill)}><span className="dshp-extension__switch-knob" /></button>}
                  {skill.dir && <button type="button" className="dshp-extension__link" onClick={() => void doOpen({ target: 'skill', name: skill.name })}>{t('openFolder')}</button>}
                  <span className="dshp-extension__spacer" />
                  {skill.repository?.githubUrl && <a className="dshp-extension__icon-link" href={skill.repository.githubUrl} target="_blank" rel="noreferrer" aria-label={t('githubRepository')} title={t('githubRepository')}><Icon as={LogoGithub} /></a>}
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void openExisting(skill)}>{skill.editable ? t('edit') : t('view')}</Button>
                  {skill.removable && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmName(skill.name)}>{t('delete')}</Button>}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Modal open={editor !== null} onClose={() => setEditor(null)} closeLabel={t('close')} title={editor?.mode === 'edit' ? t('editSkill') : t('viewSkill')} className="dshp-extension dshp-extension__modal-form" contentClassName="dshp-extension__modal-scroll">
        {editor && (
          <div className="dshp-extension__form">
            <label className="dshp-extension__label">
              <span>{t('skillName')}</span>
              <input className="dshp-extension__input" value={editor.name} disabled />
            </label>
            <label className="dshp-extension__label">
              <span>{t('skillDescription')}</span>
              <input className="dshp-extension__input" value={editor.description} disabled={readOnly} onChange={event => setEditor({ ...editor, description: event.target.value })} />
            </label>
            <label className="dshp-extension__label">
              <span>{t('skillWhenToUse')}</span>
              <input className="dshp-extension__input" value={editor.whenToUse} disabled={readOnly} onChange={event => setEditor({ ...editor, whenToUse: event.target.value })} />
            </label>
            <div className="dshp-extension__checks">
              <label>
                <input type="checkbox" checked={editor.modelInvocable} disabled={readOnly} onChange={event => setEditor({ ...editor, modelInvocable: event.target.checked })} />
                {t('modelInvocable')}
              </label>
              <label>
                <input type="checkbox" checked={editor.userInvocable} disabled={readOnly} onChange={event => setEditor({ ...editor, userInvocable: event.target.checked })} />
                {t('userInvocable')}
              </label>
            </div>
            <div className="dshp-extension__label">
              <div className="dshp-extension__card-row">
                <span>{t('skillContent')}</span>
                <span className="dshp-extension__spacer" />
                <div className="dshp-extension__segments" role="tablist" aria-label={t('skillContent')}>
                  <button type="button" role="tab" aria-selected={preview} className="dshp-extension__segment" data-active={preview ? 'true' : undefined} onClick={() => setPreview(true)}>{t('skillPreview')}</button>
                  <button type="button" role="tab" aria-selected={!preview} className="dshp-extension__segment" data-active={!preview ? 'true' : undefined} onClick={() => setPreview(false)}>{readOnly ? t('skillPlainText') : t('edit')}</button>
                </div>
              </div>
              {preview ? <div className="dshp-extension__md-preview"><MarkdownPreview text={editor.content} /></div> : <textarea className="dshp-extension__textarea" value={editor.content} readOnly={readOnly} onChange={event => setEditor({ ...editor, content: event.target.value })} />}
            </div>
            {formError && <p className="dshp-extension__form-error">{formError}</p>}
            <div className="dshp-extension__card-row">
              <span className="dshp-extension__spacer" />
              <Button variant="ghost" onClick={() => setEditor(null)}>{readOnly ? t('close') : t('cancel')}</Button>
              {!readOnly && <Button variant="primary" disabled={busy} onClick={() => void doSave()}>{t('save')}</Button>}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={confirmName !== null}
        onClose={() => setConfirmName(null)}
        closeLabel={t('close')}
        title={t('confirmDelete')}
        description={confirmName ?? undefined}
        footer={(
          <>
            <Button variant="ghost" onClick={() => setConfirmName(null)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onClick={() => void doDelete()}>{t('delete')}</Button>
          </>
        )}
      >
        <p>{t('deleteWarn')}</p>
      </Modal>
      <Modal open={importOpen} onClose={() => setImportOpen(false)} closeLabel={t('close')} title={t('importRepositoryTitle')} className="dshp-extension dshp-extension__modal-wide">
        <div className="dshp-extension__form">
          <p className="dshp-extension__intro">{t('importRepositoryHint')}</p>
          <label className="dshp-extension__label">
            <span>{t('repository')}</span>
            <input
              autoFocus
              className="dshp-extension__input"
              placeholder={t('importRepositoryPlaceholder')}
              value={repositoryUrl}
              onChange={event => setRepositoryUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter')
                  void doImport()
              }}
            />
          </label>
          {formError && <p className="dshp-extension__form-error">{formError}</p>}
          <div className="dshp-extension__card-row">
            <span className="dshp-extension__spacer" />
            <Button variant="ghost" disabled={busy} onClick={() => setImportOpen(false)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy || repositoryUrl.trim() === ''} onClick={() => void doImport()}>{t('importRepository')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
