// 标题截断：不落在括号里。脚本加载时不碰 DOM，test/title.test.js 直接跑 cutTitle
const OPENERS = '（('
const CLOSERS = '）)'

/** 最多 max 字（含 …）。切点在括号里就把整段括号去掉，不留 `（含二零…`；整个标题都在括号里时去掉就没字了，只能照切 */
function cutTitle(name, max) {
  const chars = [...name]
  if (chars.length <= max) return name
  const head = chars.slice(0, max - 1)
  let depth = 0
  let open = 0
  head.forEach((c, i) => {
    if (OPENERS.includes(c)) { if (depth++ === 0) open = i } else if (CLOSERS.includes(c) && depth) depth--
  })
  const kept = (depth ? head.slice(0, open) : head).join('').trimEnd()
  return `${kept || head.join('')}…`
}

const overflowed = (el) => el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth

/** 放不下的标题自己切，不交给 CSS：CSS 只会切在行尾。data-fit 是字数上限，全文留在 data-full，窗口变宽时能放回来 */
function fitTitles() {
  for (const el of document.querySelectorAll('[data-fit]')) {
    el.dataset.full ??= el.textContent
    const full = el.dataset.full
    const cap = Number(el.dataset.fit)
    el.textContent = cutTitle(full, cap)
    if (!overflowed(el)) continue
    let low = 1
    let high = Math.min(cap, [...full].length) - 1
    while (low < high) {
      const mid = Math.ceil((low + high) / 2)
      el.textContent = cutTitle(full, mid)
      if (overflowed(el)) high = mid - 1
      else low = mid
    }
    el.textContent = cutTitle(full, low)
  }
}
