import { z } from 'zod'

export const loginSchema = z.object({ email: z.string().email().transform((v) => v.toLowerCase()), password: z.string().min(8).max(128) })
export const changePasswordSchema = z.object({ currentPassword:z.string().min(8).max(128), newPassword:z.string().min(8).max(128) }).refine(value=>value.currentPassword!==value.newPassword,{message:'New password must be different',path:['newPassword']})
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80)
const templateKeys = ['editorial','ember','bistro','express','sage','world-plate','future-neon','future-hologram','future-paper','future-cyber','future-aurora','future-quantum','future-solar','future-lunar','future-bio','future-chrome','future-void','future-prism','future-synth','future-crystal','future-plasma','future-zen','future-circuit','future-cosmos','future-flux','future-oasis']
const menuItemSchema = z.object({ name:z.string().trim().min(2).max(160), slug, description:z.string().trim().max(1000).optional(), imageUrl:z.string().url().optional().or(z.literal('')), price:z.coerce.number().min(0).max(10_000_000), preparationMinutes:z.coerce.number().int().min(0).max(1440).default(20), featured:z.boolean().default(false) })
const categorySchema = z.object({ name:z.string().trim().min(2).max(160), slug, description:z.string().trim().max(500).optional(), items:z.array(menuItemSchema).max(50).default([]) })
const offerSchema = z.object({ name:z.string().trim().min(2).max(160), description:z.string().trim().max(1000).optional(), offerType:z.enum(['percentage','fixed','combo','time_based','day_based']).default('percentage'), discountValue:z.coerce.number().min(0).max(10_000_000).default(0) })
export const bootstrapSchema = loginSchema.extend({
  displayName: z.string().min(2).max(120),
  tenantName: z.string().min(2).max(160),
  tenantSlug: slug,
  restaurantName: z.string().min(2).max(160),
  restaurantSlug: slug,
  outletName: z.string().min(2).max(160),
  outletSlug: slug,
  templateKey: z.enum(templateKeys).default('editorial'),
  themeKey: z.enum(['coral','saffron','olive']).default('coral'),
  profile: z.object({ tagline:z.string().trim().max(240).optional(), description:z.string().trim().max(2000).optional(), coverImageUrl:z.string().url().optional().or(z.literal('')), phone:z.string().trim().max(40).optional(), email:z.string().email().optional().or(z.literal('')), chefName:z.string().trim().max(120).optional() }).optional(),
  categories: z.array(categorySchema).max(20).default([]),
  offers: z.array(offerSchema).max(10).default([]),
})
