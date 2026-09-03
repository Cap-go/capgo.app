import type { Command, Option } from 'commander'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { log } from '@clack/prompts'
import { program } from 'commander'
import { formatError } from './utils'

// Define proper types for mapped commands
interface CommandOption {
  flags: string
  description: string
  displayName: string
  type: 'boolean' | 'string'
}

// Extend Command type to include internal properties
interface CommandWithInternals extends Command {
  _actionHandler: ((...args: any[]) => void) | null
}

interface MappedCommand {
  name: string
  alias: string
  description: string
  options: CommandOption[]
  subcommands: MappedCommand[]
  hasAction: boolean // Property to track if command has an action handler
  isCommandGroup: boolean // Property to identify command groups
}

function getOptionsAnchor(commandPath: string[]) {
  return `options-${commandPath.join('-')}`
}

function formatFrontmatterString(value: string): string {
  return JSON.stringify(value)
}

// Helper function to get an emoji for a command
function getCommandEmoji(cmdName: string): string {
  let emoji = '🔹'
  if (cmdName.includes('upload'))
    emoji = '⬆️'
  else if (cmdName.includes('delete'))
    emoji = '🗑️'
  else if (cmdName.includes('list'))
    emoji = '📋'
  else if (cmdName.includes('add'))
    emoji = '➕'
  else if (cmdName.includes('set'))
    emoji = '⚙️'
  else if (cmdName.includes('create'))
    emoji = '🔨'
  else if (cmdName.includes('encrypt'))
    emoji = '🔒'
  else if (cmdName.includes('decrypt'))
    emoji = '🔓'
    else if (cmdName.includes('debug'))
    emoji = '🐞'
    else if (cmdName === 'device')
    emoji = '📱'
    else if (cmdName === 'observe' || cmdName === 'summary' || cmdName === 'metrics' || cmdName === 'events' || cmdName === 'routes' || cmdName === 'versions')
    emoji = '📊'
  else if (cmdName === 'run')
    emoji = '📱'
  else if (cmdName.includes('doctor'))
    emoji = '👨‍⚕️'
  else if (cmdName.includes('login'))
    emoji = '🔑'
  else if (cmdName.includes('init'))
    emoji = '🚀'
  else if (cmdName.includes('compatibility'))
    emoji = '🧪'
  else if (cmdName.includes('cleanup'))
    emoji = '🧹'
  else if (cmdName.includes('currentBundle'))
    emoji = '📦'
  else if (cmdName.includes('setting'))
    emoji = '⚙️'
  else if (cmdName === 'app')
    emoji = '📱'
  else if (cmdName === 'bundle')
    emoji = '📦'
  else if (cmdName === 'channel')
    emoji = '📢'
  else if (cmdName === 'key')
    emoji = '🔐'
  else if (cmdName === 'account')
    emoji = '👤'
  return emoji
}

function capitalizeCommandName(cmdName: string) {
  return cmdName.charAt(0).toUpperCase() + cmdName.slice(1)
}

function mapOption(opt: Option): CommandOption {
  return {
    flags: opt.flags,
    description: opt.description || '',
    displayName: opt.short || opt.long || opt.flags.split(' ')[0].replace(/,$/, '').trim(),
    type: opt.required || opt.optional ? 'string' : 'boolean',
  }
}

function mapCommand(cmd: Command): MappedCommand {
  const cmdWithInternals = cmd as CommandWithInternals
  const hasAction = cmdWithInternals._actionHandler !== null && cmdWithInternals._actionHandler !== undefined
  const subcommands = cmd.commands?.map(mapCommand) ?? []
  const hasSubcommands = subcommands.length > 0

  return {
    name: cmd.name(),
    alias: cmd.alias() || '',
    description: cmd.description(),
    options: cmd.options.map(mapOption),
    subcommands,
    hasAction,
    isCommandGroup: hasSubcommands && !hasAction,
  }
}

export function generateDocs(filePath: string = './README.md', folderPath?: string) {
  const commands = program.commands.map(mapCommand)

  // Function to format command documentation
  const formatCommand = (cmd: MappedCommand, commandPath: string[] = [], skipMainHeading = false) => {
    const cmdName = cmd.name
    const cmdNameCapitalized = capitalizeCommandName(cmdName)
    const isSubcommand = commandPath.length > 0
    const fullPath = [...commandPath, cmdName]
    const anchor = fullPath.join('-')
    const heading = '#'.repeat(Math.min(2 + commandPath.length, 6))

    let section = ''

    // Command heading with emoji based on command type
    const emoji = getCommandEmoji(cmdName)

    // For all commands, add the heading and description
    if (!(skipMainHeading && !isSubcommand)) {
      section += `${heading} <a id="${anchor}"></a> ${emoji} **${cmdNameCapitalized}**\n\n`
    }

    if (cmd.alias) {
      section += `**Alias:** \`${cmd.alias}\`\n\n`
    }

    // For regular commands, show usage example
    if (!cmd.isCommandGroup) {
      section += `\`\`\`bash\n`
      section += `npx @capgo/cli@latest ${fullPath.join(' ')}\n`
      section += `\`\`\`\n\n`
    }

    // Description - split by line breaks and handle topics
    const descLines = cmd.description.split('\n')
    // Skip the first line for the main command since we already included it
    const startIndex = (!isSubcommand && skipMainHeading) ? 1 : 0

    for (let i = startIndex; i < descLines.length; i++) {
      const line = descLines[i]
      if (line.trim().startsWith('Note:')) {
        // Format notes with emoji
        section += `> ℹ️ ${line.trim().substring(5).trim()}\n\n`
      }
      else if (line.includes('Example:')) {
        // Skip example lines, they'll be handled separately
      }
      else if (line.trim()) { // Only add non-empty lines
        section += `${line}\n`
      }
    }
    section += '\n'

    // Handle example separately - only for regular commands, not for command groups
    const exampleLine = cmd.description.split('\n').find((line: string) => line.includes('Example:'))
    if (exampleLine && !cmd.isCommandGroup) {
      section += `**Example:**\n\n`
      section += `\`\`\`bash\n`
      section += `${exampleLine.replace('Example: ', '')}\n`
      section += `\`\`\`\n\n`
    }

    // Options table - for all commands (even command groups may have global options)
    if (cmd.options.length > 0) {
      if (!isSubcommand) {
        section += `## <a id="${getOptionsAnchor(fullPath)}"></a> Options (${cmdNameCapitalized})\n\n`
      }
      else {
        section += `**Options:**\n\n`
      }
      section += `| Param          | Type          | Description          |\n`
      section += `| -------------- | ------------- | -------------------- |\n`
      for (const opt of cmd.options) {
        section += `| **${opt.displayName}** | <code>${opt.type}</code> | ${opt.description} |\n`
      }
      section += '\n'
    }

    return section
  }

  const renderCommandTree = (cmd: MappedCommand, commandPath: string[] = [], skipMainHeading = false) => {
    let section = formatCommand(cmd, commandPath, skipMainHeading)
    for (const subCmd of cmd.subcommands)
      section += renderCommandTree(subCmd, [...commandPath, cmd.name])
    return section
  }

  const addTocEntries = (cmd: MappedCommand, lines: string[], depth = 0, commandPath: string[] = []) => {
    const fullPath = [...commandPath, cmd.name]
    const label = capitalizeCommandName(cmd.name)
    const prefix = `${'  '.repeat(depth)}- `
    if (depth === 0) {
      lines.push(`${prefix}${getCommandEmoji(cmd.name)} [${label}](#${fullPath.join('-')})`)
    }
    else {
      lines.push(`${prefix}[${label}](#${fullPath.join('-')})`)
    }

    for (const subCmd of cmd.subcommands)
      addTocEntries(subCmd, lines, depth + 1, fullPath)
  }

  // If folderPath is provided, generate individual files for each command
  if (folderPath) {
    // Create the directory if it doesn't exist
    if (!existsSync(folderPath)) {
      mkdirSync(folderPath, { recursive: true })
    }

    // Process each command
    for (const cmd of commands) {
      if (cmd.name === 'generate-docs')
        continue

      // Determine emoji for this command
      const emoji = getCommandEmoji(cmd.name)

      // Generate frontmatter and content for the command
      let cmdFile = `---
title: ${emoji} ${cmd.name}
description: ${formatFrontmatterString(cmd.description.split('\n')[0])}
sidebar_label: ${cmd.name}
sidebar:
  order: ${commands.indexOf(cmd) + 1}
---

`
      // Add command description with emoji preserved, but skip the redundant title
      const description = cmd.description.split('\n')[0]
      cmdFile += `${description}\n\n`

      let cmdMarkdown = ''
      cmdMarkdown = renderCommandTree(cmd, [], true)

      cmdFile += cmdMarkdown

      // Write the file
      try {
        writeFileSync(`${folderPath}/${cmd.name}.mdx`, cmdFile, 'utf8')
        log.success(`Generated documentation file for ${cmd.name} command in ${folderPath}/${cmd.name}.mdx`)
      }
      catch (error) {
        log.error(`Error generating file for ${cmd.name}: ${formatError(error)}`)
      }
    }
    log.success(`Documentation files generated in ${folderPath}/`)
  }
  else {
    // Generate combined markdown for README
    let markdown = '## 📑 Capgo CLI Commands\n\n'

    // Generate Table of Contents
    markdown += '## 📋 Table of Contents\n\n'
    const tocLines: string[] = []
    for (const cmd of commands)
      addTocEntries(cmd, tocLines)
    markdown += `${tocLines.join('\n')}\n`
    markdown += '\n'

    // Generate documentation for each command
    for (const cmd of commands) {
      if (cmd.name === 'generate-docs')
        continue // Skip documenting this command

      markdown += renderCommandTree(cmd)
      markdown += '\n'
    }

    // Update README.md or write to the specified file
    const startTag = '<!-- AUTO-GENERATED-DOCS-START -->'
    const endTag = '<!-- AUTO-GENERATED-DOCS-END -->'
    let fileContent = ''
    try {
      fileContent = readFileSync(filePath, 'utf8')
    }
    catch {
      fileContent = ''
    }

    const startIndex = fileContent.indexOf(startTag)
    const endIndex = fileContent.indexOf(endTag, startIndex)

    if ((startIndex === -1) !== (endIndex === -1)) {
      log.error(`Both ${startTag} and ${endTag} must be present in ${filePath}`)
      return
    }

    if (startIndex !== -1 && endIndex !== -1) {
      const before = fileContent.substring(0, startIndex + startTag.length)
      const after = fileContent.substring(endIndex)
      const newContent = `${before}\n${markdown}\n${after}`
      writeFileSync(filePath, newContent, 'utf8')
      log.success(`Documentation updated in ${filePath}`)
    }
    else if (!fileContent.trim()) {
      writeFileSync(filePath, markdown, 'utf8')
      log.success(`Documentation written to ${filePath}`)
    }
    else {
      log.error(`Refusing to overwrite unmanaged content in ${filePath}`)
    }
  }
}
