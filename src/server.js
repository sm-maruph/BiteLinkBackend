import { buildApp } from './app.js'
import { config } from './config.js'

const app = await buildApp()

const shutdown = async (signal) => {
  app.log.info({ signal }, 'shutting down')
  await app.close()
  process.exit(0)
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

try {
  await app.listen({ host: config.HOST, port: config.PORT })
} catch (error) {
  app.log.error(error)
  process.exit(1)
}
