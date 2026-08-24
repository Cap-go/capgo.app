import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { exit, platform, stdout } from 'node:process'
import { intro, log, outro } from '@clack/prompts'
import { flushAnalytics, trackEvent } from '../../../analytics/track'
import { checkAlerts } from '../../../api/update'
import { updateSavedCredentials } from '../../credentials'
import { appendInternalLog, getInternalLogPath, startInternalLog } from '../../../support/internal-log'
import { formatError } from '../../../utils'
import { isMacOS, NotMacOSError, resolveHelperBinary, runAscKeyHelper } from './helper'
import { ASC_KEY_CHANNEL } from './protocol'

export interface CreateAppleKeyOptions {
  apikey?: string
  /** When set, the captured key is saved into this app's iOS build credentials. */
  appId?: string
  /** Save into the per-project .capgo-credentials.json instead of the global file. */
  local?: boolean
  /** Print the captured Key ID / Issuer ID / .p8 path as JSON on stdout. */
  json?: boolean
}

/**
 * Guided creation of an App Store Connect **team** API key. Launches the native
 * macOS helper (a precompiled Swift app that walks the user through Apple's web
 * UI in an embedded browser), streams its stats protocol to PostHog, and
 * captures the resulting key — issuer id, key id and the one-time .p8 — without
 * the user ever copy-pasting a credential.
 */
export async function createAppleKeyCommand(options: CreateAppleKeyOptions = {}): Promise<void> {
  await checkAlerts()
  intro('App Store Connect API Key 🔑')

  if (!isMacOS()) {
    log.error('This guided flow needs the macOS helper app and only runs on macOS.')
    log.info('On other platforms, create the key manually at https://appstoreconnect.apple.com/access/integrations/api '
      + 'then save it with `npx @capgo/cli build credentials save --platform ios --apple-key <AuthKey.p8> --apple-key-id <id> --apple-issuer-id <id>`.')
    void trackEvent({ channel: ASC_KEY_CHANNEL, event: 'ASC Key: Unsupported Platform', apikey: options.apikey, tags: { os_platform: platform } })
    await flushAnalytics()
    exit(1)
  }

  if (!resolveHelperBinary()) {
    log.error('Could not find the App Store Connect key helper binary.')
    log.info('Update @capgo/cli (and reinstall its optional dependencies) so the signed helper is installed, then try again.')
    void trackEvent({ channel: ASC_KEY_CHANNEL, event: 'ASC Key: Helper Missing', apikey: options.apikey })
    await flushAnalytics()
    exit(1)
  }

  // Start a support log for this run (no-op if it can't be created). The helper
  // streams diagnostic `log` lines into it, so a user who hits trouble can send
  // the bundle to support. The onboarding (`build init`) path starts its own.
  if (!getInternalLogPath()) {
    const logPath = startInternalLog(options.appId)
    if (logPath)
      appendInternalLog(`apple-key: guided helper starting for app ${options.appId ?? '(none)'}`)
  }

  log.step('Opening the guided helper… complete the steps in the window that appears.')

  try {
    const outcome = await runAscKeyHelper({
      apikey: options.apikey,
      onEvent: (event) => {
        // Surface a few high-signal milestones in the terminal as they happen.
        if (event.name === 'signed_in')
          log.info('Signed in to App Store Connect.')
        else if (event.name === 'api_access_denied')
          log.warn(`API access unavailable for this team (${String(event.props.reason ?? 'unknown')}).`)
        else if (event.name === 'validation_started')
          log.step('Validating the new key with Apple…')
      },
    })

    if (!outcome.ok) {
      if (outcome.errorCode === 'USER_CANCELLED')
        log.warn('Cancelled — no key was created.')
      else
        log.error(`Key creation failed (${outcome.errorCode}): ${outcome.message}`)
      await flushAnalytics()
      exit(1)
    }

    const { credentials, eventCount } = outcome
    const p8Path = join(homedir(), '.appstoreconnect', 'private_keys', `AuthKey_${credentials.keyId}.p8`)

    log.success('App Store Connect API key created and validated.')
    log.info(`Key ID:    ${credentials.keyId}`)
    log.info(`Issuer ID: ${credentials.issuerId}`)
    log.info(`Saved .p8: ${p8Path}`)

    let savedToAppId: string | undefined
    if (options.appId) {
      const appleKeyContent = Buffer.from(credentials.privateKey, 'utf-8').toString('base64')
      await updateSavedCredentials(options.appId, 'ios', {
        APPLE_KEY_ID: credentials.keyId,
        APPLE_ISSUER_ID: credentials.issuerId,
        APPLE_KEY_CONTENT: appleKeyContent,
      }, options.local)
      savedToAppId = options.appId
      log.success(`Saved to ${options.local ? 'local' : 'global'} build credentials for ${options.appId}.`)
    }
    else {
      log.info('Save it into your build credentials with:')
      log.info(`  npx @capgo/cli build credentials save --platform ios --apple-key "${p8Path}" --apple-key-id "${credentials.keyId}" --apple-issuer-id "${credentials.issuerId}" --appId <your-app-id>`)
    }

    if (options.json) {
      // Deliberately excludes the private key — it's on disk at p8Path.
      stdout.write(`${JSON.stringify({ keyId: credentials.keyId, issuerId: credentials.issuerId, p8Path, savedToAppId, eventCount })}\n`)
    }

    await flushAnalytics()
    outro('Done 🎉')
  }
  catch (error) {
    if (error instanceof NotMacOSError)
      log.error(error.message)
    else
      log.error(`Unexpected error: ${formatError(error)}`)
    await flushAnalytics()
    exit(1)
  }
}
