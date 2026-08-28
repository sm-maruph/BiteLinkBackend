import { randomUUID } from 'node:crypto'
import { extname } from 'node:path'
import { config } from '../../config.js'
import { LocalStorage } from './local-storage.js'
import { SupabaseStorage } from './supabase-storage.js'

const provider = config.STORAGE_PROVIDER === 'local' ? new LocalStorage() : new SupabaseStorage()
const allowedMime = new Set(config.STORAGE_ALLOWED_MIME.split(',').map((value) => value.trim()))
const extensionByMime = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/avif': '.avif' }

export async function uploadRestaurantAsset({ tenantId, restaurantId, file }) {
  if (!allowedMime.has(file.mimetype)) throw Object.assign(new Error('unsupported_file_type'), { statusCode: 415 })
  const body = await file.toBuffer()
  if (body.length > config.STORAGE_MAX_BYTES) throw Object.assign(new Error('file_too_large'), { statusCode: 413 })
  const extension = extensionByMime[file.mimetype] || extname(file.filename).toLowerCase()
  const key = `tenants/${tenantId}/restaurants/${restaurantId}/${randomUUID()}${extension}`
  return provider.put(key, body, file.mimetype)
}

export async function deleteRestaurantAsset({ tenantId, restaurantId, key }) {
  if (!key.startsWith(`tenants/${tenantId}/restaurants/${restaurantId}/`)) throw Object.assign(new Error('invalid_storage_key'), { statusCode: 403 })
  await provider.remove(key)
}
