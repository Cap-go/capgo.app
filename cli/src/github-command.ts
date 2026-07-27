import process, { exit, stdout } from 'node:process'
import { intro, log, outro, spinner as spinnerC } from '@clack/prompts'
import { trackEvent } from './analytics/track'
import { starAllRepositories, StarAllRepositoriesAbortedError, starRepository } from './github'
import { formatError } from './utils'

export function starRepositoryCommand(repository?: string) {
  const { repository: fullRepo, alreadyStarred } = starRepository(repository)
  if (alreadyStarred) {
    log.info(`🫶 ${fullRepo} is already starred`)
  }
  else {
    log.success(`🙏 Thanks for starring ${fullRepo} 🎉`)
    void trackEvent({ channel: 'cli-usage', event: 'Repo Starred', icon: '⭐', tags: { repo_count: 1 } })
  }
}

interface StarAllCommandOptions {
  minDelayMs?: string
  maxDelayMs?: string
  maxConcurrency?: string
}

function parseNumber(value: string | undefined, fallback: number) {
  const parsed = Number.parseInt(value ?? String(fallback), 10)
  return Number.isNaN(parsed) ? fallback : parsed
}

function normalizeProgressMessage(message: string) {
  return message
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\uFE0F\u200D\s]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export async function starAllRepositoriesCommand(repositories: string[], options: StarAllCommandOptions) {
  intro('Star all Capgo repositories')

  const useSpinner = !!stdout.isTTY
  const actionSpinner = useSpinner ? spinnerC() : null
  const requestedRepositories = repositories && repositories.length > 0 ? repositories : undefined
  const minDelayMs = parseNumber(options?.minDelayMs, 20)
  const maxDelayMs = parseNumber(options?.maxDelayMs, 180)
  const maxConcurrency = parseNumber(options?.maxConcurrency, 4)

  log.info(requestedRepositories?.length
    ? `Using ${requestedRepositories.length} explicit repository argument(s).`
    : 'No repositories provided, discovering Cap-go repositories whose name starts with "capacitor-".')
  log.info(`Star requests will start with a ${minDelayMs}-${maxDelayMs}ms delay window and concurrency ${maxConcurrency}.`)

  if (actionSpinner)
    actionSpinner.start('Preparing star-all')
  else
    log.info('Preparing star-all')

  const explicitRepositoryCount = repositories?.length ? repositories.length : 0
  let step = 0
  let discoverySteps = 0
  let totalSteps = explicitRepositoryCount
  let cancellationRequested = false
  let interruptedResultsCount = 0

  const parsePreparedCount = (message: string) => {
    const match = message.match(/Prepared (\d+) repositories to process/i)
    return match ? Number.parseInt(match[1], 10) : null
  }
  const formatStep = (message: string) => {
    step += 1
    const totalSuffix = totalSteps > 0 ? `/${totalSteps}` : '/?'
    return `[${step}${totalSuffix}] ${message}`
  }
  const showProgress = (message: string) => {
    const formatted = formatStep(message)
    if (actionSpinner)
      actionSpinner.message(formatted)
    log.info(formatted)
  }

  let hasResult = false
  const abortController = new AbortController()
  const onSigint = () => {
    if (cancellationRequested) {
      actionSpinner?.stop('Force quitting star-all.')
      log.warn('Force quitting star-all after second Ctrl+C.')
      exit(130)
    }

    cancellationRequested = true
    actionSpinner?.stop('Interrupt received.')
    log.warn('Stopping new star requests. Press Ctrl+C again to force quit immediately.')
    abortController.abort()
  }

  process.on('SIGINT', onSigint)

  try {
    const result = await starAllRepositories({
      repositories: requestedRepositories,
      minDelayMs,
      maxDelayMs,
      maxConcurrency,
      signal: abortController.signal,
      onDiscovery: (message) => {
        discoverySteps += 1
        const preparedCount = parsePreparedCount(message)
        if (preparedCount !== null)
          totalSteps = discoverySteps + preparedCount

        showProgress(normalizeProgressMessage(message))
      },
      onProgress: (entry) => {
        hasResult = true
        const statusMessage = entry.alreadyStarred
          ? `🫶 ${entry.repository} is already starred`
          : `🙏 Starred ${entry.repository}`

        showProgress(entry.error ? `⚠️ Could not star ${entry.repository}: ${entry.error}` : statusMessage)
        if (entry.error)
          log.error(`Could not star ${entry.repository}: ${entry.error}`)
      },
    })

    const starredCount = result.filter(entry => entry.status === 'starred').length
    const alreadyStarredCount = result.filter(entry => entry.status === 'already_starred').length
    const failedCount = result.filter(entry => entry.status === 'failed').length
    if (starredCount > 0)
      void trackEvent({ channel: 'cli-usage', event: 'Repo Starred', icon: '⭐', tags: { repo_count: starredCount } })
    const completionMessage = !hasResult
      ? 'No repositories were processed.'
      : `Completed ${result.length} repository(s): ${starredCount} starred, ${alreadyStarredCount} already starred, ${failedCount} failed.`

    if (actionSpinner)
      actionSpinner.stop(completionMessage)
    else
      log.info(completionMessage)
    outro('Star-all finished')
  }
  catch (error) {
    if (error instanceof StarAllRepositoriesAbortedError) {
      interruptedResultsCount = error.results.length
      const interruptMessage = interruptedResultsCount > 0
        ? `Star-all interrupted after ${interruptedResultsCount} repository result(s).`
        : 'Star-all interrupted before any repository was completed.'
      log.warn(interruptMessage)
      outro('Star-all canceled')
      exit(130)
    }

    actionSpinner?.stop('Star-all failed.')
    log.error(`Star-all failed: ${formatError(error)}`)
    throw error
  }
  finally {
    process.removeListener('SIGINT', onSigint)
  }
}

