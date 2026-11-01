// 导入页：上传或粘贴 → AI 识别成预览 → 逐条确认 → 入库。
// 状态只有一份 rows，输入框改了就写回 rows，界面不反过来读 DOM。存 sessionStorage，确认到一半刷新不丢
const FILE_MAX = 10 * 1024 * 1024
const FILES_MAX = 5
const STORE_KEY = 'expiry-import'
const NAME_MAX = 14
const fileInput = $('file-input')
const drop = $('drop')
const results = $('results')
const rowsEl = $('rows')
const CATEGORIES = JSON.parse(rowsEl.dataset.categories)
const REMIND_DEFAULT = Number(rowsEl.dataset.remindDefault)
const DEFAULT_OWNER = rowsEl.dataset.defaultOwner

let rows = [] // { key, selected, open, file_name, name, category, expire_at, date_inferred, remind_days, owner, amount, note, bad }
let nextKey = 1

const save = () => sessionStorage.setItem(STORE_KEY, JSON.stringify(rows))

/** 默认只展开第一张。一张都没展开时（刚识别完、展开的那张被删了）补回第一张 */
const openFirst = () => {
  if (rows.length && !rows.some((r) => r.open)) rows[0].open = true
}

function load() {
  try {
    rows = JSON.parse(sessionStorage.getItem(STORE_KEY)) ?? []
    nextKey = rows.reduce((max, r) => Math.max(max, r.key + 1), 1)
    openFirst()
  } catch {
    rows = []
  }
}

function addRows(out) {
  for (const item of out.items) {
    rows.push({ key: nextKey++, selected: true, open: false, file_name: out.file_name, ...item, expire_at: item.expire_at ?? '', owner: item.owner ?? '', amount: item.amount ?? '', note: item.note ?? '', bad: '' })
  }
  openFirst()
  save()
}

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

const message = (text, bad = false) => el('li', { className: `result-msg${bad ? ' bad' : ''}`, textContent: text })

// ---------- 逐条确认 ----------
function field(label, control, wide = false) {
  return el('label', { className: `yh-field${wide ? ' wide-field' : ''}` }, el('span', { className: 'yh-label', textContent: label }), control)
}

function input(row, name, props = {}) {
  const node = el('input', { value: row[name] ?? '', autocomplete: 'off', ...props })
  node.dataset.field = name
  return node
}

function categorySelect(row) {
  const select = el('select', {}, ...CATEGORIES.map((c) => el('option', { value: c, textContent: c })))
  select.value = row.category
  select.dataset.field = 'category'
  return el('span', { className: 'yh-select' }, select)
}

const CALENDAR_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/></svg>'

/** 显示和输入都是 YYYY-MM-DD 的文本框。原生日期框只当选择器用，状态还在文本框这边 */
function dateInput(row) {
  const native = el('input', { type: 'date', value: row.expire_at, ariaLabel: '打开日历' })
  const pick = el('span', { className: 'date-pick', innerHTML: CALENDAR_ICON })
  pick.append(native)
  return el('span', { className: 'date-input' }, input(row, 'expire_at', { type: 'text', maxLength: 10, placeholder: 'YYYY-MM-DD' }), pick)
}

function rowTags(row) {
  const tags = []
  if (!row.expire_at) tags.push(['needs', '缺到期日，可以先导入，补上之前不会提醒'])
  else if (row.date_inferred) tags.push(['check', '日期是推算的，请核对'])
  if (row.file_name) tags.push(['', row.file_name])
  return tags.map(([cls, text]) => el('span', { className: `yh-tag${cls ? ` tag-${cls}` : ''}`, textContent: text, title: text }))
}

function button(text, attr, props = {}) {
  const node = el('button', { className: 'yh-btn yh-btn--text', type: 'button', textContent: text, ...props })
  node.dataset[attr] = ''
  return node
}

/** 折叠行的名称：按字符截断，切完落在左括号上的话把括号也去掉，不留 `甲（…` */
function shortName(name) {
  const chars = [...name]
  if (chars.length <= NAME_MAX) return name
  return `${chars.slice(0, NAME_MAX).join('').replace(/[\s（(【[《「『]+$/, '')}…`
}

function showSummary(li, row) {
  const name = li.querySelector('.summary-name')
  name.textContent = shortName(row.name) || '未命名'
  name.title = row.name
  li.querySelector('.summary-rest').textContent = `${row.category} · ${row.expire_at || '缺日期'}`
  li.querySelector('.row-title').textContent = row.name
}

function renderRow(row) {
  const check = el('input', { type: 'checkbox', checked: row.selected })
  check.dataset.field = 'selected'
  check.setAttribute('aria-label', '导入这条')
  const remove = button('×', 'remove', { className: 'icon', ariaLabel: '删除这条' })
  const toggle = button(row.open ? '收起' : '展开', 'toggle')
  toggle.setAttribute('aria-expanded', row.open)
  const li = el('li', { className: `yh-card confirm-row${row.open ? '' : ' folded'}${row.selected ? '' : ' off'}${row.bad ? ' bad' : ''}` },
    el('div', { className: 'confirm-head' },
      el('label', { className: 'check' }, check, el('i')),
      el('div', { className: 'confirm-summary' }, el('span', { className: 'summary-name' }), ' · ', el('span', { className: 'summary-rest' })), // 分隔符放在外面：窄屏只在这里换行，日期不会被省略号吃掉
      el('h3', { className: 'row-title', hidden: !row.name }),
      input(row, 'name', { className: 'yh-input confirm-name', maxLength: 200, ariaLabel: '名称', placeholder: '名称', hidden: !!row.name }),
      el('div', { className: 'confirm-tools' }, button('改名', 'rename'), toggle, remove)),
    el('div', { className: 'confirm-body' },
      el('div', { className: 'confirm-tags' }, ...rowTags(row)),
      el('div', { className: 'confirm-grid' },
        field('分类', categorySelect(row)),
        field('到期日', dateInput(row)),
        field('提前提醒天数', input(row, 'remind_days', { type: 'text', inputMode: 'numeric', maxLength: 4 })),
        field('负责人（可空）', input(row, 'owner', { type: 'text', maxLength: 50, placeholder: DEFAULT_OWNER ? `默认：${DEFAULT_OWNER}` : '' })),
        field('金额（可空）', input(row, 'amount', { type: 'text', inputMode: 'decimal', maxLength: 20, placeholder: '240000' })),
        field('备注（可空）', input(row, 'note', { type: 'text', maxLength: 60 }), true)),
      el('p', { className: 'yh-field-error', textContent: row.bad, hidden: !row.bad })))
  li.dataset.key = row.key
  showSummary(li, row)
  return li
}

function showCount() {
  const n = rows.filter((r) => r.selected).length
  $('commit').textContent = `导入 ${n} 条`
  $('commit').disabled = !n
  $('import-sub').textContent = `识别出 ${rows.length} 条，每条都能改、能删、能取消勾选，确认后才入库。`
}

function showStep() {
  const confirming = rows.length > 0
  $('step-upload').hidden = confirming
  $('step-confirm').hidden = !confirming
  if (!confirming) $('import-sub').textContent = '上传文件或粘贴文字，AI 抽出到期条目，你确认后才入库。'
}

function renderRows() {
  rowsEl.replaceChildren(...rows.map(renderRow))
  showCount()
  showStep()
}

const rowOf = (node) => rows.find((r) => r.key === Number(node.closest('.confirm-row').dataset.key))

rowsEl.addEventListener('input', (e) => {
  if (e.target.closest('.date-pick')) { // 日历里选的日期写回文本框，走下面同一条路
    const text = e.target.closest('.date-input').querySelector('[data-field]')
    text.value = e.target.value
    return text.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const name = e.target.dataset.field
  if (!name) return
  const row = rowOf(e.target)
  row[name] = e.target.type === 'checkbox' ? e.target.checked : e.target.value
  row.bad = ''
  const li = e.target.closest('.confirm-row')
  li.classList.toggle('off', !row.selected)
  li.classList.remove('bad')
  li.querySelector('.yh-field-error').hidden = true
  if (name === 'expire_at') {
    row.date_inferred = false // 人改过的日期不用再核对
    li.querySelector('.confirm-tags').replaceChildren(...rowTags(row))
    li.querySelector('.date-pick input').value = row.expire_at // 不是完整日期时原生框自己清空
  }
  showSummary(li, row)
  save()
  showCount()
})

function setRenaming(li, on) {
  const name = li.querySelector('.confirm-name')
  li.querySelector('.row-title').hidden = on
  name.hidden = !on
  if (on) name.select()
}

function toggleRow(li) {
  const row = rowOf(li)
  const toggle = li.querySelector('[data-toggle]')
  row.open = !row.open
  li.classList.toggle('folded', !row.open)
  toggle.textContent = row.open ? '收起' : '展开'
  toggle.setAttribute('aria-expanded', row.open)
  save()
}

/** 折叠时整张卡都能点，展开时是标题这一行；勾选框、改名、删除这些控件各管各的 */
const isRowClick = (target, li) => !target.closest('label, input, button') && (li.classList.contains('folded') || !!target.closest('.confirm-head'))

rowsEl.addEventListener('click', (e) => {
  const li = e.target.closest('.confirm-row')
  if (!li) return
  if (e.target.closest('[data-rename]')) return setRenaming(li, true)
  if (e.target.closest('[data-toggle]') || isRowClick(e.target, li)) return toggleRow(li)
  if (!e.target.closest('[data-remove]')) return
  const row = rowOf(li)
  rows = rows.filter((r) => r !== row)
  openFirst()
  save()
  renderRows()
})

rowsEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('confirm-name')) e.target.blur()
})
rowsEl.addEventListener('focusout', (e) => { // 名称留空时不收回去，标题没东西可显示
  if (e.target.classList.contains('confirm-name') && e.target.value.trim()) setRenaming(e.target.closest('.confirm-row'), false)
})

$('add-more').addEventListener('click', () => {
  $('step-upload').hidden = false
  $('step-confirm').hidden = true
  $('back-confirm').hidden = false // 继续添加时识别失败，不能把人困在上传步
})
$('back-confirm').addEventListener('click', () => {
  $('back-confirm').hidden = true
  renderRows()
})

/** 只提交勾选的行。key 不发给服务端；服务端报第几条，按提交的顺序对回这一行 */
$('commit').addEventListener('click', async () => {
  const chosen = rows.filter((r) => r.selected)
  const items = chosen.map(({ file_name, name, category, expire_at, remind_days, owner, amount, note }) => ({ file_name, name, category, expire_at, remind_days, owner, amount, note }))
  const btn = $('commit')
  btn.disabled = true
  try {
    const { created } = await api('POST', 'api/import/commit', { items })
    sessionStorage.removeItem(STORE_KEY)
    location.href = `./?imported=${created}`
  } catch (err) {
    btn.disabled = false
    const row = chosen[err.index]
    if (!row) return toast(err.message)
    row.bad = err.message
    row.open = true // 折着的话看不到错在哪
    renderRows()
    rowsEl.querySelector(`[data-key="${row.key}"]`).scrollIntoView({ block: 'center' })
  }
})

// ---------- 识别 ----------
function showFailure(text) {
  $('degrade').hidden = false
  $('degrade-text').textContent = text
}

/** 识别完的统一出口：有条目进确认步，一条没有或模型失败就留在这里，给手动录入的入口 */
function receive(out, label) {
  for (const n of out.notices) $('confirm-notices').append(message(`${label}：${n}`))
  if (!out.ok) return showFailure(out.message)
  if (!out.items.length) return showFailure(`${label}里没识别出到期条目，可以手动录入。`)
  addRows(out)
  renderRows()
}

async function withBusy(fn) {
  $('busy').hidden = false
  $('degrade').hidden = true
  try {
    await fn()
  } finally {
    $('busy').hidden = true
  }
}

/** 只有服务端判不了的放这里：超过 10MB 的不用白传一遍。格式提示以服务端为准，页面和接口说同一句话 */
async function sendFile(file) {
  if (file.size > FILE_MAX) return results.append(message(`${file.name}：单个文件不能超过 10MB`, true))
  try {
    receive(await api('POST', `api/import/file?name=${encodeURIComponent(file.name)}`, undefined, { body: file, headers: { 'Content-Type': 'application/octet-stream' } }), file.name)
  } catch (err) {
    results.append(message(`${file.name}：${err.message}`, true))
  }
}

async function takeFiles(list) {
  const files = [...list]
  results.replaceChildren()
  if (files.length > FILES_MAX) toast(`一次最多 ${FILES_MAX} 个文件，后面 ${files.length - FILES_MAX} 个没有导入`)
  await withBusy(async () => {
    for (const f of files.slice(0, FILES_MAX)) await sendFile(f)
  })
  fileInput.value = ''
}

fileInput.addEventListener('change', () => takeFiles(fileInput.files))

for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => { e.preventDefault(); drop.classList.add('over') })
}
drop.addEventListener('dragleave', () => drop.classList.remove('over'))
drop.addEventListener('drop', (e) => {
  e.preventDefault()
  drop.classList.remove('over')
  takeFiles(e.dataTransfer.files)
})

$('paste-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  const text = $('paste-text').value
  if (!text.trim()) return toast('先粘贴合同或证照信息')
  const btn = $('paste-btn')
  btn.disabled = true
  results.replaceChildren()
  await withBusy(async () => {
    try {
      receive(await api('POST', 'api/import/text', { text }), '粘贴的文字')
      $('paste-text').value = ''
    } catch (err) {
      results.append(message(err.message, true))
    }
  })
  btn.disabled = false
})

load()
renderRows()
