// 每日提醒：每个整点醒一次。每人几点收在设置里配，到点之后当天第一次醒来时发（重启后也能补上）。
// 进程内定时器，没有外部定时服务。发不出去绝不记成已提醒：平台说 skipped 的人没收到，下一天还会再试
import { clockIn, daysLeft, daysText, tierOf, todayIn, tzName } from './dates.js'

const HOUR_MS = 3600_000
const MAX_ITEMS = 20
const NAME_CLIP = 60
const PROBE_TIMEOUT_MS = 3000
const SEND_TIMEOUT_MS = 10_000

/** 平台的 /api/open/notify。不走 ws.call：它把 HTTP 状态吞了，这里要分清 403（没权限）和别的失败 */
export function createNotifier(ws) {
  const available = !!(ws.clientId && ws.clientSecret)
  const post = (body, timeoutMs) => fetch(`${ws.apiUrl}/api/open/notify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: ws.basic() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })

  async function send(message) {
    const r = await post(message, SEND_TIMEOUT_MS)
    const body = await r.json().catch(() => ({}))
    if (r.status === 401 || r.status === 403) {
      const e = new Error(body.message || '应用没有发消息的权限')
      e.forbidden = true
      throw e
    }
    if (body.code !== 0) throw new Error(body.message || `平台返回 HTTP ${r.status}`)
    return { sent: body.data?.sent ?? [], skipped: body.data?.skipped ?? [] }
  }

  /** 空名单不会发出任何消息：平台先查权限（403），再查参数（400），用来免费探测这个应用能不能发 */
  async function probe() {
    if (!available) return 'unconfigured'
    try {
      const r = await post({ userIds: [] }, PROBE_TIMEOUT_MS)
      if (r.status === 401 || r.status === 403) return 'forbidden'
      return r.status === 400 ? 'ok' : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  return { available, send, probe }
}

/** 同一条目同一档位，一天只提醒一次。last_notified_at 存的是 UTC，要换回当地日期再比 */
export function alreadyReminded(row, tier, today, tz = tzName()) {
  return row.last_notified_tier === tier && !!row.last_notified_at && todayIn(tz, row.last_notified_at) === today
}

export function buildMessage(userId, items, today, url) {
  const expired = items.filter((t) => daysLeft(t.due_date, today) < 0).length
  const lines = items.slice(0, MAX_ITEMS).map((t) => `- ${daysText(daysLeft(t.due_date, today))}：${[...t.name].slice(0, NAME_CLIP).join('')}`)
  if (items.length > MAX_ITEMS) lines.push(`- 还有 ${items.length - MAX_ITEMS} 条`)
  const title = expired ? `${items.length} 项到期提醒，其中 ${expired} 项已过期` : `${items.length} 项快到期了`
  return { userIds: [userId], title, content: lines.join('\n'), ...(url ? { url } : {}) }
}

/**
 * 扫一轮：一人一条汇总。单人失败不影响别人；没发出去的不记档，改天还会提醒。
 * hour 给了就只发到点的人；skip 是今天已经处理过的人。关了平台通知的人不发
 */
export async function scan({ items, notifier, url, today, now = new Date(), tz = tzName(), hour = 24, skip = new Set() }) {
  const fresh = (await items.dueForReminder(today))
    .filter((r) => r.notify_platform && r.remind_hour <= hour && !skip.has(r.user_id))
    .map((r) => ({ ...r, tier: tierOf(daysLeft(r.due_date, today)) }))
    .filter((r) => !alreadyReminded(r, r.tier, today, tz))
  const byUser = new Map()
  for (const r of fresh) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, [])
    byUser.get(r.user_id).push(r)
  }

  const result = { users: byUser.size, sent: 0, skipped: 0, failed: 0, forbidden: false, reason: '', done: [] }
  for (const [userId, list] of byUser) {
    let out
    try {
      out = await notifier.send(buildMessage(userId, list, today, url))
    } catch (e) {
      console.warn(`[expiry] 到期提醒发送失败：${e.message}`)
      result.failed++
      result.reason = e.message
      if (e.forbidden) { result.forbidden = true; break } // 没权限，后面的人也发不出去
      continue
    }
    result.done.push(userId)
    if (!out.sent.some((s) => s.userId === userId)) {
      result.skipped++
      result.reason = out.skipped[0]?.reason ?? '平台没有发出'
      continue
    }
    result.sent++
    for (const tier of new Set(list.map((r) => r.tier))) {
      await items.markNotified(list.filter((r) => r.tier === tier).map((r) => r.id), tier, now)
    }
  }
  return result
}

export function createReminder({ items, notifier, url = '', tz = tzName() }) {
  let day = null
  let doneUsers = new Set() // 今天已经处理过的人：有人早上收过，下午录的第二天才提醒
  let stopped = false // 平台 403：今天后面的人也发不出去
  let last = null

  /** 定时器每次醒来调这个。网络类失败当天下一小时重试（已发出的人有逐条去重，不会重复） */
  async function tick(now = new Date()) {
    if (!notifier.available) return null
    const today = todayIn(tz, now)
    if (day !== today) { day = today; doneUsers = new Set(); stopped = false }
    if (stopped) return null
    const result = await scan({ items, notifier, url, today, now, tz, hour: clockIn(tz, now).hour, skip: doneUsers })
    if (!result.users) return null
    last = { ...result, at: now, today }
    for (const id of result.done) doneUsers.add(id)
    if (result.forbidden) stopped = true
    console.log(`[expiry] 到期提醒：发出 ${result.sent}/${result.users} 人`)
    return result
  }

  function start() {
    const run = () => tick().catch((e) => console.warn(`[expiry] 到期提醒失败：${e.message}`))
    run()
    // 对齐到整点，设了 9 点的人不会拖到 9 点 50
    setTimeout(() => { run(); setInterval(run, HOUR_MS).unref() }, HOUR_MS - Date.now() % HOUR_MS).unref()
    console.log(notifier.available ? `[expiry] 到期提醒已开启（${tz}，每人几点在设置里配）` : '[expiry] 未配置平台凭证，不会主动提醒')
  }

  /** 设置页用。只有确认能发才说已配置，不把「没报错」当成「发出去了」 */
  async function status({ remind_hour: remindHour = 9, notify_platform: enabled = true } = {}) {
    if (!enabled) return { state: 'off', text: '平台通知已关闭', detail: '不会往钉钉、飞书、企业微信发提醒。下面的开关可以重新打开。', last }
    const hour = `每天 ${String(remindHour).padStart(2, '0')}:00（${tz}）`
    const probe = await notifier.probe()
    if (probe === 'unconfigured') return { state: 'off', text: '未配置，不会主动提醒', detail: '应用没有拿到平台凭证。', last }
    if (probe === 'forbidden') return { state: 'off', text: '未配置，不会主动提醒', detail: '只有管理员安装或登记的应用才能经平台发消息。', last }
    if (probe === 'unknown') return { state: 'unknown', text: '暂时查不到提醒状态', detail: '平台连不上，稍后再看。', last }
    if (last && !last.sent && last.skipped && !last.failed) return { state: 'off', text: '未配置，不会主动提醒', detail: `上次一条都没发出：${last.reason}`, last }
    return { state: 'on', text: `已开启，${hour}扫一遍`, detail: '发给负责人；没指定负责人的发给创建人。', last }
  }

  return { tick, start, status }
}
