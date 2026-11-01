// 设置页：改一项存一项，没有保存按钮，下一次操作就用新值
const box = $('settings')
const catBox = $('cat-box')
const FALLBACK = '其他'
let categories = JSON.parse(catBox.dataset.categories)
let ownerId = Number(box.dataset.ownerId) || null
let renaming = null

const saveSetting = async (body) => {
  await api('PUT', 'api/settings', body)
  toast('已保存')
}
const saveQuietly = (body) => saveSetting(body).catch((e) => toast(e.message))

function showOwner(name) {
  $('s-owner-name').textContent = ownerId ? name : '不指定'
}
showOwner(box.dataset.ownerName)

$('s-owner').addEventListener('click', () => pickPerson(ownerId, async (id, name) => {
  try {
    await saveSetting({ default_assignee_id: id })
    ownerId = id
    showOwner(name)
  } catch (e) { toast(e.message) }
}))

$('s-hour').addEventListener('change', (e) => saveQuietly({ remind_hour: Number(e.target.value) }))
$('s-platform').addEventListener('change', async (e) => {
  await saveQuietly({ notify_platform: e.target.checked })
  location.reload() // 顶上的提醒状态要跟着变
})

$('s-remind').addEventListener('change', async (e) => {
  $('s-remind-error').hidden = true
  try {
    await saveSetting({ default_remind_days: e.target.value === '' ? null : Number(e.target.value) })
  } catch (err) {
    $('s-remind-error').textContent = err.message
    $('s-remind-error').hidden = false
  }
})

// ---------- 分类 ----------
function catButton(label, action, text = label) {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'yh-btn yh-btn--text'
  b.textContent = text
  b.dataset.action = action
  b.setAttribute('aria-label', label)
  return b
}

function renderCategories() {
  $('cat-list').replaceChildren(...categories.map((name, i) => {
    const li = document.createElement('li')
    li.className = 'cat-row'
    li.dataset.name = name
    const label = document.createElement('span')
    label.className = 'cat-name'
    label.textContent = name
    const up = catButton(`上移 ${name}`, 'up', '↑')
    up.disabled = i === 0
    const down = catButton(`下移 ${name}`, 'down', '↓')
    down.disabled = i === categories.length - 1
    li.append(label, up, down)
    if (name !== FALLBACK) li.append(catButton(`改名 ${name}`, 'rename', '改名'), catButton(`删除 ${name}`, 'remove', '删除'))
    return li
  }))
}

async function move(i, delta) {
  const next = [...categories]
  ;[next[i], next[i + delta]] = [next[i + delta], next[i]]
  const out = await api('PUT', 'api/categories/order', { names: next })
  categories = out.categories
  renderCategories()
}

$('cat-list').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-action]')
  if (!b) return
  const { name } = b.closest('.cat-row').dataset
  try {
    if (b.dataset.action === 'up') return await move(categories.indexOf(name), -1)
    if (b.dataset.action === 'down') return await move(categories.indexOf(name), 1)
    if (b.dataset.action === 'rename') {
      renaming = name
      $('rename-input').value = name
      $('rename').showModal()
      return $('rename-input').select()
    }
    const yes = await ask({ title: `删除「${name}」？`, text: `这个分类下的条目会转到「${FALLBACK}」，条目本身不删。`, yes: '删除', danger: true })
    if (!yes) return
    const out = await api('DELETE', 'api/categories', { name })
    categories = out.categories
    renderCategories()
    toast(out.moved ? `已删除，${out.moved} 条转到「${FALLBACK}」` : '已删除')
  } catch (err) { toast(err.message) }
})

$('cat-add').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    const out = await api('POST', 'api/categories', { name: $('cat-name').value })
    categories = out.categories
    $('cat-name').value = ''
    renderCategories()
    toast('已添加')
  } catch (err) { toast(err.message) }
})

$('rename-form').addEventListener('submit', async (e) => {
  e.preventDefault()
  try {
    const out = await api('PATCH', 'api/categories', { from: renaming, to: $('rename-input').value })
    categories = out.categories
    $('rename').close()
    renderCategories()
    toast('已改名')
  } catch (err) { toast(err.message) }
})

renderCategories()
