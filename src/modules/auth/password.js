import { hash, verify } from '@node-rs/argon2'

const options = { memoryCost: 19_456, timeCost: 2, parallelism: 1, outputLen: 32 }

export const hashPassword = (password) => hash(password, options)
export const verifyPassword = (encoded, password) => verify(encoded, password, options)
