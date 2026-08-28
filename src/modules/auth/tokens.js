import { createHash, randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { config } from '../../config.js'

const secret = new TextEncoder().encode(config.ACCESS_TOKEN_SECRET)
export const hashToken = (token) => createHash('sha256').update(token).digest('hex')
export const newOpaqueToken = () => randomBytes(48).toString('base64url')

export async function createAccessToken(user) {
  return new SignJWT({ email: user.email, type: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer('bitelink-api')
    .setAudience('bitelink-web')
    .setIssuedAt()
    .setExpirationTime(config.ACCESS_TOKEN_TTL)
    .sign(secret)
}

export async function verifyAccessToken(token) {
  const { payload } = await jwtVerify(token, secret, { issuer: 'bitelink-api', audience: 'bitelink-web' })
  if (payload.type !== 'access') throw new Error('Wrong token type')
  return payload
}
