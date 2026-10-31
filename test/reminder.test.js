import test, { after, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createPool, ensureSchema } from '../src/db.js'
import { createItems } from '../src/items.js'
import { addDays } from '../src/dates.js'
import { alreadyReminded, buildMessage, createReminder, scan } from '../src/reminder.js'

const TZ = 'Asia/Shanghai'
const today = '2026-10-30'
const at = (s) => new Date(s)
const NINE = at('2026-10-30T01:00:00Z') // 上海 09:00

let pool, items
before(async () => {
  pool = createPool(process.env.TEST_DATABASE_URL)
  await ensureSchema(pool)
  items = createItems({ pool })
})
after(() => pool.end())
beforeEach(() => pool.query('DELETE FROM expiry_item'))

const fakeNotifier = (behave = (m) => ({ sent: [{ userId: m.userIds[0], channel: 'dingtalk' }], skipped: [] })) => {
  const sent = []
  return { available: true, sent, send: async (m) => { sent.push(m); return behave(m) }, probe: async () => 'ok' }
}
const add = (userId, name, due, extra = {}) => items.create(userId, { name, due_date: due, ...extra })
const row = async (id) => (await pool.query('SELECT last_notified_at, last_notified_tier FROM expiry_item WHERE id = ?', [id]))[0][0]

test('已过期和进了提醒期的汇总成一条，没到提醒期的不提醒', async () => {
  await add(21, '过期的', addDays(today, -5))
  await add(21, '今天的', today)
  await add(21, '20 天后', addDays(today, 20))
  await add(21, '60 天后', addDays(today, 60))
  await add(21, '60 天后但提前 90', addDays(today, 60), { remind_days: 90 })
  const n = fakeNotifier()
  const r = await scan({ items, notifier: n, today, now: NINE, tz: TZ })
  assert.equal(n.sent.length, 1)
  assert.equal(r.sent, 1)
  const c = n.sent[0].content
  assert.match(c, /已过期 5 天：过期的/)
  assert.match(c, /今天到期：今天的/)
  assert.match(c, /20 天后：20 天后/)
  assert.match(c, /60 天后但提前 90/)
  assert.ok(!c.includes('：60 天后\n') && !c.endsWith('：60 天后'))
})

test('提醒天数边界：正好等于提醒天数要提醒，多一天不提醒；0 天只在当天提醒', async () => {
  await add(21, '正好', addDays(today, 10), { remind_days: 10 })
  await add(21, '差一天', addDays(today, 11), { remind_days: 10 })
  await add(21, '当天才提醒', today, { remind_days: 0 })
  await add(21, '明天但不提前', addDays(today, 1), { remind_days: 0 })
  const n = fakeNotifier()
  await scan({ items, notifier: n, today, now: NINE, tz: TZ })
  assert.match(n.sent[0].content, /正好/)
  assert.match(n.sent[0].content, /当天才提醒/)
  assert.ok(!n.sent[0].content.includes('差一天'))
  assert.ok(!n.sent[0].content.includes('明天但不提前'))
})

test('按负责人分组：有负责人发负责人，没有发创建人', async () => {
  await add(21, '自己的', today)
  await add(21, '派给 22', today, { assignee_id: 22 })
  const n = fakeNotifier()
  const r = await scan({ items, notifier: n, today, now: NINE, tz: TZ })
  assert.equal(r.users, 2)
  const byUser = Object.fromEntries(n.sent.map((m) => [m.userIds[0], m.content]))
  assert.match(byUser[21], /自己的/)
  assert.ok(!byUser[21].includes('派给 22'))
  assert.match(byUser[22], /派给 22/)
})

test('去重：同一天第二次扫描不再提醒', async () => {
  await add(21, 'A', today)
  const n = fakeNotifier()
  await scan({ items, notifier: n, today, now: NINE, tz: TZ })
  const r = await scan({ items, notifier: n, today, now: at('2026-10-30T05:00:00Z'), tz: TZ })
  assert.equal(n.sent.length, 1)
  assert.equal(r.users, 0)
})

test('去重：第二天同一档位还会提醒', async () => {
  await add(21, 'A', addDays(today, 3))
  const n = fakeNotifier()
  await scan({ items, notifier: n, today, now: NINE, tz: TZ })
  await scan({ items, notifier: n, today: addDays(today, 1), now: at('2026-10-31T01:00:00Z'), tz: TZ })
  assert.equal(n.sent.length, 2)
})

test('去重：同一天档位变化后可再提醒', async () => {
  const it = await add(21, 'A', addDays(today, 20))
  const n = fakeNotifier()
  await scan({ items, notifier: n, today, now: NINE, tz: TZ })
  assert.equal((await row(it.id)).last_notified_tier, 'yellow')
  await items.update(21, it.id, { due_date: addDays(today, -1) }) // 改成已过期
  await scan({ items, notifier: n, today, now: at('2026-10-30T02:00:00Z'), tz: TZ })
  assert.equal(n.sent.length, 2)
  assert.match(n.sent[1].content, /已过期 1 天/)
  assert.equal((await row(it.id)).last_notified_tier, 'expired')
})

test('去重按当地日期算：UTC 同一天、上海跨了一天算两天', () => {
  const r = { last_notified_tier: 'red', last_notified_at: at('2026-10-30T15:59:00Z') } // 上海 23:59
  assert.equal(alreadyReminded(r, 'red', '2026-10-30', TZ), true)
  assert.equal(alreadyReminded(r, 'red', '2026-10-31', TZ), false)
})

test('平台说 skipped：没收到就不记成已提醒', async () => {
  const it = await add(21, 'A', today)
  const n = fakeNotifier((m) => ({ sent: [], skipped: [{ userId: m.userIds[0], reason: '没有绑定账号' }] }))
  const r = await scan({ items, notifier: n, today, now: NINE, tz: TZ })
  assert.equal(r.sent, 0)
  assert.equal(r.skipped, 1)
  assert.equal(r.reason, '没有绑定账号')
  assert.equal((await row(it.id)).last_notified_at, null)
})

test('一个人发送失败不影响别人，失败的人不记档', async () => {
  const a = await add(21, 'A', today)
  const b = await add(22, 'B', today)
  const n = fakeNotifier((m) => {
    if (m.userIds[0] === 21) throw new Error('超时')
    return { sent: [{ userId: 22 }], skipped: [] }
  })
  const r = await scan({ items, notifier: n, today, now: NINE, tz: TZ })
  assert.equal(r.sent, 1)
  assert.equal(r.failed, 1)
  assert.equal((await row(a.id)).last_notified_at, null)
  assert.ok((await row(b.id)).last_notified_at)
})

test('定时：09:00 之前不扫，之后当天只扫一次，第二天再扫', async () => {
  await add(21, 'A', addDays(today, -1))
  const n = fakeNotifier()
  const rem = createReminder({ items, notifier: n, tz: TZ })
  assert.equal(await rem.tick(at('2026-10-30T00:59:00Z')), null) // 上海 08:59
  assert.equal(n.sent.length, 0)
  assert.ok(await rem.tick(NINE))
  assert.equal(n.sent.length, 1)
  await add(21, 'B', addDays(today, -1))
  assert.equal(await rem.tick(at('2026-10-30T02:00:00Z')), null) // 当天再醒来不扫，下午录的第二天才提醒
  assert.equal(n.sent.length, 1)
  assert.ok(await rem.tick(at('2026-10-31T01:00:00Z')))
  assert.equal(n.sent.length, 2)
})

test('定时：错过 09:00（进程当时没活着）当天补一次', async () => {
  await add(21, 'A', today)
  const n = fakeNotifier()
  const rem = createReminder({ items, notifier: n, tz: TZ })
  assert.ok(await rem.tick(at('2026-10-30T06:30:00Z'))) // 上海 14:30
  assert.equal(n.sent.length, 1)
})

test('定时：网络失败下一小时重试，已发出的人不重复', async () => {
  await add(21, 'A', today)
  await add(22, 'B', today)
  let down = true
  const n = fakeNotifier((m) => {
    if (down && m.userIds[0] === 22) throw new Error('超时')
    return { sent: [{ userId: m.userIds[0] }], skipped: [] }
  })
  const rem = createReminder({ items, notifier: n, tz: TZ })
  await rem.tick(NINE)
  down = false
  await rem.tick(at('2026-10-30T02:00:00Z'))
  assert.deepEqual(n.sent.map((m) => m.userIds[0]), [21, 22, 22])
})

test('未配置：不查库、不发送、不记档', async () => {
  const it = await add(21, 'A', today)
  const n = { ...fakeNotifier(), available: false }
  const rem = createReminder({ items, notifier: n, tz: TZ })
  assert.equal(await rem.tick(NINE), null)
  assert.equal(n.sent.length, 0)
  assert.equal((await row(it.id)).last_notified_at, null)
})

test('消息不超平台长度限制', () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({ name: '长'.repeat(200) + i, due_date: today }))
  const m = buildMessage(1, rows, today, '')
  assert.ok(m.content.length <= 2000)
  assert.ok(m.title.length <= 80)
  assert.match(m.content, /还有 180 条/)
})
