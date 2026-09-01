import 'dotenv/config'
import { z } from 'zod'

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true')

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  FRONTEND_ORIGIN: z.string().default('http://localhost:5173'),
  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: booleanFromString.default('true'),
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(10),
  ACCESS_TOKEN_SECRET: z.string().min(32),
  TABLE_QR_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: booleanFromString.default('false'),
  BOOTSTRAP_TOKEN: z.string().min(32),
  STORAGE_PROVIDER: z.enum(['supabase', 'local']).default('supabase'),
  STORAGE_BUCKET: z.string().min(1).default('BiteLinkQR'),
  STORAGE_MAX_BYTES: z.coerce.number().int().positive().default(5_242_880),
  STORAGE_ALLOWED_MIME: z.string().default('image/jpeg,image/png,image/webp,image/avif'),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  LOCAL_STORAGE_PATH: z.string().default('./uploads'),
  LOCAL_STORAGE_PUBLIC_URL: z.string().url().default('http://127.0.0.1:4000/uploads'),
  ALLOW_DEMO_AUTH: booleanFromString.default('false'),
  DATABASE_SSL_REJECT_UNAUTHORIZED: booleanFromString.default('true'),
  TRUST_PROXY: booleanFromString.default('false'),
}).superRefine((value, context) => {
  if (value.STORAGE_PROVIDER === 'supabase' && (!value.SUPABASE_URL || !value.SUPABASE_SERVICE_ROLE_KEY)) {
    context.addIssue({ code: 'custom', message: 'Supabase storage requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY' })
  }
})

const parsed = schema.safeParse(process.env)
if (!parsed.success) {
  throw new Error(`Invalid environment configuration: ${z.prettifyError(parsed.error)}`)
}

export const config = parsed.data
