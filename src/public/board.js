// 列表页。看板由服务端渲染（/api/board.html），这里只管请求和弹层
const board = $('board')
const sheet = $('sheet')
const batch = $('batch')
const exportSheet = $('export')
const FILE_HINT = $('f-file-name').textContent
const MAX_BYTES = Number($('item-form').dataset.maxBytes)
const ALLOWED_EXT = $('f-file').accept.split(',')
const DEFAULT_ASSIGNEE = { id: Number($('item-form').dataset.defaultAssignee) || null, name: $('item-form').dataset.defaultAssigneeName }
let editing = null // 正在看的条目；null 表示新建
let assignee = { id: null, name: '', text: null } // text 是导入时带来的文字负责人，没绑定平台账号

// ---------- 看板 ----------
let boardSeq = 0
async function loadBoard(search = location.search) {
  const seq = ++boardSeq
  const html = await api('GET', `api/board.html${search}`)
  if (seq !== boardSeq) return // 连点筛选时，只认最后一次
  const focused = document.activeElement?.id
  board.innerHTML = html
  fitTitles()
  if (focused) $(focused)?.focus()
}

function applyFilter(search) {
  history.replaceState(null, '', search || './')
  return loadBoard(search).catch((e) => toast(e.message))
}

board?.addEventListener('click', async (e) => {
  const link = e.target.closest('[data-filter]')
  if (link) {
    e.preventDefault()
    return applyFilter(new URL(link.href ?? link.dataset.href, document.baseURI).search) // 日历格子是 button，地址放在 data-href
  }
  if (!e.target.closest('[data-open]')) return
  try {
    openExisting(await api('GET', `api/items/${e.target.closest('.item').dataset.id}`))
  } catch (err) { toast(err.message) }
})

fitTitles()
let fittedWidth = innerWidth
addEventListener('resize', () => {
  if (innerWidth === fittedWidth) return
  fittedWidth = innerWidth
  requestAnimationFrame(fitTitles)
})

const FILTER_SELECTS = { 'filter-cat': 'cat', 'filter-who': 'who' }

board?.addEventListener('change', (e) => {
  const key = FILTER_SELECTS[e.target.id]
  if (!key) return
  const qs = new URLSearchParams(location.search)
  if (e.target.value) qs.set(key, e.target.value)
  else qs.delete(key)
  const s = qs.toString()
  applyFilter(s ? `?${s}` : '')
})

// ---------- 条目弹层：新建和详情是同一张表单 ----------
function setAssignee(id, name, text = null) {
  assignee = { id, name, text }
  $('f-assign-name').textContent = id ? name : text || '选择负责人'
}

function showAttachment(att) {
  $('att-current').hidden = !att
  if (att) {
    $('att-link').textContent = att.name
    $('att-link').href = att.url
  }
  $('f-file').value = ''
  $('f-file-name').textContent = att ? '换一个文件' : FILE_HINT
}

function setReadOnly(readOnly) {
  for (const el of sheet.querySelectorAll('textarea, input, select')) el.disabled = readOnly
  $('f-assign').disabled = readOnly
  $('att-remove').hidden = readOnly
  $('att-pick').hidden = readOnly
  $('sheet-save').hidden = readOnly
  $('sheet-delete').hidden = readOnly || !editing
  resetDelete()
}

function setHint(text) {
  $('sheet-hint').textContent = text
  $('sheet-hint').hidden = !text
}

// 详情里空的选填项整行不显示。创建人还要能补填，所以折起来而不是去掉
function foldEmpty(t) {
  const empty = { assign: !t.owner, amount: !t.amount, note: !t.note, att: !t.attachment }
  for (const [key, isEmpty] of Object.entries(empty)) sheet.querySelector(`[data-optional="${key}"]`).hidden = isEmpty
  $('sheet-more').hidden = !t.mine || !Object.values(empty).some(Boolean)
}

function unfold() {
  for (const el of sheet.querySelectorAll('[data-optional]')) el.hidden = false
  $('sheet-more').hidden = true
}

function fill(t) {
  $('f-name').value = t.name || ''
  $('f-due').value = t.due_date || ''
  $('f-category').value = t.category || '其他'
  $('f-remind').value = t.remind_days ?? $('f-remind').dataset.default
  $('f-amount').value = t.amount || ''
  $('f-note').value = t.note || ''
  setAssignee(t.assignee_id || null, t.assignee || '', t.owner_name || null)
  showAttachment(t.attachment || null)
}

function openNew() {
  editing = null
  $('sheet-title').textContent = '新建条目'
  $('sheet-save').textContent = '保存'
  setHint('')
  fill({ assignee_id: DEFAULT_ASSIGNEE.id, assignee: DEFAULT_ASSIGNEE.name })
  unfold()
  setReadOnly(false)
  sheet.showModal()
  $('f-name').focus()
}

function openExisting(t) {
  editing = t
  $('sheet-title').textContent = t.mine ? '编辑条目' : '条目详情'
  $('sheet-save').textContent = '保存'
  const source = t.file_name ? `从 ${t.file_name} 导入。` : ''
  setHint(t.mine ? `${source}${t.needs_date ? '还没有到期日，补上之后才会提醒。' : ''}` : `${t.from} 创建，只有创建人能修改`)
  fill(t)
  foldEmpty(t)
  setReadOnly(!t.mine)
  sheet.showModal()
}

function checkFile(file) {
  if (!ALLOWED_EXT.some((ext) => file.name.toLowerCase().endsWith(ext))) return '只支持 PDF、PNG、JPG、WebP、DOCX'
  if (file.size > MAX_BYTES) return '附件不能超过 10MB'
  return ''
}

$('f-file').addEventListener('change', (e) => {
  const file = e.target.files[0]
  if (!file) return
  const problem = checkFile(file)
  if (problem) {
    e.target.value = ''
    return toast(problem)
  }
  $('f-file-name').textContent = file.name
})

const upload = (id, file) => api('PUT', `api/items/${id}/attachment`, undefined, {
  headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name) },
  body: file
})

$('item-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('sheet-save')
  btn.disabled = true
  const file = $('f-file').files[0]
  const fields = {
    name: $('f-name').value,
    due_date: $('f-due').value,
    category: $('f-category').value,
    remind_days: $('f-remind').value,
    amount: $('f-amount').value,
    note: $('f-note').value,
    assignee_id: assignee.id,
    owner_name: assignee.text
  }
  try {
    const saved = editing ? await api('PATCH', `api/items/${editing.id}`, fields) : await api('POST', 'api/items', fields)
    // 条目已经进库了：附件失败时切到编辑态留在弹层里，再点保存只补附件，不会多建一条
    if (file) {
      try {
        await upload(saved.id, file)
      } catch (err) {
        openExisting(saved)
        unfold() // 附件这行要留着，好重新选文件
        $('f-file-name').textContent = FILE_HINT
        await loadBoard().catch(() => {})
        return toast(`条目已保存，附件没传上：${err.message}`)
      }
    }
    sheet.close()
    await loadBoard()
  } catch (err) {
    toast(err.message)
  } finally {
    btn.disabled = false
  }
})

$('att-remove').addEventListener('click', async () => {
  try {
    await api('DELETE', `api/items/${editing.id}/attachment`)
    editing.attachment = null
    showAttachment(null)
    await loadBoard()
  } catch (err) { toast(err.message) }
})

// 删除要点两次：不用 confirm()，内置浏览器里常被拦
let deleteArmed = false
function resetDelete() {
  deleteArmed = false
  $('sheet-delete').textContent = '删除'
}

$('sheet-delete').addEventListener('click', async () => {
  if (!deleteArmed) {
    deleteArmed = true
    $('sheet-delete').textContent = '再点一次确认'
    return
  }
  try {
    await api('DELETE', `api/items/${editing.id}`)
    sheet.close()
    await loadBoard()
  } catch (err) { toast(err.message) }
})

$('sheet-more').addEventListener('click', unfold)
$('open-new')?.addEventListener('click', openNew)
$('f-assign').addEventListener('click', () => pickPerson(assignee.id, (id, name) => setAssignee(id, name)))

// ---------- 导出 ----------
function exportHref() {
  const form = new FormData($('export-form'))
  const qs = new URLSearchParams(form.get('scope') === 'all' ? '' : location.search)
  qs.set('scope', form.get('scope'))
  qs.set('format', form.get('format'))
  return `export?${qs}`
}

$('open-export')?.addEventListener('click', () => {
  $('export-go').href = exportHref()
  exportSheet.showModal()
})
$('export-form').addEventListener('change', () => { $('export-go').href = exportHref() })
$('export-go').addEventListener('click', () => {
  $('export-go').href = exportHref() // 切换后立刻点也要是新地址
  setTimeout(() => exportSheet.close(), 0)
})

// ---------- 批量录入 ----------
let parsed = null // 解析过的内容；改了文本就要重新解析

function resetBatchResult() {
  parsed = null
  $('batch-result').hidden = true
  $('batch-go').textContent = '解析预览'
}

function openBatch() {
  $('batch-text').value = ''
  resetBatchResult()
  batch.showModal()
  $('batch-text').focus()
}

function showBatch({ rows, errors }) {
  $('batch-result').hidden = false
  $('batch-summary').textContent = `能录入 ${rows.length} 行${errors.length ? `，${errors.length} 行有问题（不影响其他行）` : ''}`
  $('batch-bad').replaceChildren(...errors.map((x) => {
    const li = document.createElement('li')
    li.textContent = `第 ${x.line} 行：${x.reason}`
    const raw = document.createElement('span')
    raw.className = 'raw'
    raw.textContent = x.raw
    li.append(raw)
    return li
  }))
  $('batch-good').replaceChildren(...rows.map((x) => {
    const li = document.createElement('li')
    for (const [text, cls] of [[x.name, 'n'], [x.due_date, ''], [x.category, '']]) {
      const s = document.createElement('span')
      s.className = cls
      s.textContent = text
      li.append(s)
    }
    return li
  }))
}

$('batch-text').addEventListener('input', resetBatchResult)

$('batch-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const btn = $('batch-go')
  const text = $('batch-text').value
  if (!text.trim()) return $('batch-text').focus()
  btn.disabled = true
  try {
    if (parsed === null) {
      const out = await api('POST', 'api/batch/preview', { text })
      showBatch(out)
      if (out.rows.length) {
        parsed = text
        btn.textContent = `提交 ${out.rows.length} 条`
      }
      return
    }
    const { created, errors } = await api('POST', 'api/batch', { text: parsed })
    batch.close()
    await loadBoard()
    toast(`已录入 ${created} 条${errors.length ? `，${errors.length} 行没录入` : ''}`)
  } catch (err) {
    toast(err.message)
  } finally {
    btn.disabled = false
  }
})

// ---------- 从导入页跳回来 ----------
const landing = new URLSearchParams(location.search)
if (landing.has('new') || landing.has('batch') || landing.has('imported')) {
  if (landing.has('new')) openNew()
  if (landing.has('batch')) openBatch()
  if (landing.has('imported')) toast(`已导入 ${Number(landing.get('imported'))} 条`)
  history.replaceState(null, '', './')
}
