import { isStepView } from '../src/build/onboarding/flow/contract.ts'
import { androidFlow } from '../src/build/onboarding/flow/android-flow.ts'
import { iosFlow } from '../src/build/onboarding/flow/ios-flow.ts'
let pass = 0, fail = 0
const ok = (c, m) => c ? (pass++, console.log('OK', m)) : (fail++, console.error('FAIL', m))
ok(isStepView({ kind: 'choice', prompt: 'pick', options: [{ value: 'a', label: 'A' }] }), 'valid choice view')
ok(isStepView({ kind: 'human_gate', prompt: 'enter', collect: [{ field: 'x', desc: 'X' }] }), 'valid human_gate view')
ok(isStepView({ kind: 'input', prompt: 'type', collect: [{ field: 'x', desc: 'X' }] }), 'valid input view')
ok(!isStepView({ kind: 'nope', prompt: 'x' }), 'rejects unknown kind')
ok(!isStepView({ prompt: 'x' }), 'rejects missing kind')
ok(androidFlow.resumeStep(null) === 'welcome', 'androidFlow.resumeStep(null) delegates to welcome')
ok(iosFlow.resumeStep(null) === 'welcome', 'iosFlow.resumeStep(null) delegates to welcome')

// ── Real StepView conformance: a representative step of EACH AndroidStepKind ──
// reachable via androidFlow.viewForStep (auto | input | choice | done | error).
// Steps + minimal progress/ctx picked from android/flow.ts's androidViewForStep.
const ctx = { appId: 'com.example.app' }
const kindSamples = [
  ['auto', 'welcome'],                                // default case → kind only
  ['input', 'keystore-existing-store-password'],      // prompt + collect
  ['choice', 'keystore-method-select'],               // options
  ['done', 'build-complete'],                         // message
  ['error', 'no-platform'],                           // message
]
for (const [kind, step] of kindSamples) {
  const view = androidFlow.viewForStep(step, null, ctx)
  ok(view.kind === kind, `viewForStep(${step}) maps to kind '${kind}'`)
  ok(isStepView(view), `viewForStep(${step}) is a conformant StepView (${kind})`)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
