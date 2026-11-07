const docs = 'https://capgo.app/docs/builder/troubleshooting/'

// Match documented symptoms only; these are checks to make, not proof of a root cause.
const symptoms = [
  { pattern: /code signing failed|codesign.*failed/i, section: 'code-signing-failed', meaning: 'Native signing failed.', steps: ['Verify the certificate type matches the build distribution type, and check that the provisioning profile is valid for the app and includes the signing certificate.'] },
  { pattern: /provisioning profile.*(?:doesn.t include|does not include).*certificate/i, section: 'provisioning-profile-doesnt-include-signing-certificate', meaning: 'The provisioning profile does not include the signing certificate.', steps: ['Download the current profile from Apple and verify that it includes the certificate used for this build before updating credentials.'] },
  { pattern: /keystore password incorrect|keystore was tampered with|password was incorrect/i, section: 'keystore-password-incorrect', meaning: 'Android signing could not unlock the keystore.', steps: ['Verify the keystore and key passwords locally, check the configured signing variables, and verify the base64 keystore encoding. Never print passwords in chat or logs.'] },
  { pattern: /key alias not found|alias .* does not exist/i, section: 'key-alias-not-found', meaning: 'The configured Android signing alias is absent from the keystore.', steps: ['List the keystore aliases locally and set KEYSTORE_KEY_ALIAS to the correct existing alias.'] },
  { pattern: /pod install failed/i, section: 'pod-install-failed', meaning: 'CocoaPods dependency installation failed.', steps: ['Inspect the preceding dependency resolution error, verify Podfile dependencies and versions, and reproduce pod install locally.'] },
  { pattern: /gradle build failed|FAILURE: Build failed with an exception/i, section: 'gradle-build-failed', meaning: 'Gradle reported a build failure; this line alone does not identify the cause.', steps: ['Read the first error under What went wrong and the preceding compiler output. Verify Gradle/dependency versions and reproduce the failing task locally.'] },
]

export function explainBuildLogs(logs: string) {
  const lines = logs.split('\n')
  return symptoms.flatMap((symptom) => {
    const line = lines.find(line => symptom.pattern.test(line))
    return line ? [{
      classification: 'error', evidence: line.slice(0, 1000), meaning: symptom.meaning,
      next_steps: symptom.steps, docs_url: `${docs}#${symptom.section}`, confidence: 'documented_symptom',
    }] : []
  })
}

export function explainBuildStatus(status: string) {
  const normal = ['pending', 'queued', 'running', 'building', 'uploading', 'succeeded', 'completed'].includes(status)
  const failed = ['failed', 'timeout', 'timed_out'].includes(status)
  return {
    classification: normal ? 'normal' : failed ? 'error' : status === 'cancelled' ? 'cancelled' : 'unknown',
    meaning: normal ? 'This is an expected build lifecycle state.' : failed ? 'The build did not succeed. Read its logs to identify the cause.' : status === 'cancelled' ? 'The build was cancelled; this alone does not establish a compiler or signing failure.' : 'This status is not classified. Inspect status details and logs.',
    next_steps: failed ? ['Read a build log snapshot, identify the first causal error, and compare it with the builder troubleshooting guide before proposing a fix.'] : [],
    docs_url: docs,
  }
}
