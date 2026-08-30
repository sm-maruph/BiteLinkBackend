import { z } from 'zod'

export const uuid = z.string().uuid()
export const pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
})
export const menuQuery = pagination.extend({
  restaurantId: uuid,
  outletId: uuid.optional(),
  categoryId: uuid.optional(),
})
export const orderBody = z.object({
  restaurantId: uuid,
  outletId: uuid,
  tableId: uuid,
  sessionId: uuid,
  notes: z.string().max(1000).optional(),
  items: z.array(z.object({ menuItemId: uuid, quantity: z.number().int().min(1).max(99) })).min(1).max(100),
})
export const statusBody = z.object({
  status: z.enum(['confirmed', 'preparing', 'ready', 'serving', 'served', 'completed', 'cancelled', 'rejected']),
  note: z.string().max(500).optional(),
  estimatedMinutes: z.coerce.number().int().min(1).max(240).optional(),
})
export const roleBody = z.object({ code:z.string().regex(/^[a-z][a-z0-9_]{1,49}$/), name:z.string().trim().min(2).max(100), description:z.string().trim().max(500).optional(), scope:z.enum(['tenant','restaurant','outlet']), permissions:z.array(z.string().min(1).max(100)).min(1).max(100), restaurantId:uuid.optional(), outletId:uuid.optional() })
export const roleAssignmentBody = z.object({ membershipId:uuid, roleId:uuid, password:z.string().min(8).max(128), restaurantId:uuid.optional(), outletId:uuid.optional() })
export const staffMemberBody = z.object({ displayName:z.string().trim().min(2).max(120), email:z.string().email().transform(value=>value.toLowerCase()), temporaryPassword:z.string().min(8).max(128), roleId:uuid, restaurantId:uuid.optional(), outletId:uuid.optional(), phone:z.string().trim().max(40).optional() })
export const restaurantBody=z.object({name:z.string().trim().min(2).max(160),slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),templateKey:z.enum(['editorial','ember','future-neon','bistro','express','sage','world-plate']).default('editorial'),themeKey:z.enum(['coral','saffron','olive']).default('coral')})
export const outletBody=z.object({restaurantId:uuid,name:z.string().trim().min(2).max(160),slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),addressLine:z.string().trim().max(300).optional(),city:z.string().trim().min(2).max(100).default('Dhaka')})
export const themeBody=z.object({templateKey:z.enum(['editorial','ember','future-neon','bistro','express','sage','world-plate']),themeKey:z.enum(['coral','saffron','olive'])})
export const designSettingsBody=z.object({marqueeItems:z.array(z.string().trim().min(1).max(40)).min(2).max(8)})
export const menuCategoryBody=z.object({restaurantId:uuid,outletId:uuid.optional(),name:z.string().trim().min(2).max(160),slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),description:z.string().trim().max(500).optional()})
export const menuItemBody=z.object({restaurantId:uuid,outletId:uuid.optional(),universal:z.boolean().default(false),categoryId:uuid,name:z.string().trim().min(2).max(160),slug:z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80),description:z.string().trim().max(1000).optional(),imageUrl:z.string().url().optional().or(z.literal('')),basePrice:z.coerce.number().min(0).max(10000000),preparationMinutes:z.coerce.number().int().min(0).max(1440).default(20),featured:z.boolean().default(false)})

export function parse(schema, value) {
  const result = schema.safeParse(value)
  if (!result.success) {
    const error = new Error('Validation failed')
    error.statusCode = 400
    error.details = result.error.flatten()
    throw error
  }
  return result.data
}
