import { describe, expect, it } from 'vitest'

import { getErrorMessage, isComponentResolutionErrorMessage, isKnownCrawlerNoiseErrorMessage, isStaleAssetErrorMessage, shouldSuppressPostHogExceptionEvent } from '../src/services/staleAssetErrors'

describe('stale asset error helpers', () => {
  it('matches the stale asset errors currently seen in PostHog', () => {
    expect(isStaleAssetErrorMessage('Failed to fetch dynamically imported module: https://console.capgo.app/assets/dashboard-rYp22gdI.js')).toBe(true)
    expect(isStaleAssetErrorMessage('error loading dynamically imported module: https://console.capgo.app/assets/naked-DvVF29Ec.js')).toBe(true)
    expect(isStaleAssetErrorMessage('Importing a module script failed.')).toBe(true)
    expect(isStaleAssetErrorMessage('Unable to preload CSS for /assets/main-C3MIONxo.css')).toBe(true)
    expect(isStaleAssetErrorMessage('\'text/html\' is not a valid JavaScript MIME type.')).toBe(true)
  })

  it('does not match unrelated runtime errors', () => {
    expect(isStaleAssetErrorMessage('Failed to fetch')).toBe(false)
    expect(isStaleAssetErrorMessage('ResizeObserver loop completed with undelivered notifications.')).toBe(false)
    expect(isStaleAssetErrorMessage('Cannot read properties of undefined (reading \'digest\')')).toBe(false)
    expect(isStaleAssetErrorMessage('\'application/json\' is not a valid JavaScript MIME type.')).toBe(false)
    expect(isStaleAssetErrorMessage('\'text/plain\' is not a valid JavaScript MIME type.')).toBe(false)
  })

  it('matches the known crawler-only Object Not Found noise seen in PostHog', () => {
    expect(isKnownCrawlerNoiseErrorMessage('Object Not Found Matching Id:2, MethodName:update, ParamCount:4')).toBe(true)
    expect(isKnownCrawlerNoiseErrorMessage('Non-Error promise rejection captured with value: Object Not Found Matching Id:5')).toBe(true)
    expect(isKnownCrawlerNoiseErrorMessage('Cannot read properties of null (reading \'save\')')).toBe(false)
  })

  it('matches the vue-router component-resolution error caused by stale chunks', () => {
    expect(isComponentResolutionErrorMessage('Couldn\'t resolve component "default" at "/app/:app/device/:device"')).toBe(true)
    expect(isComponentResolutionErrorMessage(new Error('Couldn\'t resolve component "default" at "/app/:app"').message)).toBe(true)
    expect(isComponentResolutionErrorMessage('Navigation cancelled from "/" to "/apps" with a new navigation.')).toBe(false)
    expect(isComponentResolutionErrorMessage(undefined)).toBe(false)
  })

  it('extracts useful messages from arbitrary rejection values', () => {
    expect(getErrorMessage(new Error('Importing a module script failed.'))).toBe('Importing a module script failed.')
    expect(getErrorMessage({ message: 'Unable to preload CSS for /assets/main.css' })).toBe('Unable to preload CSS for /assets/main.css')
    expect(getErrorMessage({ notMessage: true })).toBeUndefined()
  })

  it('suppresses only stale asset exception events in PostHog', () => {
    expect(shouldSuppressPostHogExceptionEvent({
      event: '$exception',
      properties: {
        $exception_list: [{ value: 'Failed to fetch dynamically imported module: https://console.capgo.app/assets/dashboard-rYp22gdI.js' }],
      },
    })).toBe(true)

    expect(shouldSuppressPostHogExceptionEvent({
      event: '$exception',
      properties: {
        $exception_values: ['Unable to preload CSS for /assets/main-C3MIONxo.css'],
      },
    })).toBe(true)

    expect(shouldSuppressPostHogExceptionEvent({
      event: '$exception',
      properties: {
        $exception_list: [{ value: 'ResizeObserver loop completed with undelivered notifications.' }],
      },
    })).toBe(false)

    expect(shouldSuppressPostHogExceptionEvent({
      event: '$exception',
      properties: {
        $exception_list: [{ value: 'Object Not Found Matching Id:3, MethodName:update, ParamCount:4' }],
      },
    })).toBe(true)
  })
})
