// 公用交互：请求、提示、确认、顶栏菜单、选人。每页自己的逻辑在 board.js、import.js、settings.js。地址全用相对路径，配合 <base> 挂在 /apps/expiry/ 下
const $ = (id) => document.getElementById(id)
const picker = $('picker')
let toastTimer

async function api(method, url, body, extra = {}) {
  const r = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    ...extra // 上传文件时 extra 带自己的 body 和 headers
  }).catch(() => { throw new Error('网络不太好，稍后再试') })
  // 登录过期：刷新页面，由服务端重新走授权
  if (r.status === 401) { location.reload(); throw new Error('登录已过期') }
  const isJson = (r.headers.get('content-type') || '').includes('json')
  if (!r.ok) {
    const out = isJson ? await r.json() : {}
    throw Object.assign(new Error(out.error || '网络不太好，稍后再试'), { index: out.index })
  }
  if (r.status === 204) return null
  return isJson ? r.json() : r.text()
}

function toast(text) {
  const el = $('toast')
  // 模态 dialog 在顶层，提示放在外面会被盖住，要挪进最上面那层
  const dialogs = document.querySelectorAll('dialog[open]')
  ;(dialogs[dialogs.length - 1] || document.body).append(el)
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { el.hidden = true }, 2400)
}

/** 二次确认。原生 confirm 在钉钉、微信内置浏览器里不一定弹，用自己的弹层 */
function ask({ title, text, yes, danger = false }) {
  const d = $('confirm')
  $('confirm-title').textContent = title
  $('confirm-text').textContent = text
  $('confirm-yes').textContent = yes
  $('confirm-yes').classList.toggle('yh-btn--danger', danger)
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'yes'), { once: true })
    d.returnValue = ''
    d.showModal()
  })
}
$('confirm-no').addEventListener('click', () => $('confirm').close('no'))
$('confirm-yes').addEventListener('click', () => $('confirm').close('yes'))

// ---------- 顶栏菜单、重试 ----------
const menu = $('user-menu')
document.addEventListener('click', (e) => {
  if (menu.open && !menu.contains(e.target)) menu.open = false
  if (e.target.closest('[data-reload]')) location.reload()
})
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menu.open = false })

// ---------- 弹层 ----------
for (const d of document.querySelectorAll('dialog.yh-sheet')) {
  d.querySelector('[data-close]')?.addEventListener('click', () => d.close())
  // 点遮罩关闭（桌面）
  d.addEventListener('click', (e) => { if (e.target === d) d.close() })
}

// 键盘弹起时可视区变矮，弹层跟着变矮，底部主按钮留在键盘上方
if (window.visualViewport) {
  const sync = () => document.documentElement.style.setProperty('--vvh', `${window.visualViewport.height}px`)
  window.visualViewport.addEventListener('resize', sync)
  sync()
}

// ---------- 选人 ----------
let searchTimer
let pickedId = null
let onPicked = () => {}

async function loadPeople(q) {
  const msg = $('picker-msg')
  const ul = $('picker-list')
  try {
    const { list, total } = await api('GET', `api/users?q=${encodeURIComponent(q)}`)
    ul.replaceChildren(...list.map((u) => {
      const li = document.createElement('li')
      const b = document.createElement('button')
      b.type = 'button'
      b.dataset.id = u.id
      if (u.id === pickedId) b.setAttribute('aria-current', 'true')
      const name = document.createElement('span')
      name.textContent = u.name
      const dept = document.createElement('span')
      dept.className = 'dept'
      dept.textContent = u.dept || ''
      b.append(name, dept)
      li.append(b)
      return li
    }))
    msg.hidden = list.length > 0 && total <= list.length
    msg.textContent = list.length ? `共 ${total} 人，搜一下更快` : '没有找到这个人'
  } catch (e) {
    ul.replaceChildren()
    msg.textContent = e.message
    msg.hidden = false
  }
}

/** 打开选人弹层。done(id, name)，「不指定」时 id 是 null */
function pickPerson(current, done) {
  pickedId = current
  onPicked = done
  $('picker-q').value = ''
  $('picker-list').replaceChildren()
  $('picker-msg').hidden = true
  picker.showModal()
  loadPeople('')
}

if (picker) {
  $('picker-q').addEventListener('input', (e) => {
    clearTimeout(searchTimer)
    searchTimer = setTimeout(() => loadPeople(e.target.value), 200)
  })

  $('picker-list').addEventListener('click', (e) => {
    const b = e.target.closest('button')
    if (!b) return
    onPicked(Number(b.dataset.id), b.firstChild.textContent)
    picker.close()
  })

  $('picker-none').addEventListener('click', () => {
    onPicked(null, '')
    picker.close()
  })
}
