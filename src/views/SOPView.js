import { supabase } from '../lib/supabase.js'
import { getAllSkills } from '../lib/skills.js'

const KNOWN_TREATMENT_IDS = new Set(['shellac', 'gel', 'dual_form', 'manikuere', 'pediküre', 'ibx'])
const isStudioCat = cat => !!cat && !KNOWN_TREATMENT_IDS.has(cat) && cat === cat.toUpperCase()

export function SOPView({ user }) {
  const isManager = user?.profile?.is_manager
  let sops        = []
  let categories  = []
  let selectedSop = null
  let activeGroup = 'treatments'
  let filterSkill = 'all'
  let showForm    = false
  let editSop     = null
  let container   = null

  async function loadSOPs() {
    const { data, error } = await supabase
      .from('sops')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) console.error('sops SELECT fehlgeschlagen:', error)
    sops       = data ?? []
    categories = [...new Set(sops.map(s => s.associated_skill).filter(Boolean))].sort()
  }

  async function saveSop(formData) {
    const rawSkill = (formData.associated_skill || '').trim()
    const skill    = formData.sop_group === 'studio'
      ? rawSkill.toUpperCase()
      : rawSkill.toLowerCase()

    const payload = {
      title:            formData.title,
      content:          formData.content,
      video_url:        formData.video_url || null,
      pdf_link:         formData.file_url  || null,
      associated_skill: skill || null,
    }

    if (editSop) {
      const { error } = await supabase.from('sops').update(payload).eq('id', editSop.id)
      if (error) { console.error('sops UPDATE fehlgeschlagen:', error); throw error }
    } else {
      const { error } = await supabase.from('sops').insert(payload)
      if (error) { console.error('sops INSERT fehlgeschlagen:', error); throw error }
    }
  }

  async function deleteSop(id) {
    const { error } = await supabase.from('sops').delete().eq('id', id)
    if (error) { console.error('sops DELETE fehlgeschlagen:', error); throw error }
  }

  function filteredSOPs() {
    const byGroup = sops.filter(s =>
      activeGroup === 'studio' ? isStudioCat(s.associated_skill) : !isStudioCat(s.associated_skill)
    )
    if (filterSkill === 'all') return byGroup
    return byGroup.filter(s => s.associated_skill === filterSkill)
  }

  function getYoutubeEmbed(url) {
    if (!url) return null
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/))([A-Za-z0-9_-]{11})/)
    if (match) return `https://www.youtube.com/embed/${match[1]}`
    const vimeo = url.match(/vimeo\.com\/(\d+)/)
    if (vimeo) return `https://player.vimeo.com/video/${vimeo[1]}`
    return null
  }

  function renderMarkdown(text) {
    if (!text) return ''
    return text
      .replace(/^## (.+)$/gm, '<h3 class="sop-h3">$1</h3>')
      .replace(/^### (.+)$/gm, '<h4 class="sop-h4">$1</h4>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/^- (.+)$/gm, '<li>$1</li>')
      .replace(/(<li>.*<\/li>\n?)+/g, s => `<ul class="sop-list">${s}</ul>`)
      .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
      .replace(/\n\n/g, '</p><p>')
      .replace(/^(?!<[hul])/gm, '')
      .replace(/\n/g, '<br>')
  }

  function buildSkillFilter() {
    const subCats = categories.filter(cat =>
      activeGroup === 'studio' ? isStudioCat(cat) : !isStudioCat(cat)
    )
    const knownSkills = getAllSkills()

    return `
      <div class="sop-nav">
        <div class="sop-group-tabs">
          <button class="sop-group-tab ${activeGroup === 'treatments' ? 'active' : ''}" data-group="treatments">
            Behandlungen
          </button>
          <button class="sop-group-tab ${activeGroup === 'studio' ? 'active' : ''}" data-group="studio">
            Studio Standards
          </button>
        </div>

        <div class="sop-sub-toolbar">
          <button class="skill-filter-tab ${filterSkill === 'all' ? 'active' : ''}" data-skill="all">Alle</button>
          ${subCats.map(cat => {
            const skill = knownSkills.find(s => s.id === cat)
            return `
              <button class="skill-filter-tab ${filterSkill === cat ? 'active' : ''}" data-skill="${cat}">
                ${skill?.label || cat}
              </button>
            `
          }).join('')}
        </div>
      </div>
    `
  }

  function buildSOPCard(sop) {
    const skill      = getAllSkills().find(s => s.id === sop.associated_skill)
    const skillLabel = skill?.label || sop.associated_skill || ''
    return `
      <div class="sop-card" data-id="${sop.id}" style="position:relative;border-left:3px solid ${skill?.color || 'var(--cream-dark)'};padding-top:${isManager ? '28px' : ''}">
        ${isManager ? `
          <button class="btn-delete-sop" data-id="${sop.id}"
            style="position:absolute;top:8px;right:8px;width:24px;height:24px;border-radius:50%;border:1px solid var(--terracotta);color:var(--terracotta);background:transparent;cursor:pointer;font-size:0.7rem;line-height:1;display:flex;align-items:center;justify-content:center;padding:0">
            ✕
          </button>
          <button class="btn btn-sm btn-ghost btn-edit-sop" data-id="${sop.id}"
            style="position:absolute;top:6px;right:40px;font-size:0.7rem;padding:2px 8px">
            Bearbeiten
          </button>
        ` : ''}
        <h4 style="color:var(--aubergine);margin-bottom:4px">${sop.title}</h4>
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:8px">
          ${skillLabel ? `<span class="badge badge-neutral">${skillLabel}</span>` : ''}
          ${sop.video_url ? '<span class="badge badge-terracotta">▶ Video</span>' : ''}
          ${sop.pdf_link  ? `<a href="${sop.pdf_link}" target="_blank" rel="noopener" class="badge badge-gold" onclick="event.stopPropagation()">↓ PDF</a>` : ''}
        </div>
        <p style="font-size:0.8rem;color:var(--text-light)">
          ${sop.content ? sop.content.replace(/[#*\n]/g, ' ').substring(0, 120) + '…' : 'Kein Inhalt'}
        </p>
        <p style="font-size:0.72rem;color:var(--text-light);margin-top:8px">
          Aktualisiert: ${sop.created_at ? new Date(sop.created_at).toLocaleDateString('de-DE') : '–'}
        </p>
      </div>
    `
  }

  function buildSOPDetail(sop) {
    const skill      = getAllSkills().find(s => s.id === sop.associated_skill)
    const skillLabel = skill?.label || sop.associated_skill || ''
    const skillColor = skill?.color || 'var(--aubergine)'
    const embedUrl   = getYoutubeEmbed(sop.video_url)

    return `
      <button class="btn btn-ghost btn-sm" id="back-to-sops" style="margin-bottom:20px">← Zurück</button>

      <div class="card">
        <div class="card-header">
          <div>
            <h2 style="color:var(--aubergine)">${sop.title}</h2>
            <div style="display:flex;gap:8px;margin-top:6px">
              ${skillLabel ? `<span class="badge" style="background:${skillColor};color:#fff">${skillLabel}</span>` : ''}
              <span style="font-size:0.75rem;color:var(--text-light)">
                Aktualisiert ${sop.created_at ? new Date(sop.created_at).toLocaleDateString('de-DE') : '–'}
              </span>
            </div>
          </div>
          ${isManager ? `
            <button class="btn btn-ghost btn-sm btn-edit-sop" data-id="${sop.id}">Bearbeiten</button>
          ` : ''}
        </div>

        ${embedUrl ? `
          <div style="margin-bottom:24px;border-radius:var(--radius-md);overflow:hidden;aspect-ratio:16/9">
            <iframe src="${embedUrl}" width="100%" height="100%"
              frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
              allowfullscreen style="display:block"></iframe>
          </div>
        ` : ''}

        ${sop.content ? `
          <div class="sop-content">
            <p>${renderMarkdown(sop.content)}</p>
          </div>
        ` : ''}

        ${sop.pdf_link ? `
          <div style="margin-top:20px;padding-top:20px;border-top:1px solid var(--cream-dark)">
            <a href="${sop.pdf_link}" target="_blank" rel="noopener" class="btn btn-ghost">
              ↓ PDF herunterladen
            </a>
          </div>
        ` : ''}
      </div>
    `
  }

  function buildForm() {
    const allSkills = getAllSkills()
    const s = editSop ?? {}

    const datalistOptions = [
      ...allSkills.map(sk => sk.id),
      ...categories.filter(cat => !allSkills.find(sk => sk.id === cat)),
    ]

    return `
      <div class="card" style="margin-bottom:24px">
        <div class="card-header">
          <h4>${editSop ? 'SOP bearbeiten' : 'Neue SOP erstellen'}</h4>
          <button class="btn btn-ghost btn-sm" id="cancel-sop-form">Abbrechen</button>
        </div>
        <div id="sop-form-error" class="login-error" style="display:none"></div>
        <form id="sop-form">
          <div class="form-group">
            <label class="form-label">Titel</label>
            <input class="form-input" name="title" value="${s.title || ''}" required placeholder="z.B. Shellac – Standardablauf" />
          </div>
          <div class="form-group">
            <label class="form-label">Gruppe</label>
            <div style="display:flex;gap:16px;margin-top:4px">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="radio" name="sop_group" value="treatments" ${!isStudioCat(s.associated_skill) ? 'checked' : ''} />
                Behandlungen
              </label>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer">
                <input type="radio" name="sop_group" value="studio" ${isStudioCat(s.associated_skill) ? 'checked' : ''} />
                Studio Standards
              </label>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">Kategorie / Skill</label>
            <input class="form-input" name="associated_skill" list="skill-options"
              value="${s.associated_skill || ''}"
              placeholder="z.B. shellac oder NEUE-KATEGORIE" />
            <datalist id="skill-options">
              ${datalistOptions.map(id => {
                const sk = allSkills.find(s => s.id === id)
                return `<option value="${id}">${sk ? sk.label : id}</option>`
              }).join('')}
            </datalist>
            <p style="font-size:0.72rem;color:var(--text-light);margin-top:4px">
              Studio-Kategorien werden automatisch in Großbuchstaben gespeichert.
            </p>
          </div>
          <div class="form-group">
            <label class="form-label">Inhalt (Markdown)</label>
            <textarea class="form-textarea" name="content" style="min-height:160px"
              placeholder="## Ablauf&#10;&#10;1. Schritt eins&#10;2. Schritt zwei">${s.content || ''}</textarea>
          </div>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label">Video-URL (YouTube / Vimeo)</label>
              <input class="form-input" name="video_url" value="${s.video_url || ''}" placeholder="https://youtube.com/watch?v=…" />
            </div>
            <div class="form-group" style="margin-bottom:0">
              <label class="form-label">PDF-Link</label>
              <input class="form-input" name="file_url" value="${s.pdf_link || ''}" placeholder="https://…/anleitung.pdf" />
            </div>
          </div>
          <div style="display:flex;justify-content:flex-end;gap:10px;margin-top:20px">
            <button type="submit" class="btn btn-primary" id="sop-submit-btn">
              ${editSop ? 'Speichern' : 'SOP erstellen'}
            </button>
          </div>
        </form>
      </div>
    `
  }

  function buildHTML() {
    if (selectedSop) return buildSOPDetail(selectedSop)

    return `
      <div class="page-header" style="display:flex;justify-content:space-between;align-items:flex-start">
        <div>
          <h2>Wissensdatenbank</h2>
          <p style="color:var(--text-light);font-size:0.875rem">SOPs, Anleitungen & Schulungsvideos</p>
        </div>
        ${isManager ? `<button class="btn btn-accent" id="new-sop-btn">+ Neue SOP</button>` : ''}
      </div>

      ${showForm ? buildForm() : ''}
      ${buildSkillFilter()}

      <div id="sop-list" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:20px;margin-top:4px">
        ${filteredSOPs().length
          ? filteredSOPs().map(buildSOPCard).join('')
          : `<div class="empty-state" style="grid-column:1/-1">
               <span class="empty-state-icon">◎</span>
               <p>Keine SOPs in dieser Kategorie.</p>
             </div>`
        }
      </div>
    `
  }

  function rerender() {
    if (!container) return
    container.innerHTML = buildHTML()
    attachEvents()
  }

  function attachEvents() {
    container.querySelector('#new-sop-btn')?.addEventListener('click', () => {
      showForm = true; editSop = null; rerender()
    })

    container.querySelector('#cancel-sop-form')?.addEventListener('click', () => {
      showForm = false; editSop = null; rerender()
    })

    container.querySelector('#back-to-sops')?.addEventListener('click', () => {
      selectedSop = null; rerender()
    })

    container.querySelectorAll('[data-group]').forEach(btn => {
      btn.addEventListener('click', () => {
        activeGroup = btn.dataset.group
        filterSkill = 'all'
        rerender()
      })
    })

    container.querySelectorAll('[data-skill]').forEach(btn => {
      btn.addEventListener('click', () => { filterSkill = btn.dataset.skill; rerender() })
    })

    container.querySelectorAll('.sop-card').forEach(card => {
      card.addEventListener('click', e => {
        if (e.target.closest('button')) return
        const id = card.dataset.id
        selectedSop = sops.find(s => s.id === id) ?? null
        rerender()
      })
    })

    container.querySelectorAll('.btn-edit-sop').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation()
        editSop = sops.find(s => s.id === btn.dataset.id) ?? null
        showForm = true
        selectedSop = null
        rerender()
      })
    })

    container.querySelectorAll('.btn-delete-sop').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation()
        if (!confirm('Möchtest du diese SOP wirklich löschen?')) return
        const id = btn.dataset.id
        sops = sops.filter(s => s.id !== id)
        rerender()
        try {
          await supabase.from('sops').delete().eq('id', id)
        } catch (err) {
          alert('Fehler beim Löschen: ' + err.message)
          await loadSOPs()
          rerender()
        }
      })
    })

    container.querySelector('#sop-form')?.addEventListener('submit', async e => {
      e.preventDefault()
      const btn     = container.querySelector('#sop-submit-btn')
      const errorEl = container.querySelector('#sop-form-error')
      btn.disabled  = true
      btn.textContent = 'Speichern…'
      errorEl.style.display = 'none'

      try {
        await saveSop(Object.fromEntries(new FormData(e.target)))
        showForm = false; editSop = null
        await loadSOPs()
        rerender()
      } catch (err) {
        errorEl.textContent = 'Fehler: ' + err.message
        errorEl.style.display = 'block'
        btn.disabled = false
        btn.textContent = editSop ? 'Speichern' : 'SOP erstellen'
      }
    })
  }

  async function render() {
    const el = document.createElement('div')
    el.className = 'main-content'
    el.innerHTML = '<div class="loader"><div class="spinner"></div></div>'
    container = el

    await loadSOPs()
    el.innerHTML = buildHTML()
    attachEvents()

    return el
  }

  return { render }
}
