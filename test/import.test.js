import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, clearTables } from './support/harness.js'
import { buildDocx, buildPdf } from './support/fixtures.mjs'
import { ImportError, decodeText, fixRadicals, kindOf, readUpload } from '../src/import.js'
import { addDays, todayIn } from '../src/dates.js'

const ALICE = 11
const BOB = 12
const today = todayIn()
const AI = { items: [
  { name: '食品经营许可证', category: '食品经营许可', expire_at: '2027-03-31', remind_days: 60, owner: '王芳', amount: null, note: '静安店' },
  { name: '写字楼租赁合同', category: '瞎编的分类', expire_at: null, needs_date: true, remind_days: 30, owner: null, amount: '240000', note: null }
] }

let h, alice, bob
before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
})
after(() => h.close())
beforeEach(async () => {
  await clearTables(h.pool)
  Object.assign(h.platform.state, { llm: () => JSON.stringify(AI), rejectKey: false, usersDown: false, models: [{ id: 'qwen-max', name: '通义千问 Max', default: true }] })
})

const rows = async () => (await h.pool.query('SELECT name, category, expire_at, needs_date, source, file_name, owner_name, assignee_id, amount, remind_days FROM expiry_item ORDER BY id'))[0]
const toRow = (x, extra = {}) => ({ ...x, ...extra })

// ---------- 文件读取 ----------
test('类型只看扩展名：图片、老 doc、其他都分得开', () => {
  assert.equal(kindOf('a.PDF'), 'pdf')
  assert.equal(kindOf('a.docx'), 'docx')
  assert.equal(kindOf('a.md'), 'text')
  assert.equal(kindOf('证照.JPG'), 'image')
  assert.equal(kindOf('a.doc'), 'doc')
  assert.equal(kindOf('a.exe'), 'other')
})

test('图片明确提示暂未开通，不假装支持', async () => {
  await assert.rejects(readUpload('营业执照.png', Buffer.from('x')), (e) => e instanceof ImportError && e.code === 'image' && e.message === '图片识别暂未开通，请先把证件信息转成文字')
})

test('真实解析：docx 的正文和表格、中文 PDF 都读得出字', async () => {
  const docx = await readUpload('台账.docx', buildDocx(['证照台账', [['名称', '到期日'], ['营业执照', '2027-03-31']]]))
  assert.match(docx.text, /营业执照/)
  const pdf = await readUpload('证.pdf', buildPdf(['食品经营许可证 有效期至二零二七年三月三十一日，经营者静安店']))
  assert.match(pdf.text, /食品经营许可证/)
})

test('PDF 里长得像汉字的部首归一：部首补充区和康熙部首都修，中文标点不动', () => {
  assert.equal(fixRadicals('⻝品经营许可证，上海以⻁，南京⻄路'), '食品经营许可证，上海以虎，南京西路')
  assert.equal(fixRadicals('项⽬（⻔店）'), '项目（门店）')
  assert.equal(fixRadicals('全角：标点！ABC'), '全角：标点！ABC')
})

test('扫描件、坏文件、空文件给人话', async () => {
  await assert.rejects(readUpload('扫描.pdf', buildPdf([null])), (e) => e.code === 'scanned')
  await assert.rejects(readUpload('假.pdf', Buffer.from('hello')), /不是有效的 PDF/)
  await assert.rejects(readUpload('假.docx', Buffer.from('hello')), /不是有效的 .docx/)
  await assert.rejects(readUpload('空.txt', Buffer.alloc(0)), /空文件/)
})

test('文本文件：UTF-8、GBK 都能读，二进制改名的拒', () => {
  assert.equal(decodeText(Buffer.from('合同')), '合同')
  assert.equal(decodeText(Buffer.from([0xba, 0xcf, 0xcd, 0xac])), '合同')
  assert.throws(() => decodeText(Buffer.from([1, 0, 2])), /不是文本文件/)
})

// ---------- 识别：只出预览 ----------
test('粘贴文字：出预览不落库，非法分类回落其他，缺日期有标记', async () => {
  const r = await alice.post('/api/import/text', { text: '食品经营许可证有效期至 2027-03-31；写字楼租赁合同' })
  assert.equal(r.status, 200)
  assert.equal(r.json.ok, true)
  assert.deepEqual(r.json.items.map((x) => [x.name, x.category, x.needs_date]), [['食品经营许可证', '食品经营许可', false], ['写字楼租赁合同', '其他', true]])
  assert.deepEqual(await rows(), [])
})

test('上传 .txt：走同一条路，带回原文件名', async () => {
  const r = await alice.importFile('证照清单.txt', Buffer.from('食品经营许可证 2027-03-31'))
  assert.equal(r.status, 200)
  assert.equal(r.json.file_name, '证照清单.txt')
  assert.equal(r.json.items.length, 2)
})

test('上传 PDF 和 docx 经接口走通', async () => {
  assert.equal((await alice.importFile('证.pdf', buildPdf(['食品经营许可证 有效期至 2027 年 3 月 31 日，经营者静安店']))).json.items.length, 2)
  assert.equal((await alice.importFile('合同.docx', buildDocx(['写字楼租赁合同']))).json.items.length, 2)
})

test('上传图片：422 和明确提示，不调模型', async () => {
  let called = false
  h.platform.state.llm = () => { called = true; return '{}' }
  const r = await alice.importFile('营业执照.jpg', Buffer.from([0xff, 0xd8, 0xff]))
  assert.equal(r.status, 422)
  assert.equal(r.json.code, 'image')
  assert.match(r.json.error, /图片识别暂未开通/)
  assert.equal(called, false)
})

test('上传路径穿越的文件名：只留文件名本身', async () => {
  const r = await alice.importFile('../../etc/证照.txt', Buffer.from('营业执照'))
  assert.equal(r.json.file_name, '证照.txt')
})

test('超过 10MB 413，空粘贴 400', async () => {
  assert.equal((await alice.importFile('大.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 0x61))).status, 413)
  assert.equal((await alice.post('/api/import/text', { text: '  ' })).status, 400)
})

test('AI 失败降级：模型挂了、假 key、回垃圾、超时都不 500，提示手动录入', async () => {
  const check = async () => {
    const r = await alice.post('/api/import/text', { text: '合同' })
    assert.equal(r.status, 200)
    assert.equal(r.json.ok, false)
    assert.deepEqual(r.json.items, [])
    assert.match(r.json.message, /自动识别失败，可以手动录入/)
  }
  h.platform.state.llm = () => undefined
  await check()
  h.platform.state.llm = () => '抱歉'
  await check()
  h.platform.state.llm = () => new Promise(() => {})
  await check()
  h.platform.state.llm = () => JSON.stringify(AI)
  h.platform.state.rejectKey = true
  await check()
})

test('识别用这个人的分类和默认提醒天数', async () => {
  await alice.put('/api/settings', { default_remind_days: 45 })
  await alice.post('/api/categories', { name: '消防' })
  let prompt = ''
  h.platform.state.llm = (body) => { prompt = body.messages[0].content; return JSON.stringify({ items: [{ name: 'A', category: '消防', expire_at: null }] }) }
  const r = await alice.post('/api/import/text', { text: '消防证' })
  assert.match(prompt, /消防/)
  assert.equal(r.json.items[0].category, '消防')
  assert.equal(r.json.items[0].remind_days, 45)
})

// ---------- 确认入库 ----------
const preview = async () => (await alice.post('/api/import/text', { text: '两份' })).json.items

test('确认：source 记 import，file_name 记原文件名，缺日期的以 NULL 入库', async () => {
  const items = (await preview()).map((x) => toRow(x, { file_name: '许可证与租赁合同.pdf' }))
  const r = await alice.post('/api/import/commit', { items })
  assert.equal(r.status, 201)
  assert.equal(r.json.created, 2)
  const [a, b] = await rows()
  assert.deepEqual([a.name, a.category, a.expire_at, a.needs_date, a.source, a.file_name], ['食品经营许可证', '食品经营许可', '2027-03-31', 0, 'import', '许可证与租赁合同.pdf'])
  assert.deepEqual([b.name, b.category, b.expire_at, b.needs_date, b.source], ['写字楼租赁合同', '其他', null, 1, 'import'])
})

test('逐条勾选：只导入选中的，selected: false 的不进库', async () => {
  const [first, second] = await preview()
  const r = await alice.post('/api/import/commit', { items: [toRow(first, { selected: false }), toRow(second, { selected: true })] })
  assert.equal(r.json.created, 1)
  assert.deepEqual((await rows()).map((x) => x.name), ['写字楼租赁合同'])
})

test('一条都没选 400，什么也不进库', async () => {
  const items = (await preview()).map((x) => toRow(x, { selected: false }))
  const r = await alice.post('/api/import/commit', { items })
  assert.equal(r.status, 400)
  assert.match(r.json.error, /先勾选/)
  assert.deepEqual(await rows(), [])
})

test('页面上改过的值入库', async () => {
  const [first] = await preview()
  await alice.post('/api/import/commit', { items: [toRow(first, { name: '改过的名称', category: '保险', expire_at: '2028-01-01', remind_days: 7, amount: '1,200.5', owner: '李雷' })] })
  const [r] = await rows()
  assert.deepEqual([r.name, r.category, r.expire_at, r.remind_days, r.amount, r.owner_name], ['改过的名称', '保险', '2028-01-01', 7, '1200.50', '李雷'])
})

test('确认时服务端重新校验：坏一条整批不进，报第几条', async () => {
  const [first, second] = await preview()
  const r = await alice.post('/api/import/commit', { items: [first, toRow(second, { category: '其他', amount: 'abc' })] })
  assert.equal(r.status, 400)
  assert.equal(r.json.index, 1)
  assert.match(r.json.error, /第 2 条：金额/)
  assert.deepEqual(await rows(), [])
})

test('确认时分类不在清单里 400，日期乱写 400', async () => {
  const [first] = await preview()
  assert.equal((await alice.post('/api/import/commit', { items: [toRow(first, { category: '瞎编' })] })).status, 400)
  assert.equal((await alice.post('/api/import/commit', { items: [toRow(first, { expire_at: '2026-02-30' })] })).status, 400)
})

test('文件里的人名只是文字：和平台用户同名也不授权', async () => {
  const [first] = await preview()
  await alice.post('/api/import/commit', { items: [toRow(first, { owner: '李雷' })] })
  const [r] = await rows()
  assert.equal(r.owner_name, '李雷')
  assert.equal(r.assignee_id, null)
  assert.equal((await bob.get('/api/items')).json.list.length, 0)
  assert.equal((await alice.get('/api/items')).json.list[0].owner, '李雷')
})

test('没写负责人的用设置里的默认负责人，写了的不覆盖', async () => {
  await alice.put('/api/settings', { default_assignee_id: BOB })
  const [first, second] = await preview()
  await alice.post('/api/import/commit', { items: [toRow(first, { owner: '' }), second] })
  const all = await rows()
  assert.equal(all[0].assignee_id, BOB)
  assert.equal(all[1].assignee_id, BOB) // AI 没抽到负责人（null）
  assert.equal((await alice.get('/api/items')).json.list.find((t) => t.assignee_id === BOB).assignee, '用户 12')
})

test('文件名清理：提交的路径只留文件名', async () => {
  const [first] = await preview()
  await alice.post('/api/import/commit', { items: [toRow(first, { file_name: '../../etc/passwd.pdf' })] })
  assert.equal((await rows())[0].file_name, 'passwd.pdf')
})

test('未登录不能识别也不能入库', async () => {
  assert.equal((await fetch(`${h.base}/api/import/text`, { method: 'POST' })).status, 401)
  assert.equal((await fetch(`${h.base}/api/import/commit`, { method: 'POST' })).status, 401)
})

// ---------- 缺日期的条目 ----------
const needsDate = async () => {
  await alice.post('/api/import/commit', { items: [{ name: '缺日期的', category: '其他', expire_at: null }] })
  return (await alice.get('/api/items')).json.list[0]
}

test('缺日期的条目：排最前，文案待补，统计单列，不算进任何时间窗口', async () => {
  const t = await needsDate()
  await alice.post('/api/items', { name: '有日期的', due_date: addDays(today, 3) })
  assert.equal(t.days_text, '待补到期日')
  assert.equal(t.days, null)
  assert.equal(t.needs_date, true)
  const { list, stats } = (await alice.get('/api/items')).json
  assert.deepEqual(list.map((x) => x.name), ['缺日期的', '有日期的'])
  assert.equal(stats.needs, 1)
  assert.equal(stats.total, 2)
  assert.equal(stats.in7, 1)
  assert.deepEqual((await alice.get('/api/items?w=needs')).json.list.map((x) => x.name), ['缺日期的'])
})

test('缺日期的条目：改别的字段不用填日期，补上日期后标记清除', async () => {
  const t = await needsDate()
  assert.equal((await alice.patch(`/api/items/${t.id}`, { name: '改名' })).status, 200)
  const r = await alice.patch(`/api/items/${t.id}`, { due_date: '2027-05-01' })
  assert.equal(r.json.needs_date, false)
  assert.deepEqual((await rows()).map((x) => [x.expire_at, x.needs_date]), [['2027-05-01', 0]])
})

test('有日期的条目不能把日期清空；普通新建必须填', async () => {
  const c = await alice.post('/api/items', { name: 'A', due_date: '2027-01-01' })
  assert.equal((await alice.patch(`/api/items/${c.json.id}`, { due_date: '' })).status, 400)
  assert.equal((await alice.post('/api/items', { name: 'B', needs_date: true })).status, 400)
})

test('缺日期的条目不进每日提醒，也不让看板和提醒崩', async () => {
  await needsDate()
  const { text } = await alice.get('/api/board.html')
  assert.ok(text.includes('待补到期日'))
  assert.ok(text.includes('只看缺到期日') && text.includes('title="补上之前不会提醒"'))
  await h.reminder.tick(new Date(`${today}T15:00:00Z`))
  assert.equal(h.platform.state.notifications.length, 0)
})
