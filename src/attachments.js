// 附件落盘。盘上的文件名全部由服务端生成（<id>-<hash>.<ext>），用户给的文件名只进数据库和 Content-Disposition
import { createHash } from 'node:crypto'
import { chownSync, mkdirSync, readdirSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { HttpError } from './items.js'

export const MAX_BYTES = 10 * 1024 * 1024
export const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.docx'
const FILENAME_MAX = 200
const NODE_ID = 1000 // node 官方镜像里 node 用户的 uid / gid
const INLINE = new Set(['pdf', 'png', 'jpg', 'webp'])
const STORED_RE = /^\d+-[0-9a-f]{16}\.(pdf|png|jpg|webp|docx)$/
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

const starts = (buf, bytes, at = 0) => buf.length >= at + bytes.length && bytes.every((b, i) => buf[at + i] === b)
const ascii = (s) => [...Buffer.from(s, 'latin1')]

// 类型看文件头，不信扩展名和浏览器给的 Content-Type
const TYPES = {
  pdf: { mime: 'application/pdf', sniff: (b) => starts(b, ascii('%PDF-')) },
  png: { mime: 'image/png', sniff: (b) => starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
  jpg: { mime: 'image/jpeg', sniff: (b) => starts(b, [0xff, 0xd8, 0xff]) },
  webp: { mime: 'image/webp', sniff: (b) => starts(b, ascii('RIFF')) && starts(b, ascii('WEBP'), 8) },
  // docx 是 zip，光看 PK 头分不出来；压缩包里的文件名不压缩，直接找得到
  docx: { mime: DOCX_MIME, sniff: (b) => starts(b, [0x50, 0x4b, 0x03, 0x04]) && b.includes('[Content_Types].xml') && b.includes('word/') }
}
const EXT_ALIAS = { jpeg: 'jpg' }

/** 校验用户给的文件名，返回规范化的扩展名。带路径分隔符、控制字符的直接拒，不做清洗后放行 */
export function checkFilename(name) {
  if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, '缺少文件名')
  if ([...name].length > FILENAME_MAX) throw new HttpError(400, `文件名不能超过 ${FILENAME_MAX} 字`)
  if (/[/\\\u0000-\u001f\u007f]/.test(name) || name === '..') throw new HttpError(400, '文件名不合法')
  const raw = path.extname(name).slice(1).toLowerCase()
  const ext = EXT_ALIAS[raw] ?? raw
  if (!TYPES[ext]) throw new HttpError(400, '只支持 PDF、PNG、JPG、WebP、DOCX')
  return ext
}

export function checkContent(buffer, ext) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw new HttpError(400, '文件是空的')
  if (buffer.length > MAX_BYTES) throw new HttpError(413, '附件不能超过 10MB')
  if (!TYPES[ext].sniff(buffer)) throw new HttpError(400, '文件内容和扩展名对不上')
}

/** 浏览器里预览 PDF 和图片，docx 直接下载。filename* 给中文名，filename 给老客户端 */
export function contentDisposition(name, ext) {
  const fallback = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `${INLINE.has(ext) ? 'inline' : 'attachment'}; filename="${fallback}"; filename*=UTF-8''${encoded}`
}

/** 数据库里的文件名也按白名单过一遍再拼路径，库被写坏也出不了附件目录 */
export function storedExt(file) {
  const m = STORED_RE.exec(String(file))
  if (!m) throw new HttpError(404, '附件不存在')
  return m[1]
}

export function createAttachments(dataDir) {
  const root = path.resolve(dataDir, 'attachments')

  async function save(id, filename, buffer) {
    const ext = checkFilename(filename)
    checkContent(buffer, ext)
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16)
    const file = `${id}-${hash}.${ext}`
    const tmp = path.join(root, `.tmp-${id}-${process.pid}-${Date.now()}`)
    try {
      await mkdir(root, { recursive: true })
      await writeFile(tmp, buffer, { mode: 0o640 })
      await rename(tmp, path.join(root, file))
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => {})
      console.error(`[expiry] 附件写盘失败：${e.code || e.message}`)
      throw new HttpError(503, '附件暂时存不了，请联系管理员')
    }
    return { name: filename, file, mime: TYPES[ext].mime, size: buffer.length }
  }

  async function remove(file) {
    if (!file) return
    storedExt(file)
    await rm(path.join(root, file), { force: true }).catch((e) => console.warn(`[expiry] 附件删除失败：${e.code || e.message}`))
  }

  return { root, save, remove }
}

/**
 * 平台把宿主机目录绑定挂到 /data，服务器上属主是 root，镜像里 chown 不管用。
 * 以 root 启动时只接管 attachments（不碰 /data 本身，文档提醒过别 chown -R /data），然后降到 node
 */
export function dropRoot(dataDir) {
  if (process.getuid?.() !== 0) return false
  const root = path.resolve(dataDir, 'attachments')
  mkdirSync(root, { recursive: true })
  chownSync(root, NODE_ID, NODE_ID)
  for (const f of readdirSync(root)) chownSync(path.join(root, f), NODE_ID, NODE_ID)
  process.setgroups([NODE_ID])
  process.setgid(NODE_ID)
  process.setuid(NODE_ID)
  return true
}
