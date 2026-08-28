import { config } from '../../config.js'

export class SupabaseStorage {
  constructor() {
    this.baseUrl = config.SUPABASE_URL.replace(/\/$/, '')
    this.bucket = config.STORAGE_BUCKET
    this.headers = { authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`, apikey: config.SUPABASE_SERVICE_ROLE_KEY }
  }

  async put(key, body, contentType) {
    const response = await fetch(`${this.baseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}`, {
      method: 'POST', headers: { ...this.headers, 'content-type': contentType, 'x-upsert': 'false' }, body,
    })
    if (!response.ok) throw new Error(`Storage upload failed (${response.status}): ${await response.text()}`)
    return { key, url: `${this.baseUrl}/storage/v1/object/public/${encodeURIComponent(this.bucket)}/${key.split('/').map(encodeURIComponent).join('/')}` }
  }

  async remove(key) {
    const response = await fetch(`${this.baseUrl}/storage/v1/object/${encodeURIComponent(this.bucket)}`, {
      method: 'DELETE', headers: { ...this.headers, 'content-type': 'application/json' }, body: JSON.stringify({ prefixes: [key] }),
    })
    if (!response.ok) throw new Error(`Storage deletion failed (${response.status}): ${await response.text()}`)
  }
}
