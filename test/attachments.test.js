import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_BYTES, checkContent, checkFilename, contentDisposition, storedExt } from '../src/attachments.js'

const PDF = Buffer.from('%PDF-1.7\n')
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')])
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('[Content_Types].xml word/document.xml')])

test('白名单类型都放行，.jpeg 归到 jpg，大小写不敏感', () => {
  assert.equal(checkFilename('合同.pdf'), 'pdf')
  assert.equal(checkFilename('a.PNG'), 'png')
  assert.equal(checkFilename('a.jpeg'), 'jpg')
  assert.equal(checkFilename('a.webp'), 'webp')
  assert.equal(checkFilename('a.docx'), 'docx')
})

test('白名单之外的类型被拒', () => {
  for (const n of ['a.exe', 'a.html', 'a.svg', 'a.doc', 'a.pdf.js', 'noext']) assert.throws(() => checkFilename(n), /只支持/, n)
})

test('路径穿越和控制字符被拒，不做清洗后放行', () => {
  for (const n of ['../../etc/passwd.pdf', '..\\..\\a.pdf', '/etc/a.pdf', 'a/b.pdf', 'a\r\nX: y.pdf', 'a\u0000.pdf', '..']) {
    assert.throws(() => checkFilename(n), /文件名不合法/, JSON.stringify(n))
  }
})

test('内容要和扩展名对得上', () => {
  checkContent(PDF, 'pdf'); checkContent(PNG, 'png'); checkContent(JPG, 'jpg'); checkContent(WEBP, 'webp'); checkContent(DOCX, 'docx')
  assert.throws(() => checkContent(Buffer.from('<html><script>'), 'pdf'), /对不上/)
  assert.throws(() => checkContent(PNG, 'jpg'), /对不上/)
})

test('普通 zip 改名 docx 被拒', () => {
  assert.throws(() => checkContent(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), 'docx'), /对不上/)
})

test('空文件和超限被拒，正好 10MB 放行', () => {
  assert.throws(() => checkContent(Buffer.alloc(0), 'pdf'), /空的/)
  const exact = Buffer.alloc(MAX_BYTES)
  PDF.copy(exact)
  checkContent(exact, 'pdf')
  assert.throws(() => checkContent(Buffer.concat([exact, Buffer.alloc(1)]), 'pdf'), /10MB/)
})

test('Content-Disposition：中文名走 filename*，PDF 内联、docx 下载', () => {
  const v = contentDisposition('租赁 合同(1).pdf', 'pdf')
  assert.ok(v.startsWith('inline; filename="__ __(1).pdf"'))
  assert.ok(v.includes(`filename*=UTF-8''${encodeURIComponent('租赁 合同').replace(/%20/g, '%20')}%281%29.pdf`))
  assert.ok(contentDisposition('a.docx', 'docx').startsWith('attachment;'))
})

test('Content-Disposition：引号不能破坏头', () => {
  assert.ok(contentDisposition('a"b.pdf', 'pdf').startsWith('inline; filename="a_b.pdf";'))
})

test('数据库里的文件名被写坏也拼不出目录外的路径', () => {
  assert.equal(storedExt('12-0123456789abcdef.pdf'), 'pdf')
  for (const f of ['../../etc/passwd', '12-0123456789abcdef.pdf/../x', '12-xyz.pdf', '12-0123456789abcdef.exe', '']) assert.throws(() => storedExt(f), /不存在/, f)
})
