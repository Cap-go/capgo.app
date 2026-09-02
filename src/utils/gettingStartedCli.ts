export function capgoLocalCliArgs(supaHost: string, supaAnon: string, isLocalHost: boolean): string[] {
  if (!isLocalHost)
    return []
  return ['--supa-host', supaHost, '--supa-anon', supaAnon]
}

export function buildCapgoOtaCliInitCommand(apiKey: string, extraArgs: string[]) {
  const extra = extraArgs.length > 0 ? ` ${extraArgs.join(' ')}` : ''
  return {
    subcommand: 'i',
    extraArgs,
    command: `npx @capgo/cli@latest i ${apiKey}${extra}`,
  }
}
