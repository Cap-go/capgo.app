/**
 * Security Policy Error Handling for CLI, SDK, and MCP
 *
 * This module provides utilities for parsing and displaying security policy errors
 * returned from the Capgo API. It transforms error codes into human-readable messages.
 *
 * Note: These are the error codes actually returned by the backend API.
 * Other security policies (2FA, password policy, hashed API keys) are enforced
 * via RLS which returns generic permission denied errors.
 */

// ============================================================================
// Security Policy Error Codes (must match backend API responses)
// ============================================================================

export const SECURITY_POLICY_ERRORS = {
  // API key expiration - returned from supabase.ts and organization endpoints
  ORG_REQUIRES_EXPIRING_KEY: 'org_requires_expiring_key',
  EXPIRATION_REQUIRED: 'expiration_required',
  EXPIRATION_EXCEEDS_MAX: 'expiration_exceeds_max',
} as const

export type SecurityPolicyErrorCode = typeof SECURITY_POLICY_ERRORS[keyof typeof SECURITY_POLICY_ERRORS]

// ============================================================================
// Human-readable Error Messages
// ============================================================================

export const SECURITY_POLICY_MESSAGES: Record<string, string> = {
  [SECURITY_POLICY_ERRORS.ORG_REQUIRES_EXPIRING_KEY]:
    'This organization requires API keys with expiration dates.\n\nPlease generate a new API key with an expiration:\n  1. Go to https://console.capgo.app/dashboard/apikeys\n  2. Create a new API key with an expiration date\n  3. Update your CLI configuration with: capgo login [new-key]\n  4. Try this command again',

  [SECURITY_POLICY_ERRORS.EXPIRATION_REQUIRED]:
    'This organization requires API keys to have an expiration date.\n\nPlease generate a new API key with an expiration:\n  1. Go to https://console.capgo.app/dashboard/apikeys\n  2. Create a new API key with an expiration date\n  3. Update your CLI configuration with: capgo login [new-key]\n  4. Try this command again',

  [SECURITY_POLICY_ERRORS.EXPIRATION_EXCEEDS_MAX]:
    'Your API key expiration date exceeds the maximum allowed by this organization.\n\nPlease generate a new API key with a shorter expiration:\n  1. Go to https://console.capgo.app/dashboard/apikeys\n  2. Create a new API key with a valid expiration date\n  3. Update your CLI configuration with: capgo login [new-key]\n  4. Try this command again',
}

// ============================================================================
// Security Policy Error Interface
// ============================================================================

export type { ParsedSecurityError } from '../schemas/common'
type ParsedSecurityError = import('../schemas/common').ParsedSecurityError

// ============================================================================
// Main Parsing Functions
// ============================================================================

/**
 * Check if an error code is a security policy error.
 */
export function isSecurityPolicyError(errorCode: string): boolean {
  return Object.values(SECURITY_POLICY_ERRORS).includes(errorCode as SecurityPolicyErrorCode)
}

/**
 * Parse an error response and return formatted security policy information.
 *
 * @param error - The error object or error message from the API
 * @returns ParsedSecurityError with formatted message and metadata
 */
export function parseSecurityPolicyError(error: unknown): ParsedSecurityError {
  // Handle different error formats
  let errorCode = ''
  let errorMessage = ''

  if (typeof error === 'string') {
    errorCode = error
    errorMessage = error
  }
  else if (error && typeof error === 'object') {
    const errorObj = error as Record<string, unknown>
    errorCode = String(errorObj.error || errorObj.code || errorObj.errorCode || '')
    errorMessage = String(errorObj.message || errorObj.error || '')
  }

  // Check if it's a security policy error
  if (isSecurityPolicyError(errorCode)) {
    return {
      isSecurityPolicyError: true,
      errorCode,
      message: SECURITY_POLICY_MESSAGES[errorCode] || errorMessage,
    }
  }

  // Also check the message for security error codes
  for (const [code, message] of Object.entries(SECURITY_POLICY_MESSAGES)) {
    if (errorMessage.includes(code)) {
      return {
        isSecurityPolicyError: true,
        errorCode: code,
        message,
      }
    }
  }

  return {
    isSecurityPolicyError: false,
    errorCode,
    message: errorMessage,
  }
}

/**
 * Get a human-readable message for a security policy error code.
 * Returns the original message if not a security policy error.
 *
 * @param errorCode - The error code from the API
 * @param defaultMessage - The default message to use if not a security policy error
 * @returns Human-readable error message
 */
export function getSecurityPolicyMessage(errorCode: string, defaultMessage?: string): string {
  return SECURITY_POLICY_MESSAGES[errorCode] || defaultMessage || errorCode
}

/**
 * Format an API error for CLI display with security policy awareness.
 * This should be used when displaying errors to users in the CLI.
 *
 * @param error - The error object from the API
 * @returns Formatted error string for CLI display
 */
export function formatApiErrorForCli(error: unknown): string {
  const parsed = parseSecurityPolicyError(error)

  if (parsed.isSecurityPolicyError) {
    return `\n❌ Security Policy Error: ${parsed.errorCode}\n\n${parsed.message}\n`
  }

  return parsed.message || 'An unknown error occurred'
}
