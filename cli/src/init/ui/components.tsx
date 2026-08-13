import type { ConfirmPrompt, InitLogTone, InitScreen, InitScreenTone, PromptRequest, SelectPrompt, TextPrompt } from '../runtime'
import { ProgressBar, Select } from '@inkjs/ui'
import { Box, Text, useInput } from 'ink'
import Spinner from 'ink-spinner'
import React, { useEffect, useState } from 'react'
import { Divider } from '../../build/onboarding/ui/components'
import { INIT_CANCEL } from '../runtime'

function colorForTone(tone: InitScreenTone | InitLogTone): 'cyan' | 'blue' | 'green' | 'yellow' | 'red' {
  if (tone === 'blue')
    return 'blue'
  if (tone === 'green')
    return 'green'
  if (tone === 'yellow')
    return 'yellow'
  if (tone === 'red')
    return 'red'
  return 'cyan'
}

export function InitHeader({ title = '🚀  Capgo OTA Onboarding' }: Readonly<{ title?: string }>) {
  return (
    <Box
      borderStyle="double"
      borderColor="cyan"
      paddingX={4}
      paddingY={1}
      alignSelf="center"
    >
      <Text bold color="cyan">
        {title}
      </Text>
    </Box>
  )
}

export function ScreenIntro({ screen }: Readonly<{ screen: InitScreen }>) {
  const color = colorForTone(screen.tone ?? 'cyan')

  return (
    <Box flexDirection="column" marginTop={1}>
      {screen.title && <Text bold color={color}>{screen.title}</Text>}
      {screen.introLines?.map((line, index) => (
        <Text key={`${line}-${index}`} dimColor={index > 0}>{line}</Text>
      ))}
    </Box>
  )
}

export function ProgressSection({ screen }: Readonly<{ screen: InitScreen }>) {
  if (screen.progress === undefined || !screen.phaseLabel)
    return null

  const color = colorForTone(screen.tone ?? 'cyan')

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold color={color}>{screen.phaseLabel}</Text>
      <Box marginTop={1}>
        <ProgressBar value={screen.progress} />
        <Text dimColor>
          {' '}
          {screen.progress}
          %
        </Text>
      </Box>
      <Divider />
    </Box>
  )
}

export function CurrentStepSection({ screen }: Readonly<{ screen: InitScreen }>) {
  if (!screen.stepLabel && !screen.completionLines?.length)
    return null

  const color = colorForTone(screen.tone ?? 'cyan')

  return (
    <Box flexDirection="column" marginTop={1}>
      {screen.resumeLine && (
        <Text color="yellow">
          ↺
          {' '}
          {screen.resumeLine}
        </Text>
      )}
      {screen.stepLabel && <Text bold color={color}>{screen.stepLabel}</Text>}
      {screen.stepSummary && <Text>{screen.stepSummary}</Text>}
      {screen.roadmapLine && (
        <Box marginTop={1}>
          <Text dimColor>{screen.roadmapLine}</Text>
        </Box>
      )}
      {screen.statusLine && <Text dimColor>{screen.statusLine}</Text>}
      {screen.completionLines?.map((line, index) => (
        <Text key={`${line}-${index}`} dimColor={index > 0}>{line}</Text>
      ))}
    </Box>
  )
}

export function ConfirmPromptView({ prompt }: Readonly<{ prompt: ConfirmPrompt }>) {
  const primaryOption = prompt.initialValue === false
    ? { label: 'No', value: 'no', hint: 'skip or stop here' }
    : { label: 'Yes', value: 'yes', hint: 'continue' }

  const secondaryOption = prompt.initialValue === false
    ? { label: 'Yes', value: 'yes', hint: 'continue anyway' }
    : { label: 'No', value: 'no', hint: 'skip or stop here' }

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape)
      prompt.resolve(INIT_CANCEL)
  })

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{prompt.message}</Text>
      <Box marginTop={1}>
        <Select
          options={[primaryOption, secondaryOption]}
          onChange={(value) => {
            prompt.resolve(value === 'yes')
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Use arrow keys and Enter. Press Ctrl+C to cancel.</Text>
      </Box>
    </Box>
  )
}

export function TextPromptView({ prompt, onError }: Readonly<{ prompt: TextPrompt, onError: (error?: string) => void }>) {
  const [value, setValue] = useState('')

  useEffect(() => {
    setValue('')
  }, [prompt.message, prompt.placeholder])

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape) {
      prompt.resolve(INIT_CANCEL)
      return
    }
    if (key.return) {
      const validation = prompt.validate?.(value)
      if (validation) {
        onError(validation)
        return
      }
      prompt.resolve(value)
      return
    }
    if (key.backspace || key.delete) {
      setValue(prev => prev.slice(0, -1))
      return
    }
    if (key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow)
      return
    if (input) {
      if (prompt.error)
        onError()
      setValue(prev => prev + input)
    }
  })

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{prompt.message}</Text>
      {prompt.placeholder && <Text dimColor>{prompt.placeholder}</Text>}
      <Box marginTop={1}>
        <Text color="cyan">❯ </Text>
        {value
          ? <Text>{value}</Text>
          : <Text dimColor>{prompt.placeholder || ''}</Text>}
        <Text color="white">█</Text>
      </Box>
      {prompt.error && (
        <Box marginTop={1}>
          <Text color="yellow">! </Text>
          <Text color="yellow">{prompt.error}</Text>
        </Box>
      )}
    </Box>
  )
}

export function SelectPromptView({ prompt }: Readonly<{ prompt: SelectPrompt }>) {
  const selectOptions = prompt.options.map((option, index) => ({
    label: option.hint ? `${option.label} · ${option.hint}` : option.label,
    value: String(index),
  }))

  useInput((input, key) => {
    if ((key.ctrl && input === 'c') || key.escape)
      prompt.resolve(INIT_CANCEL)
  })

  return (
    <Box flexDirection="column" marginTop={1}>
      <Text bold>{prompt.message}</Text>
      <Box marginTop={1}>
        <Select
          options={selectOptions}
          onChange={(value) => {
            const selectedIndex = Number.parseInt(value, 10)
            prompt.resolve(prompt.options[selectedIndex]?.value ?? INIT_CANCEL)
          }}
        />
      </Box>
      <Box marginTop={1}>
        <Text dimColor>Use arrow keys and Enter. Press Ctrl+C to cancel.</Text>
      </Box>
    </Box>
  )
}

export function PromptArea({ prompt, onTextError }: Readonly<{ prompt?: PromptRequest, onTextError: (error?: string) => void }>) {
  if (!prompt)
    return null

  if (prompt.kind === 'confirm')
    return <ConfirmPromptView prompt={prompt} />
  if (prompt.kind === 'text')
    return <TextPromptView prompt={prompt} onError={onTextError} />
  return <SelectPromptView prompt={prompt} />
}

export function SpinnerArea({ text, skipHint }: Readonly<{ text?: string, skipHint?: string }>) {
  if (!text)
    return null

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box>
        <Box marginRight={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
        </Box>
        <Text>{text}</Text>
      </Box>
      {skipHint && (
        <Box marginTop={1}>
          <Text dimColor>{skipHint}</Text>
        </Box>
      )}
    </Box>
  )
}
