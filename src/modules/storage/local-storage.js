import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve, sep } from 'node:path'
import { config } from '../../config.js'

const root = resolve(config.LOCAL_STORAGE_PATH)
const safePath = (key) => {
  const target = resolve(root, key)
  if (!target.startsWith(`${root}${sep}`)) throw new Error('Invalid storage key')
  return target
}

export class LocalStorage {
  async put(key, body) {
    const target = safePath(key)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, body, { flag: 'wx' })
    return { key, url: `${config.LOCAL_STORAGE_PUBLIC_URL.replace(/\/$/, '')}/${key}` }
  }
  async remove(key) { await unlink(safePath(key)) }
}
