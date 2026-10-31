import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { startHarness } from './support/harness.js'
import { createApp, formatAmount } from '../src/app.js'
import { Workspace } from '../src/yh-one.mjs'
import { addDays, todayIn } from '../src/dates.js'
import { VERSION } from '../src/version.js'
import { MAX_BYTES } from '../src/attachments.js'
import { createItems } from '../src/items.js'
import { createNotifier, scan } from '../src/reminder.js'

const ALICE = 11
const BOB = 12
const CAROL = 13
const PDF = Buffer.from('%PDF-1.7\nhello')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

let h, alice, bob, carol
const today = todayIn()

before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
  carol = await h.login(CAROL)
})
after(() => h.close())
beforeEach(async () => {
  await h.pool.query('DELETE FROM expiry_item')
  await rm(path.join(h.dataDir, 'attachments'), { recursive: true, force: true })
  h.platform.state.notifications.length = 0
  h.platform.state.notifyMode = 'ok'
})

const create = async (who, body = {}) => {
  const r = await who.post('/api/items', { name: '条目', due_date: addDays(today, 10), ...body })
  assert.equal(r.status, 201, r.text)
  return r.json
}
const names = async (who, qs = '') => (await who.get(`/api/items${qs}`)).json.list.map((t) => t.name)
const stored = async () => (await readdir(path.join(h.dataDir, 'attachments')).catch(() => [])).filter((f) => !f.startsWith('.'))

// ---------- 健康检查与页面 ----------
test('/health 免登录，返回规定格式', async () => {
  const r = await fetch(`${h.base}/health`)
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { status: 'ok', version: '0.1.1' })
})

test('版本号三处一致：清单、package.json、页面', async () => {
  const pkg = JSON.parse(await (await import('node:fs/promises')).readFile('package.json', 'utf8'))
  assert.equal(pkg.version, VERSION)
  assert.match((await alice.get('/')).text, new RegExp(`id="version">v${VERSION}<`))
})

test('页面带规定的 viewport，地址都是相对路径', async () => {
  const { text } = await alice.get('/')
  assert.ok(text.includes('<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'))
  assert.ok(!/(?:href|src)="\/[^/]/.test(text.replace(/<base[^>]*>/, '')))
  assert.ok(text.includes('inputmode="decimal"'))
})

test('平台转发时 <base> 带上路径前缀', async () => {
  assert.match((await alice.get('/')).text, /<base href="\/">/)
  assert.match((await alice.get('/', { 'x-forwarded-prefix': '/apps/expiry' })).text, /<base href="\/apps\/expiry\/">/)
})

test('未登录：页面和附件跳平台授权，接口 401', async () => {
  const page = await fetch(`${h.base}/`, { redirect: 'manual' })
  assert.equal(page.status, 302)
  assert.match(page.headers.get('location'), /\/sso\/authorize/)
  assert.equal((await fetch(`${h.base}/api/items`)).status, 401)
  assert.equal((await fetch(`${h.base}/attachments/1`, { redirect: 'manual' })).status, 302)
})

test('生产环境没配平台凭证：不退回匿名', async () => {
  const keep = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try {
    const app = createApp({ ws: new Workspace({ clientId: '', clientSecret: '', appUrl: '' }), pool: h.pool, dataDir: h.dataDir })
    const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/items`)
    assert.equal(r.status, 503)
    server.closeAllConnections()
    await new Promise((res) => server.close(res))
  } finally {
    process.env.NODE_ENV = keep
  }
})

// ---------- 条目 ----------
test('新建：默认提醒 30 天、默认类别其他；金额和备注可选', async () => {
  const t = await create(alice)
  assert.equal(t.remind_days, 30)
  assert.equal(t.category, '其他')
  assert.equal(t.amount, null)
  assert.equal(t.assignee_id, null)
})

test('提前提醒 0 天是有效值，不被当成没填', async () => {
  assert.equal((await create(alice, { remind_days: 0 })).remind_days, 0)
  assert.equal((await create(alice, { remind_days: '0' })).remind_days, 0)
})

test('必填与枚举校验', async () => {
  const bad = async (body, re) => {
    const r = await alice.post('/api/items', { name: 'x', due_date: today, ...body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.match(r.json.error, re)
  }
  await bad({ name: '  ' }, /名称/)
  await bad({ due_date: '' }, /到期日不能为空/)
  await bad({ due_date: '2026-02-30' }, /到期日格式/)
  await bad({ category: '发票' }, /类别/)
  await bad({ remind_days: -1 }, /提醒天数/)
  await bad({ remind_days: 1.5 }, /提醒天数/)
  await bad({ amount: 'abc' }, /金额/)
  await bad({ amount: '1.234' }, /金额/)
})

test('金额：带千分位能存，精确到分，不经过浮点', async () => {
  const t = await create(alice, { amount: '1,234,567.89' })
  assert.equal(t.amount, '1234567.89')
  assert.equal((await alice.get(`/api/items/${t.id}`)).json.amount, '1234567.89')
  assert.equal(formatAmount('1234567.89'), '¥1,234,567.89')
  assert.equal(formatAmount('12000.00'), '¥12,000')
})

test('SQL 参数化：名称里带引号和注释符不报错，原样存回', async () => {
  const name = `O'Reilly -- 合同'; DROP TABLE expiry_item; --`
  const t = await create(alice, { name, note: "备注 ' --" })
  assert.equal((await alice.get(`/api/items/${t.id}`)).json.name, name)
  assert.deepEqual(await names(alice), [name])
  assert.equal((await alice.patch(`/api/items/${t.id}`, { name: `${name}'` })).status, 200)
})

test('SQL 参数化：筛选参数和批量录入里的引号也不进 SQL', async () => {
  await create(alice, { name: 'x' })
  assert.deepEqual(await names(alice, `?cat=${encodeURIComponent("' OR 1=1 --")}&who=${encodeURIComponent('1 OR 1=1')}&w=${encodeURIComponent("'")}`), ['x'])
  const r = await alice.post('/api/batch', { text: "O'Neil -- 证, 2026-12-01, 证照" })
  assert.equal(r.json.created, 1)
  assert.ok((await names(alice)).includes("O'Neil -- 证"))
})

test('修改：只传的字段变，其余不动', async () => {
  const t = await create(alice, { name: 'A', amount: '10', remind_days: 7, category: '合同' })
  const r = await alice.patch(`/api/items/${t.id}`, { name: 'B' })
  assert.equal(r.status, 200)
  assert.equal(r.json.name, 'B')
  assert.equal(r.json.amount, '10.00')
  assert.equal(r.json.remind_days, 7)
  assert.equal(r.json.category, '合同')
})

test('改名后 DATE 不被时区挪一天', async () => {
  const t = await create(alice, { due_date: '2026-12-31' })
  await alice.patch(`/api/items/${t.id}`, { name: 'B' })
  assert.equal((await alice.get(`/api/items/${t.id}`)).json.due_date, '2026-12-31')
})

test('负责人：选平台上没有的人 400，选自己可以', async () => {
  assert.equal((await alice.post('/api/items', { name: 'x', due_date: today, assignee_id: 999 })).status, 400)
  assert.equal((await create(alice, { assignee_id: ALICE })).assignee, '王小明')
})

test('负责人：平台挂了时不改负责人的编辑不受影响', async () => {
  const t = await create(alice, { assignee_id: BOB })
  h.platform.state.usersDown = true
  try {
    assert.equal((await alice.patch(`/api/items/${t.id}`, { name: 'B', assignee_id: BOB })).status, 200)
  } finally {
    h.platform.state.usersDown = false
  }
})

// ---------- 列表 ----------
test('排序：已过期在最上，按剩余天数升序', async () => {
  for (const [name, d] of [['60', 60], ['今天', 0], ['过期 2', -2], ['5', 5], ['过期 10', -10], ['20', 20]]) await create(alice, { name, due_date: addDays(today, d) })
  assert.deepEqual(await names(alice), ['过期 10', '过期 2', '今天', '5', '20', '60'])
})

test('列表字段：剩余天数、档位、文案', async () => {
  await create(alice, { name: 'A', due_date: addDays(today, -5) })
  const [t] = (await alice.get('/api/items')).json.list
  assert.equal(t.days, -5)
  assert.equal(t.tier, 'expired')
  assert.equal(t.days_text, '已过期 5 天')
})

test('统计：30 天内包含 7 天内，不含已过期', async () => {
  for (const d of [-3, -1, 0, 5, 7, 8, 30, 31, 60]) await create(alice, { due_date: addDays(today, d) })
  assert.deepEqual((await alice.get('/api/items')).json.stats, { total: 9, expired: 2, in7: 3, in30: 5 })
})

test('统计：没有任何条目时是 0 不是 null', async () => {
  assert.deepEqual((await alice.get('/api/items')).json.stats, { total: 0, expired: 0, in7: 0, in30: 0 })
})

test('筛选：时间窗口和统计口径一致', async () => {
  for (const [n, d] of [['过期', -1], ['今天', 0], ['7', 7], ['8', 8], ['30', 30], ['31', 31]]) await create(alice, { name: n, due_date: addDays(today, d) })
  assert.deepEqual(await names(alice, '?w=expired'), ['过期'])
  assert.deepEqual(await names(alice, '?w=7'), ['今天', '7'])
  assert.deepEqual(await names(alice, '?w=30'), ['今天', '7', '8', '30'])
})

test('筛选：类别、负责人、未指定，可叠加；统计跟着类别走、不跟时间窗口走', async () => {
  await create(alice, { name: '合同甲', category: '合同', assignee_id: BOB, due_date: addDays(today, -1) })
  await create(alice, { name: '合同乙', category: '合同' })
  await create(alice, { name: '保险丙', category: '保险', assignee_id: BOB })
  assert.deepEqual(await names(alice, `?cat=${encodeURIComponent('合同')}`), ['合同甲', '合同乙'])
  assert.deepEqual(await names(alice, `?who=${BOB}`), ['合同甲', '保险丙'])
  assert.deepEqual(await names(alice, '?who=none'), ['合同乙'])
  assert.deepEqual(await names(alice, `?who=${BOB}&cat=${encodeURIComponent('保险')}`), ['保险丙'])
  const { stats } = (await alice.get(`/api/items?w=expired&cat=${encodeURIComponent('合同')}`)).json
  assert.deepEqual(stats, { total: 2, expired: 1, in7: 0, in30: 1 })
})

test('看板 HTML：三种颜色、相对天数、负责人姓名；用户内容被转义', async () => {
  await create(alice, { name: '<img src=x onerror=alert(1)>', due_date: addDays(today, -5), assignee_id: BOB })
  await create(alice, { name: '快到', due_date: addDays(today, 20) })
  await create(alice, { name: '还早', due_date: addDays(today, 60) })
  const { text } = await alice.get('/api/board.html')
  assert.ok(text.includes('t-expired') && text.includes('t-yellow') && text.includes('t-gray'))
  assert.ok(text.includes('已过期 5 天') && text.includes('60 天后'))
  assert.ok(text.includes('李雷'))
  assert.ok(!text.includes('<img src=x'))
})

const cardsOf = (html) => html.slice(html.indexOf('<ul class="cards">'))
const count = (text, word) => text.split(word).length - 1

test('看板 HTML：没负责人的卡片不渲染负责人这行，也不写「未指定」', async () => {
  await create(alice, { name: '空的甲' })
  await create(alice, { name: '空的乙' })
  const { text } = await alice.get('/api/board.html')
  const cards = cardsOf(text)
  assert.equal(count(cards, 'class="card t-'), 2)
  assert.ok(!cards.includes('负责人'))
  assert.ok(!cards.includes('未指定'))
  assert.ok(!cards.includes('—'))
  assert.ok(!cards.includes('>无<'))
})

test('看板 HTML：有负责人的才渲染这行，同一页里互不影响', async () => {
  await create(alice, { name: '空的' })
  await create(alice, { name: '有人', assignee_id: BOB })
  const cards = cardsOf((await alice.get('/api/board.html')).text)
  assert.equal(count(cards, '<dt>负责人</dt>'), 1)
  assert.equal(count(cards, '<dd>李雷</dd>'), 1)
  assert.equal(count(cards, '<dt>到期日</dt>'), 2)
})

test('看板 HTML：没附件的卡片不渲染附件行，有附件的才有', async () => {
  await create(alice, { name: '甲' })
  const withFile = await create(alice, { name: '乙' })
  assert.ok(!cardsOf((await alice.get('/api/board.html')).text).includes('附件'))
  await alice.upload(withFile.id, 'a.pdf', PDF)
  const cards = cardsOf((await alice.get('/api/board.html')).text)
  assert.equal(count(cards, '<dt>附件</dt>'), 1)
  assert.equal(count(cards, 'class="att"'), 1)
})

test('看板 HTML：金额、备注为空时卡片上没有对应的行', async () => {
  await create(alice, { name: '空的' })
  const cards = cardsOf((await alice.get('/api/board.html')).text)
  assert.ok(!cards.includes('金额') && !cards.includes('备注'))
})

test('筛选里的「未指定」保留，能筛出没指派的，选中态也在', async () => {
  await create(alice, { name: '空的' })
  await create(alice, { name: '有人', assignee_id: BOB })
  const all = (await alice.get('/api/board.html')).text
  assert.ok(all.includes('<option value="none">未指定</option>'))
  const none = (await alice.get('/api/board.html?who=none')).text
  assert.ok(none.includes('<option value="none" selected>未指定</option>'))
  assert.equal(count(cardsOf(none), 'class="card t-'), 1)
  assert.ok(none.includes('空的') && !none.includes('有人'))
})

test('首页：整页只有筛选里那一处「未指定」', async () => {
  await create(alice, { name: '空的甲' })
  await create(alice, { name: '空的乙' })
  assert.equal(count((await alice.get('/')).text, '未指定'), 1)
})

test('新建表单：负责人、金额、备注标选填，名称和到期日不标，金额键盘不变', async () => {
  const { text } = await alice.get('/')
  assert.equal(count(text, '<span class="opt">选填</span>'), 3)
  for (const label of ['负责人', '金额', '备注']) assert.ok(text.includes(`${label}<span class="opt">选填</span>`), label)
  assert.ok(text.includes('<span>名称</span>') && text.includes('<span>到期日</span>'))
  assert.ok(/id="f-name"[^>]*required/.test(text) && /id="f-due"[^>]*required/.test(text))
  assert.ok(/id="f-amount"[^>]*inputmode="decimal"/.test(text))
  for (const key of ['assign', 'amount', 'note', 'att']) assert.ok(text.includes(`data-optional="${key}"`), key)
})

test('清单：版本 0.1.1 且两处一致，手动发布', async () => {
  const read = async (f) => JSON.parse(await readFile(new URL(`../${f}`, import.meta.url), 'utf8'))
  const [manifest, pkg] = await Promise.all([read('yh-app.json'), read('package.json')])
  assert.equal(manifest.version, '0.1.1')
  assert.equal(pkg.version, manifest.version)
  assert.equal(manifest.deploy.mode, 'manual')
})

// ---------- 权限 ----------
test('别人的条目：看不到；直改、直删 404', async () => {
  const t = await create(alice)
  assert.deepEqual(await names(carol), [])
  assert.equal((await carol.get(`/api/items/${t.id}`)).status, 404)
  assert.equal((await carol.patch(`/api/items/${t.id}`, { name: '偷改' })).status, 404)
  assert.equal((await carol.del(`/api/items/${t.id}`)).status, 404)
  assert.equal((await carol.upload(t.id, 'a.pdf', PDF)).status, 404)
  assert.equal((await carol.del(`/api/items/${t.id}/attachment`)).status, 404)
  assert.equal((await alice.get(`/api/items/${t.id}`)).json.name, '条目')
})

test('负责人：看得到，改和删 403', async () => {
  const t = await create(alice, { assignee_id: BOB })
  assert.equal((await bob.get(`/api/items/${t.id}`)).json.from, '王小明')
  assert.equal((await bob.patch(`/api/items/${t.id}`, { name: '改' })).status, 403)
  assert.equal((await bob.del(`/api/items/${t.id}`)).status, 403)
  assert.equal((await bob.upload(t.id, 'a.pdf', PDF)).status, 403)
})

test('id 乱写一律 404', async () => {
  for (const id of ['abc', '0', '-1', '1%20OR%201=1']) assert.equal((await alice.get(`/api/items/${id}`)).status, 404, id)
})

// ---------- 附件 ----------
test('附件：上传、下载内容一致；文件名是服务端生成的 <id>-<hash>.<ext>', async () => {
  const t = await create(alice)
  const r = await alice.upload(t.id, '华东仓 租赁合同.pdf', PDF)
  assert.equal(r.status, 200)
  assert.equal(r.json.attachment.name, '华东仓 租赁合同.pdf')
  assert.equal(r.json.attachment.url, `attachments/${t.id}`)
  assert.equal(JSON.stringify(r.json).includes('attachment_file'), false)
  const [file] = await stored()
  assert.match(file, new RegExp(`^${t.id}-[0-9a-f]{16}\\.pdf$`))
  const d = await alice.download(t.id)
  assert.equal(d.status, 200)
  assert.deepEqual(d.body, PDF)
  assert.equal(d.headers.get('content-type'), 'application/pdf')
  assert.equal(d.headers.get('x-content-type-options'), 'nosniff')
  assert.match(d.headers.get('content-disposition'), /^inline; filename=".*"; filename\*=UTF-8''/)
  assert.ok(d.headers.get('content-disposition').includes(encodeURIComponent('租赁合同')))
  assert.equal(d.headers.get('cache-control'), 'private, no-store')
})

test('附件：非 owner 下载 403，创建人和负责人可以', async () => {
  const t = await create(alice, { assignee_id: BOB })
  await alice.upload(t.id, 'a.pdf', PDF)
  assert.equal((await carol.download(t.id)).status, 403)
  assert.equal((await bob.download(t.id)).status, 200)
  assert.equal((await alice.download(t.id)).status, 200)
})

test('附件：不存在的 id 和没权限都是 403，探测不出 id', async () => {
  assert.equal((await carol.download(999999999)).status, 403)
  assert.equal((await carol.download('abc')).status, 403)
})

test('附件：自己的条目没附件 404', async () => {
  const t = await create(alice)
  assert.equal((await alice.download(t.id)).status, 404)
})

test('附件：类型白名单在接口上生效，内容对不上也拒', async () => {
  const t = await create(alice)
  assert.equal((await alice.upload(t.id, 'a.exe', PDF)).status, 400)
  assert.equal((await alice.upload(t.id, 'a.svg', Buffer.from('<svg onload=alert(1)>'))).status, 400)
  assert.equal((await alice.upload(t.id, 'a.pdf', Buffer.from('<html><script>alert(1)</script>'))).status, 400)
  assert.equal((await alice.upload(t.id, null, PDF)).status, 400)
  assert.deepEqual(await stored(), [])
})

test('附件：路径穿越被拒，盘上什么也没写', async () => {
  const t = await create(alice)
  for (const n of ['../../evil.pdf', '..\\..\\evil.pdf', '/etc/evil.pdf']) {
    const r = await alice.upload(t.id, n, PDF)
    assert.equal(r.status, 400, n)
    assert.match(r.json.error, /文件名不合法/)
  }
  assert.deepEqual(await stored(), [])
})

test('附件：下载地址穿越到不了文件系统', async () => {
  for (const p of ['/attachments/..%2F..%2Fetc%2Fpasswd', '/attachments/..%2f1', '/attachments/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    const r = await alice.get(p)
    assert.ok([403, 404].includes(r.status), `${p} → ${r.status}`)
    assert.ok(!r.text.includes('root:'))
  }
})

test('附件：库里的文件名被写坏也读不到目录外', async () => {
  const t = await create(alice)
  await alice.upload(t.id, 'a.pdf', PDF)
  await h.pool.query("UPDATE expiry_item SET attachment_file = '../../../etc/passwd' WHERE id = ?", [t.id])
  assert.equal((await alice.download(t.id)).status, 404)
  await h.pool.query('UPDATE expiry_item SET attachment_file = NULL WHERE id = ?', [t.id])
})

test('附件：10MB 上限，正好 10MB 能传，多 1 字节 413', async () => {
  const t = await create(alice)
  const exact = Buffer.alloc(MAX_BYTES)
  PDF.copy(exact)
  assert.equal((await alice.upload(t.id, 'a.pdf', exact)).status, 200)
  const r = await alice.upload(t.id, 'b.pdf', Buffer.concat([exact, Buffer.alloc(1)]))
  assert.equal(r.status, 413)
  assert.match(r.json.error, /10MB/)
  assert.equal((await alice.get(`/api/items/${t.id}`)).json.attachment.name, 'a.pdf')
})

test('附件：换文件后旧文件被删，一个条目只有一个文件', async () => {
  const t = await create(alice)
  await alice.upload(t.id, 'a.pdf', PDF)
  await alice.upload(t.id, 'b.png', PNG)
  const files = await stored()
  assert.equal(files.length, 1)
  assert.match(files[0], /\.png$/)
  assert.equal((await alice.download(t.id)).headers.get('content-type'), 'image/png')
})

test('附件：同一个文件重传不会把自己删掉', async () => {
  const t = await create(alice)
  await alice.upload(t.id, 'a.pdf', PDF)
  await alice.upload(t.id, 'a.pdf', PDF)
  assert.equal((await stored()).length, 1)
  assert.equal((await alice.download(t.id)).status, 200)
})

test('附件：移除和删除条目都清掉盘上的文件', async () => {
  const a = await create(alice)
  await alice.upload(a.id, 'a.pdf', PDF)
  assert.equal((await alice.del(`/api/items/${a.id}/attachment`)).json.attachment, null)
  assert.deepEqual(await stored(), [])
  const b = await create(alice)
  await alice.upload(b.id, 'b.pdf', PDF)
  assert.equal((await alice.del(`/api/items/${b.id}`)).status, 204)
  assert.deepEqual(await stored(), [])
})

test('附件：盘上文件丢了给人话，不是 500', async () => {
  const t = await create(alice)
  await alice.upload(t.id, 'a.pdf', PDF)
  await rm(path.join(h.dataDir, 'attachments', (await stored())[0]))
  assert.equal((await alice.download(t.id)).status, 404)
})

test('附件：文件权限不开放给其他用户', async () => {
  const t = await create(alice)
  await alice.upload(t.id, 'a.pdf', PDF)
  const s = await stat(path.join(h.dataDir, 'attachments', (await stored())[0]))
  assert.equal(s.mode & 0o007, 0)
})

// ---------- 批量录入 ----------
test('批量：预览不落库，提交入库，坏行列出', async () => {
  const text = 'A, 2026-11-20, 合同\nB, 乱写, 合同\nC, 2026/12/01, 保险\n缺列'
  const p = await alice.post('/api/batch/preview', { text })
  assert.equal(p.json.rows.length, 2)
  assert.deepEqual(p.json.errors.map((e) => e.line), [2, 4])
  assert.deepEqual(await names(alice), [])
  const r = await alice.post('/api/batch', { text })
  assert.equal(r.status, 201)
  assert.equal(r.json.created, 2)
  assert.deepEqual(r.json.errors.map((e) => e.line), [2, 4])
  assert.deepEqual(await names(alice), ['A', 'C'])
  assert.equal((await alice.get('/api/items')).json.list[0].remind_days, 30)
})

test('批量：全是坏行时不提交，报错', async () => {
  assert.equal((await alice.post('/api/batch', { text: '坏, 坏, 坏' })).status, 400)
})

test('批量：只进自己名下', async () => {
  await alice.post('/api/batch', { text: 'A, 2026-11-20, 合同' })
  assert.deepEqual(await names(carol), [])
})

// ---------- 设置页 ----------
test('设置页：平台能发时显示已开启', async () => {
  const { text } = await alice.get('/settings')
  assert.ok(text.includes('已开启'))
  assert.ok(!text.includes('未配置'))
})

test('设置页：员工发布的应用（平台 403）显示未配置，探测不发任何消息', async () => {
  h.platform.state.notifyMode = 'forbidden'
  const { text } = await alice.get('/settings')
  assert.ok(text.includes('未配置，不会主动提醒'))
  h.platform.state.notifyMode = 'ok'
  await alice.get('/settings')
  assert.equal(h.platform.state.notifications.length, 0)
})

test('设置页：平台连不上时不说已开启', async () => {
  h.platform.state.notifyMode = 'down'
  const { text } = await alice.get('/settings')
  assert.ok(text.includes('查不到提醒状态'))
  assert.ok(!text.includes('已开启'))
})

test('提醒走真实 notify 接口：平台 skipped 的人不记档；403 时停手', async () => {
  const t = await create(alice, { due_date: today })
  h.platform.state.notifyMode = 'skipped'
  const deps = { items: createItems({ pool: h.pool }), notifier: createNotifier(h.ws), today }
  assert.equal((await scan(deps)).skipped, 1)
  h.platform.state.notifyMode = 'forbidden'
  const r = await scan(deps)
  assert.equal(r.forbidden, true)
  const [[row]] = await h.pool.query('SELECT last_notified_at FROM expiry_item WHERE id = ?', [t.id])
  assert.equal(row.last_notified_at, null)
})

// ---------- MCP ----------
test('MCP：不带 token 401；tools/list 正好两个工具', async () => {
  assert.equal((await h.mcp('tools/list')).status, 401)
  const r = await h.mcp('tools/list', undefined, `token-${ALICE}`)
  assert.deepEqual(r.json.result.tools.map((t) => t.name), ['list_expiring', 'create_expiry'])
  assert.equal(JSON.stringify(r.json.result.tools).includes('"run"'), false)
})

test('MCP：create_expiry 接受斜线日期和随口说的日期', async () => {
  const r = await h.mcp('tools/call', { name: 'create_expiry', arguments: { name: '营业执照', due_date: '2027/03/01', category: '证照' } }, `token-${ALICE}`)
  assert.equal(r.json.result.structuredContent.due_date, '2027-03-01')
  const s = await h.mcp('tools/call', { name: 'create_expiry', arguments: { name: '保单', due_date: '30天后' } }, `token-${ALICE}`)
  assert.equal(s.json.result.structuredContent.days_left, 30)
  assert.equal(s.json.result.structuredContent.category, '其他')
})

test('MCP：参数错给人话，不抛 500', async () => {
  const a = await h.mcp('tools/call', { name: 'create_expiry', arguments: { name: 'x', due_date: '找不到' } }, `token-${ALICE}`)
  assert.equal(a.json.result.isError, true)
  assert.match(a.json.result.content[0].text, /看不懂到期日/)
  const b = await h.mcp('tools/call', { name: 'create_expiry', arguments: { name: 'x', due_date: '明天', category: '发票' } }, `token-${ALICE}`)
  assert.match(b.json.result.content[0].text, /类别/)
  const c = await h.mcp('tools/call', { name: 'list_expiring', arguments: { days: -1 } }, `token-${ALICE}`)
  assert.equal(c.json.result.isError, true)
})

test('MCP：list_expiring 按阈值，含已过期，只看自己的', async () => {
  await create(alice, { name: '过期', due_date: addDays(today, -2) })
  await create(alice, { name: '5 天', due_date: addDays(today, 5) })
  await create(alice, { name: '60 天', due_date: addDays(today, 60) })
  await create(carol, { name: '别人的', due_date: addDays(today, 1) })
  const call = async (args) => (await h.mcp('tools/call', { name: 'list_expiring', arguments: args }, `token-${ALICE}`)).json.result.structuredContent
  assert.deepEqual((await call({ days: 7 })).list.map((t) => t.name), ['过期', '5 天'])
  assert.deepEqual((await call({})).list.map((t) => t.name), ['过期', '5 天'])
  assert.deepEqual((await call({ days: 60 })).list.map((t) => t.name), ['过期', '5 天', '60 天'])
  assert.equal((await call({ days: 7 })).list[0].label, '已过期 2 天')
})
