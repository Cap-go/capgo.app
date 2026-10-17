import { app as register } from '../_backend/auth/register.ts'
import { app as apple } from '../_backend/auth/apple.ts'
import { app } from '../_backend/private/console_auth.ts'
import { createAllCatch, createHono } from '../_backend/utils/hono.ts'
import { version } from '../_backend/utils/version.ts'

const router = createHono('auth', version)
router.route('/register', register)
router.route('/apple', apple)
router.route('/', app)
createAllCatch(router, 'auth')
Deno.serve(router.fetch)
