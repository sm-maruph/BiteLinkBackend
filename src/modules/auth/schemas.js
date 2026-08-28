import { z } from 'zod'

export const loginSchema = z.object({ email: z.string().email().transform((v) => v.toLowerCase()), password: z.string().min(8).max(128) })
export const bootstrapSchema = loginSchema.extend({
  displayName: z.string().min(2).max(120),
  tenantName: z.string().min(2).max(160),
  tenantSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  restaurantName: z.string().min(2).max(160),
  restaurantSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  outletName: z.string().min(2).max(160),
  outletSlug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),
  templateKey: z.enum(['editorial','ember','future-neon','bistro','express','sage','world-plate']).default('editorial'),
  themeKey: z.enum(['coral','saffron','olive']).default('coral'),
})
