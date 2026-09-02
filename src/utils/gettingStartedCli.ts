export function capgoLocalCliArgs(supaHost: string, supaAnon: string, isLocalHost: boolean): string[] {
  if (!isLocalHost)
    return []
  return ['--supa-host', supaHost, '--supa-anon', supaAnon]
}

export function buildCapgoOtaCliInitCommand(apiKey: string, extraArgs: string[]) {
  const npx = 'npx'
  const pkg = '@capgo/cli@latest'
  const subcommand = 'i'
  const extra = extraArgs.length > 0 ? ` ${extraArgs.join(' ')}` : ''
  return {
    npx,
    pkg,
    subcommand,
    extraArgs,
    command: `${npx} ${pkg} ${subcommand} ${apiKey}${extra}`,
  }
}
