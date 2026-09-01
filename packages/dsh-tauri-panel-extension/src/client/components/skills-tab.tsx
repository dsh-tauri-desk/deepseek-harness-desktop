/**
 * components/skills-tab.tsx — Settings → Plugins “Skills” tab：查看/编辑技能、
 * 导入 GitHub 技能仓库、切换加载策略。
 *
 * 职责拆分：policyTag / normalizeRepository 在 lib/skills.ts，定时器与挂载守卫
 * 在 hooks/use-timers.ts；本组件只保留列表状态与业务编排。
 */

import type { ReactElement } from 'react'
import type { OpenTarget, SkillEditorState, SkillRowView, SkillsTabProps } from '../types'
import { Button, Modal, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useMemo, useState } from 'react'
import { IconGitHub, IconRefresh, IconSkill } from '../components/icons'
import { MarkdownPreview } from '../components/markdown'
import { IMPORT_REFRESH_DELAYS_MS, SKILL_REFRESH_INTERVAL_MS, SKILL_REFRESH_TIMEOUT_MS, SOURCE_LOCALE_KEYS } from '../constants'
import { useTimers } from '../hooks/use-timers'
import { normalizeRepository, policyTag } from '../utils/skills'

export function SkillsTab({ t, injected, createSkill }: SkillsTabProps): ReactElement {
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
    void injected.list().then(
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
  }, [injected, reload, t])

  const refreshUntil = (predicate: (rows: SkillRowView[]) => boolean): void => {
    const deadline = Date.now() + SKILL_REFRESH_TIMEOUT_MS
    const tick = (): void => {
      if (Date.now() > deadline)
        return
      later(() => void injected.list().then((body) => {
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
      const body = await injected.get(skill.name)
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
      await injected.save({ name, description: editor.description, whenToUse: editor.whenToUse.trim() || undefined, modelInvocable: editor.modelInvocable, userInvocable: editor.userInvocable, content: editor.content })
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
      await injected.remove(name)
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
      await injected.policy(skill.name, !enabled)
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
      await injected.open(target)
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
      await injected.importRepository(url)
      setOutcome({ ok: true, text: t('importRepositorySuccess') })
      setImportOpen(false)
      setRepositoryUrl('')
      for (const delay of IMPORT_REFRESH_DELAYS_MS) {
        await new Promise<void>(resolve => later(resolve, delay))
        if (!mounted.current)
          return
        setSkills((await injected.list()).skills)
      }
    }
    catch (error) { setFormError(error instanceof Error ? error.message : String(error)) }
    finally {
      if (mounted.current)
        setBusy(false)
    }
  }

  const needle = query.trim().toLowerCase()
  const filtered = useMemo(() => (skills ?? []).map((skill, index) => ({ skill, index })).filter(({ skill }) => (sourceFilter === 'all' || skill.source === sourceFilter) && (needle === '' || skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle))).sort((a, b) => Number(b.skill.repository !== undefined) - Number(a.skill.repository !== undefined) || a.index - b.index).map(({ skill }) => skill), [needle, skills, sourceFilter])
  const sources = skills === null ? [] : [...new Set(skills.map(skill => skill.source))]
  const readOnly = editor?.mode === 'view'

  return (
    <div className="dpte-section">
      <div className="dpte-head">
        <IconSkill />
        <h3>{t('skillsTitle')}</h3>
        <span className="dpte-spacer" />
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
      <p className="dpte-intro">{t('skillsIntro')}</p>
      {outcome && (
        <div className="dpte-banner" data-kind={outcome.ok ? 'ok' : 'error'} role="status">
          <StateDot state={outcome.ok ? 'done' : 'error'} size={10} />
          <div className="dpte-bannerBody">{outcome.text}</div>
        </div>
      )}
      <div className="dpte-listHead">
        <h3>{t('skillsTab')}</h3>
        {skills && (
          <span className="dpte-count">
            {filtered.length}
            /
            {skills.length}
          </span>
        )}
        <span className="dpte-spacer" />
        <input className="dpte-search" type="search" placeholder={t('searchSkills')} aria-label={t('searchSkills')} value={query} onChange={event => setQuery(event.target.value)} />
        <button type="button" className="dpte-refresh" aria-label={t('refresh')} title={t('refresh')} disabled={busy} onClick={() => setReload(value => value + 1)}><IconRefresh /></button>
      </div>
      {sources.length > 1 && <div className="dpte-chips" role="group" aria-label={t('source')}>{[{ id: 'all', label: t('filterAll') }, ...sources.map(source => ({ id: source, label: t(SOURCE_LOCALE_KEYS[source] ?? 'sourceCustom') }))].map(chip => <button key={chip.id} type="button" className="dpte-chip" data-active={sourceFilter === chip.id ? 'true' : undefined} onClick={() => setSourceFilter(chip.id)}>{chip.label}</button>)}</div>}
      {skills === null && <p className="dpte-empty">{t('loading')}</p>}
      {skills !== null && filtered.length === 0 && <p className="dpte-empty">{skills.length === 0 ? t('emptySkills') : t('noMatch')}</p>}
      {filtered.length > 0 && (
        <ul className="dpte-cards">
          {filtered.map((skill) => {
            const tag = policyTag(skill)
            return (
              <li className="dpte-card" key={`${skill.source}/${skill.name}`}>
                <div className="dpte-cardTop">
                  <strong className="dpte-cardTitle" title={skill.name}>{skill.name}</strong>
                  <span className="dpte-tag" data-kind="source">{t(SOURCE_LOCALE_KEYS[skill.source] ?? 'sourceCustom')}</span>
                  {tag.key && <span className="dpte-tag" data-kind={tag.off ? 'off' : undefined}>{t(tag.key)}</span>}
                </div>
                <p className="dpte-cardDesc" title={skill.description}>{skill.description}</p>
                <div className="dpte-cardRow">
                  {skill.policyEditable && <button type="button" className="dpte-switch" role="switch" aria-checked={skill.invocation.modelInvocable || skill.invocation.userInvocable} aria-label={t('toggleSkill')} title={t('toggleSkillHint')} disabled={busy} onClick={() => void doToggle(skill)}><span className="dpte-switchKnob" /></button>}
                  {skill.dir && <button type="button" className="dpte-link" onClick={() => void doOpen({ target: 'skill', name: skill.name })}>{t('openFolder')}</button>}
                  <span className="dpte-spacer" />
                  {skill.repository?.githubUrl && <a className="dpte-iconLink" href={skill.repository.githubUrl} target="_blank" rel="noreferrer" aria-label={t('githubRepository')} title={t('githubRepository')}><IconGitHub /></a>}
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void openExisting(skill)}>{skill.editable ? t('edit') : t('view')}</Button>
                  {skill.removable && <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirmName(skill.name)}>{t('delete')}</Button>}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <Modal open={editor !== null} onClose={() => setEditor(null)} title={editor?.mode === 'edit' ? t('editSkill') : t('viewSkill')} className="dpte-modalForm" contentClassName="dpte-modalScroll">
        {editor && (
          <div className="dpte-form">
            <label className="dpte-label">
              <span>{t('skillName')}</span>
              <input className="dpte-input" value={editor.name} disabled />
            </label>
            <label className="dpte-label">
              <span>{t('skillDescription')}</span>
              <input className="dpte-input" value={editor.description} disabled={readOnly} onChange={event => setEditor({ ...editor, description: event.target.value })} />
            </label>
            <label className="dpte-label">
              <span>{t('skillWhenToUse')}</span>
              <input className="dpte-input" value={editor.whenToUse} disabled={readOnly} onChange={event => setEditor({ ...editor, whenToUse: event.target.value })} />
            </label>
            <div className="dpte-checks">
              <label>
                <input type="checkbox" checked={editor.modelInvocable} disabled={readOnly} onChange={event => setEditor({ ...editor, modelInvocable: event.target.checked })} />
                {t('modelInvocable')}
              </label>
              <label>
                <input type="checkbox" checked={editor.userInvocable} disabled={readOnly} onChange={event => setEditor({ ...editor, userInvocable: event.target.checked })} />
                {t('userInvocable')}
              </label>
            </div>
            <div className="dpte-label">
              <div className="dpte-cardRow">
                <span>{t('skillContent')}</span>
                <span className="dpte-spacer" />
                <div className="dpte-segments" role="tablist" aria-label={t('skillContent')}>
                  <button type="button" role="tab" aria-selected={preview} className="dpte-segment" data-active={preview ? 'true' : undefined} onClick={() => setPreview(true)}>{t('skillPreview')}</button>
                  <button type="button" role="tab" aria-selected={!preview} className="dpte-segment" data-active={!preview ? 'true' : undefined} onClick={() => setPreview(false)}>{readOnly ? t('skillPlainText') : t('edit')}</button>
                </div>
              </div>
              {preview ? <div className="dpte-mdPreview"><MarkdownPreview text={editor.content} /></div> : <textarea className="dpte-textarea" value={editor.content} readOnly={readOnly} onChange={event => setEditor({ ...editor, content: event.target.value })} />}
            </div>
            {formError && <p className="dpte-formError">{formError}</p>}
            <div className="dpte-cardRow">
              <span className="dpte-spacer" />
              <Button variant="ghost" onClick={() => setEditor(null)}>{readOnly ? t('close') : t('cancel')}</Button>
              {!readOnly && <Button variant="primary" disabled={busy} onClick={() => void doSave()}>{t('save')}</Button>}
            </div>
          </div>
        )}
      </Modal>
      <Modal
        open={confirmName !== null}
        onClose={() => setConfirmName(null)}
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
      <Modal open={importOpen} onClose={() => setImportOpen(false)} title={t('importRepositoryTitle')} className="dpte-modalWide">
        <div className="dpte-form">
          <p className="dpte-intro">{t('importRepositoryHint')}</p>
          <label className="dpte-label">
            <span>{t('repository')}</span>
            <input
              autoFocus
              className="dpte-input"
              placeholder={t('importRepositoryPlaceholder')}
              value={repositoryUrl}
              onChange={event => setRepositoryUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter')
                  void doImport()
              }}
            />
          </label>
          {formError && <p className="dpte-formError">{formError}</p>}
          <div className="dpte-cardRow">
            <span className="dpte-spacer" />
            <Button variant="ghost" disabled={busy} onClick={() => setImportOpen(false)}>{t('cancel')}</Button>
            <Button variant="primary" disabled={busy || repositoryUrl.trim() === ''} onClick={() => void doImport()}>{t('importRepository')}</Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
