import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { startHarness, clearTables } from './support/harness.js'
import { addDays, addMonths, monthRange, monthWeeks, todayIn } from '../src/dates.js'
import { csvCell, toCsv, toMarkdown } from '../src/export.js'
import { CATEGORIES } from '../src/items.js'
import { calendarOf, decorate, hrefOf } from '../src/present.js'
import { createItems } from '../src/items.js'
import { scan } from '../src/reminder.js'

const ALICE = 11
const BOB = 12
const today = todayIn()
let h, alice, bob

before(async () => {
  h = await startHarness()
  alice = await h.login(ALICE)
  bob = await h.login(BOB)
})
after(() => h.close())
beforeEach(async () => {
  await clearTables(h.pool)
  h.platform.state.notifications.length = 0
  h.platform.state.notifyMode = 'ok'
})

const create = async (who, body = {}) => (await who.post('/api/items', { name: '条目', due_date: addDays(today, 10), ...body })).json
const cats = async (who = alice) => JSON.parse(/data-categories="([^"]*)"/.exec((await who.get('/settings')).text)[1].replaceAll('&#34;', '"'))

// ---------- 分类 ----------
test('分类默认是固定的七个', async () => assert.deepEqual(await cats(), CATEGORIES))

test('分类增：排在「其他」前面，重名和超长拒', async () => {
  const r = await alice.post('/api/categories', { name: '消防' })
  assert.equal(r.status, 201)
  assert.deepEqual(r.json.categories.slice(-2), ['消防', '其他'])
  assert.equal((await alice.post('/api/categories', { name: '消防' })).status, 400)
  assert.equal((await alice.post('/api/categories', { name: '一二三四五六七八九' })).status, 400)
  assert.equal((await alice.post('/api/categories', { name: '  ' })).status, 400)
  assert.equal((await alice.post('/api/categories', { name: 'a,b' })).status, 400)
  assert.equal((await create(alice, { category: '消防' })).category, '消防')
})

test('分类改名：条目跟着改，重名拒，「其他」不能改', async () => {
  const t = await create(alice, { category: '保险' })
  const r = await alice.patch('/api/categories', { from: '保险', to: '车险' })
  assert.ok(r.json.categories.includes('车险') && !r.json.categories.includes('保险'))
  assert.equal((await alice.get(`/api/items/${t.id}`)).json.category, '车险')
  assert.equal((await alice.patch('/api/categories', { from: '车险', to: '保修' })).status, 400)
  assert.equal((await alice.patch('/api/categories', { from: '其他', to: '杂项' })).status, 400)
  assert.equal((await alice.patch('/api/categories', { from: '没有', to: '杂项' })).status, 404)
})

test('分类删：条目转到「其他」，条目不删，「其他」不能删', async () => {
  const t = await create(alice, { category: '保修' })
  const r = await alice.del('/api/categories', { name: '保修' })
  assert.equal(r.json.moved, 1)
  assert.ok(!r.json.categories.includes('保修'))
  assert.equal((await alice.get(`/api/items/${t.id}`)).json.category, '其他')
  assert.equal((await alice.del('/api/categories', { name: '其他' })).status, 400)
  assert.equal((await alice.post('/api/items', { name: 'x', due_date: today, category: '保修' })).status, 400)
})

test('分类排序：换顺序能存，借机增删的拒', async () => {
  const next = [...CATEGORIES].reverse()
  assert.deepEqual((await alice.put('/api/categories/order', { names: next })).json.categories, next)
  assert.deepEqual(await cats(), next)
  assert.equal((await alice.put('/api/categories/order', { names: next.slice(1) })).status, 400)
  assert.equal((await alice.put('/api/categories/order', { names: [...next.slice(1), '新的'] })).status, 400)
  assert.equal((await alice.put('/api/categories/order', { names: 'x' })).status, 400)
})

test('分类每人一份，改名只动自己的条目', async () => {
  await alice.post('/api/categories', { name: '消防' })
  assert.ok(!(await cats(bob)).includes('消防'))
  const mine = await create(bob, { category: '保险' })
  await alice.patch('/api/categories', { from: '保险', to: '车险' })
  assert.equal((await bob.get(`/api/items/${mine.id}`)).json.category, '保险')
})

test('老分类不丢：v0.1 的「合同」还在用就留在清单和筛选里，老条目照常能改', async () => {
  const [r] = await h.pool.query("INSERT INTO expiry_item (owner_id, name, category, due_date) VALUES (?, '老合同', '合同', ?)", [ALICE, addDays(today, 5)])
  assert.ok((await cats()).includes('合同'))
  assert.ok((await alice.get('/api/board.html')).text.includes('<option value="合同">合同 1</option>'))
  assert.equal((await alice.patch(`/api/items/${r.insertId}`, { name: '改名' })).json.category, '合同')
  assert.equal((await alice.get(`/api/items?cat=${encodeURIComponent('合同')}`)).json.list.length, 1)
})

test('负责人能按别人定的分类筛', async () => {
  await alice.post('/api/categories', { name: '消防' })
  await create(alice, { category: '消防', assignee_id: BOB })
  assert.equal((await bob.get(`/api/items?cat=${encodeURIComponent('消防')}`)).json.list.length, 1)
})

test('批量录入按这个人的分类校验', async () => {
  await alice.post('/api/categories', { name: '消防' })
  assert.equal((await alice.post('/api/batch', { text: 'A, 2026-12-01, 消防' })).json.created, 1)
  assert.equal((await bob.post('/api/batch', { text: 'A, 2026-12-01, 消防' })).status, 400)
})

// ---------- 设置 ----------
test('设置：部分更新，每人一份，非法值 400', async () => {
  assert.equal((await alice.put('/api/settings', { default_remind_days: 60 })).json.default_remind_days, 60)
  const r = await alice.put('/api/settings', { remind_hour: 7 })
  assert.equal(r.json.default_remind_days, 60)
  assert.equal(r.json.remind_hour, 7)
  for (const bad of [{ remind_hour: 24 }, { remind_hour: 1.5 }, { default_remind_days: -1 }, { default_remind_days: null }, { notify_platform: 'yes' }, { default_assignee_id: 999 }]) {
    assert.equal((await alice.put('/api/settings', bad)).status, 400, JSON.stringify(bad))
  }
  assert.ok((await bob.get('/settings')).text.includes('value="30"'))
})

test('默认提醒天数：新建和批量用，显式填的不被覆盖', async () => {
  await alice.put('/api/settings', { default_remind_days: 60 })
  assert.equal((await create(alice)).remind_days, 60)
  assert.equal((await create(alice, { remind_days: 0 })).remind_days, 0)
  await alice.post('/api/batch', { text: 'B, 2026-12-01, 保险' })
  assert.equal((await alice.get('/api/items')).json.list.at(-1).remind_days, 60)
})

test('默认负责人：没传才补，传 null 表示不要', async () => {
  await alice.put('/api/settings', { default_assignee_id: BOB })
  assert.equal((await create(alice)).assignee_id, BOB)
  assert.equal((await create(alice, { assignee_id: null })).assignee_id, null)
})

test('提醒时间：没到点不发，到点才发，每人按自己的', async () => {
  await alice.put('/api/settings', { remind_hour: 14 })
  await create(alice, { name: '甲', due_date: today })
  await create(bob, { name: '乙', due_date: today })
  const deps = { items: createItems({ pool: h.pool }), notifier: { send: async (m) => ({ sent: [{ userId: m.userIds[0] }], skipped: [] }) }, today }
  const morning = await scan({ ...deps, hour: 9 })
  assert.equal(morning.users, 1)
  assert.deepEqual(morning.done, [BOB])
  assert.equal((await scan({ ...deps, hour: 14, skip: new Set(morning.done) })).users, 1)
})

test('平台通知关了不发；设置页如实说已关闭，不探测', async () => {
  await alice.put('/api/settings', { notify_platform: false })
  await create(alice, { due_date: today })
  const r = await scan({ items: createItems({ pool: h.pool }), notifier: { send: async () => { throw new Error('不该发') } }, today })
  assert.equal(r.users, 0)
  assert.ok((await alice.get('/settings')).text.includes('平台通知已关闭'))
})

test('提醒期那句已删：看板不显示，设置页也不留没作用的开关，老设置照常读写', async () => {
  await create(alice, { due_date: addDays(today, 5) })
  assert.ok(!(await alice.get('/api/board.html')).text.includes('进入提醒期'))
  const page = (await alice.get('/settings')).text
  assert.ok(!page.includes('s-inapp') && !page.includes('站内提示'))
  assert.equal((await alice.put('/api/settings', { notify_inapp: false })).status, 200)
})

// ---------- 关于、退出 ----------
test('关于页：八项都有，模型名来自平台，不带数据库账号密码', async () => {
  const { text } = await alice.get('/about')
  for (const id of ['a-version', 'a-build', 'a-mode', 'a-data', 'a-db', 'a-model', 'a-node', 'a-att', 'a-used']) assert.ok(text.includes(`id="${id}"`), id)
  assert.ok(text.includes('通义千问 Max'))
  assert.match(text, /id="a-mode">平台</)
  assert.match(text, /id="a-db">MySQL /)
  assert.ok(!text.includes('mysql://'))
})

test('头像菜单：设置、关于、退出；退出链接带前缀', async () => {
  const { text } = await alice.get('/', { 'x-forwarded-prefix': '/apps/expiry' })
  const menu = text.slice(text.indexOf('yh-menu-list'), text.indexOf('</nav>', text.indexOf('yh-menu-list')))
  assert.deepEqual([...menu.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1]), ['settings', 'about', 'logout?redirect=/apps/expiry/'])
})

test('退出：清掉会话，跳平台退出；查询串里的 redirect 不决定跳哪', async () => {
  const c = await h.login(13)
  const r = await c.get('/logout?redirect=https://evil.test/')
  assert.equal(r.status, 302)
  assert.ok(r.headers.get('location').startsWith(`${h.platform.url}/logout`))
  assert.ok(!r.headers.get('location').includes('evil'))
  assert.equal((await c.get('/api/items')).status, 401)
})

// ---------- 导出 ----------
const download = async (qs) => alice.raw(`/export?${qs}`)

test('CSV：带 BOM、CRLF、列名固定', () => {
  const csv = toCsv([{ name: '合同', category: '保险', due_date: '2027-01-01', days: 3, owner: '李雷', amount: '100.50', note: '备注' }])
  assert.ok(csv.startsWith('﻿名称,分类,到期日,剩余天数,负责人,金额,备注\r\n'))
  assert.ok(csv.endsWith('合同,保险,2027-01-01,3,李雷,100.50,备注\r\n'))
})

test('CSV 转义：逗号、引号、换行', () => {
  assert.equal(csvCell('a,b'), '"a,b"')
  assert.equal(csvCell('说"明"'), '"说""明"""')
  assert.equal(csvCell('一\n二'), '"一\n二"')
  assert.equal(csvCell('普通'), '普通')
  assert.equal(csvCell(null), '')
})

test('CSV 防公式注入：文字格开头的 = + - @ 垫单引号，数字列的负数不动', () => {
  const csv = toCsv([{ name: '=SUM(A1)', category: '其他', due_date: '2020-01-01', days: -3, owner: '@x', amount: null, note: '+1' }])
  const line = csv.split('\r\n')[1]
  assert.equal(line, "'=SUM(A1),其他,2020-01-01,-3,'@x,,'+1")
})

test('Markdown：表格，竖线和换行不破坏结构', () => {
  const md = toMarkdown([{ name: 'a|b', category: '其他', due_date: null, days: null, owner: '', amount: null, note: '一\n二' }], '到期台账')
  assert.ok(md.startsWith('# 到期台账\n\n| 名称 | 分类 |'))
  assert.ok(md.includes('a\\|b'))
  assert.ok(md.includes('一 二'))
})

test('导出接口：全部 / 当前筛选，文件名是中文，内容是看得到的条目', async () => {
  await create(alice, { name: '保险单', category: '保险', amount: '1200' })
  await create(alice, { name: '执照', category: '营业执照', assignee_id: BOB })
  await create(bob, { name: '别人的' })
  const all = await download('scope=all&format=csv&cat=x')
  const text = all.body.toString('utf8')
  assert.equal(all.status, 200)
  assert.deepEqual([...all.body.subarray(0, 3)], [0xef, 0xbb, 0xbf])
  assert.match(all.headers.get('content-type'), /text\/csv/)
  assert.ok(all.headers.get('content-disposition').includes(encodeURIComponent('到期台账')))
  assert.ok(text.includes('保险单') && text.includes('执照') && text.includes('李雷') && !text.includes('别人的'))
  const some = (await download(`scope=filtered&format=csv&cat=${encodeURIComponent('保险')}`)).body.toString('utf8')
  assert.ok(some.includes('保险单') && !some.includes('执照'))
})

test('导出：缺日期的导出空日期，不写 null；Markdown 格式可下载', async () => {
  await alice.post('/api/import/commit', { items: [{ name: '缺日期', category: '其他', expire_at: '', note: null }] })
  const csv = (await download('scope=all&format=csv')).body.toString('utf8')
  assert.ok(csv.includes('缺日期,其他,,,,,'))
  assert.ok(!csv.includes('null'))
  const md = await download('scope=all&format=md')
  assert.match(md.headers.get('content-type'), /text\/markdown/)
  assert.ok(md.body.toString('utf8').includes('| 缺日期 |'))
})

test('导出：日历视图的「当前筛选」只导出选中的那一天', async () => {
  const d = addDays(today, 3)
  await create(alice, { name: '当天的', due_date: d })
  await create(alice, { name: '别天的', due_date: addDays(today, 4) })
  const text = (await download(`scope=filtered&format=csv&view=calendar&month=${d.slice(0, 7)}&day=${d}`)).body.toString('utf8')
  assert.ok(text.includes('当天的') && !text.includes('别天的'))
})

test('导出未登录走跳转，不给内容', async () => {
  assert.equal((await fetch(`${h.base}/export`, { redirect: 'manual' })).status, 302)
})

// ---------- 日历 ----------
test('日历格子：周一开头，整周，跨年', () => {
  assert.equal(monthWeeks('2026-11')[0][0], '2026-10-26')
  assert.equal(monthWeeks('2026-11').at(-1)[6], '2026-12-06')
  assert.deepEqual(monthRange('2028-02'), ['2028-02-01', '2028-02-29'])
  assert.equal(addMonths('2026-12', 1), '2027-01')
  assert.equal(addMonths('2026-01', -1), '2025-12')
})

test('日历上色取当天最紧急的档位，缺日期的不进格子', () => {
  const me = { id: 1, name: '我' }
  const row = (due) => decorate({ id: 1, owner_id: 1, name: 'x', due_date: due }, me, '2026-11-01')
  const weeks = calendarOf('2026-11', '2026-11-01', [row('2026-11-05'), row('2026-11-05'), row('2026-11-20'), row(null)], '2026-11-20')
  const days = weeks.flat()
  const on = (d) => days.find((x) => x.date === d)
  assert.equal(on('2026-11-05').count, 2)
  assert.equal(on('2026-11-05').tier, 'red')
  assert.equal(on('2026-11-20').tier, 'yellow')
  assert.equal(on('2026-11-20').selected, true)
  assert.equal(on('2026-11-01').isToday, true)
  assert.equal(on('2026-10-31').inMonth, false)
})

test('日历视图：有到期项的天能点，点某天只剩当天，缺日期的单列', async () => {
  const d = addDays(today, 2)
  await create(alice, { name: '当天的', due_date: d })
  await create(alice, { name: '别天的', due_date: addDays(today, 1) })
  await alice.post('/api/import/commit', { items: [{ name: '缺日期的', category: '其他', expire_at: '' }] })
  const month = d.slice(0, 7)
  const page = (await alice.get(`/api/board.html?view=calendar&month=${month}`)).text
  assert.ok(page.includes(`data-date="${d}"`))
  assert.ok(page.includes('待补到期日 · 1'))
  const one = (await alice.get(`/api/board.html?view=calendar&month=${month}&day=${d}`)).text
  const list = one.slice(one.indexOf('id="items"'), one.indexOf('id="undated"'))
  assert.ok(list.includes('当天的') && !list.includes('别天的'))
})

test('日历查询串乱写不报错，退回本月', async () => {
  await create(alice)
  const r = await alice.get('/api/board.html?view=calendar&month=2026-13&day=abc')
  assert.equal(r.status, 200)
  assert.ok(r.text.includes(`${Number(today.slice(0, 4))} 年 ${Number(today.slice(5, 7))} 月`))
})

test('切换视图的链接保留分类，回列表时带走日历参数', () => {
  const href = hrefOf({ category: '保险', who: '', window: '', view: 'calendar', month: '2026-12', day: '2026-12-05' }, '2026-11')
  assert.equal(href({ view: 'list' }), `?cat=${encodeURIComponent('保险')}`)
  assert.ok(href({ day: '' }).includes('month=2026-12') && !href({ day: '' }).includes('day='))
})

// ---------- 右侧栏 ----------
test('右侧栏：本月到期、分类分布、最近新增，不跟筛选走', async () => {
  await create(alice, { name: '本月的', category: '保险', due_date: today })
  await create(alice, { name: '下一年的', category: '保险', due_date: addDays(today, 400) })
  const { text } = await alice.get(`/api/board.html?cat=${encodeURIComponent('营业执照')}`)
  assert.ok(text.includes('本月到期 · <span id="rail-month-total">1</span>'))
  assert.ok(text.includes('2 项'))
  assert.ok(text.slice(text.indexOf('rail-recent')).includes('下一年的'))
})

test('右侧栏只算看得到的条目', async () => {
  await create(bob, { name: '别人的秘密' })
  assert.ok(!(await alice.get('/api/board.html')).text.includes('别人的秘密'))
})

test('空台账：一句话加一个导入按钮', async () => {
  const { text } = await alice.get('/api/board.html')
  const empty = text.slice(text.indexOf('yh-empty'), text.indexOf('</div>', text.indexOf('yh-empty')))
  assert.ok(empty.includes('href="import"'))
  assert.equal(empty.split('<a ').length - 1, 1)
})
