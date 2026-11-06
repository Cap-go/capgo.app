import type { DOMElement } from 'ink'
import type { AppTodoList } from './todo'
import { Box, measureElement, render, Text, useApp, useInput, useStdin, useStdout } from 'ink'
import React, { useEffect, useRef, useState } from 'react'

interface TodoTab {
  id: AppTodoList
  completed: number
  total: number
  content: string
}

interface AppTodoTabsProps {
  lists: readonly TodoTab[]
  initialList: AppTodoList
  color: boolean
  onClose?: (list: AppTodoList) => void
}

export function AppTodoTabs({ lists, initialList, color, onClose }: AppTodoTabsProps) {
  const { exit } = useApp()
  const { stdin } = useStdin()
  const { stdout } = useStdout()
  const [, resize] = useState(0)
  const [selected, setSelected] = useState(initialList)
  const [scroll, setScroll] = useState(0)
  const [contentRows, setContentRows] = useState(0)
  const contentRef = useRef<DOMElement>(null)
  const cols = stdout.columns ?? 80
  const rows = stdout.rows ?? 24
  const bodyRows = Math.max(1, rows - 5)
  const active = lists.find(list => list.id === selected) ?? lists[0]
  const maxScroll = Math.max(0, contentRows - bodyRows)
  const offset = Math.min(scroll, maxScroll)

  useEffect(() => {
    const onResize = () => resize(value => value + 1)
    stdout.on('resize', onResize)
    return () => { stdout.off('resize', onResize) }
  }, [stdout])

  useEffect(() => {
    if (!contentRef.current)
      return
    const height = measureElement(contentRef.current).height
    setContentRows(height)
    setScroll(value => Math.min(value, Math.max(0, height - bodyRows)))
  }, [active.content, cols, bodyRows])

  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'c')) {
      onClose?.(active.id)
      exit()
    }
    else if (key.tab || key.leftArrow || key.rightArrow) {
      const direction = key.leftArrow || (key.tab && key.shift) ? -1 : 1
      const index = lists.findIndex(list => list.id === active.id)
      setSelected(lists[(index + direction + lists.length) % lists.length].id)
      setScroll(0)
    }
    else if (key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      const delta = key.pageUp ? -bodyRows : key.pageDown ? bodyRows : key.upArrow ? -1 : 1
      setScroll(value => Math.max(0, Math.min(maxScroll, value + delta)))
    }
    else if (key.home) {
      setScroll(0)
    }
    else if (key.end) {
      setScroll(maxScroll)
    }
  })

  useEffect(() => {
    // Clack's readline closes with paused stdin. Start a pull after Ink owns input.
    const ready = setImmediate(() => stdin.read(0))
    return () => clearImmediate(ready)
  }, [stdin])

  if (cols < 40 || rows < 8) {
    return (
      <Box flexDirection="column" width={cols} height={rows} overflow="hidden">
        <Text wrap="truncate-end">Resize to at least 40 columns × 8 rows.</Text>
        <Text wrap="truncate-end">q / Esc: close</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={cols} height={rows}>
      <Text bold={color} wrap="truncate-end">App todo lists</Text>
      <Box height={1} flexShrink={0} gap={2}>
        {lists.map(list => (
          <Text key={list.id} color={color && list.id === active.id ? 'cyan' : undefined} bold={color && list.id === active.id} dimColor={color && list.id !== active.id}>
            {list.id === active.id ? '[' : ' '}{list.id === 'ota' ? '⚡ OTA' : '🧱 Builder'} {list.completed}/{list.total}{list.id === active.id ? ']' : ' '}
          </Text>
        ))}
      </Box>
      <Box height={1} flexShrink={0} />
      <Box flexDirection="column" height={bodyRows} flexShrink={0} overflowY="hidden">
        <Box ref={contentRef} flexDirection="column" width={cols} flexShrink={0} marginTop={-offset}>
          <Text>{active.content}</Text>
        </Box>
      </Box>
      <Text dimColor={color} wrap="truncate-end">↑/↓ scroll · PgUp/PgDn{contentRows ? ` · ${offset + 1}–${Math.min(offset + bodyRows, contentRows)}/${contentRows}` : ''}</Text>
      <Text dimColor={color} wrap="truncate-end">←/→ or Tab: switch list · q/Esc: close</Text>
    </Box>
  )
}

export async function showAppTodoTabs(props: Omit<AppTodoTabsProps, 'onClose'>): Promise<AppTodoList> {
  let selected = props.initialList
  const instance = render(<AppTodoTabs {...props} onClose={list => selected = list} />, { alternateScreen: true, exitOnCtrlC: false })
  try {
    await instance.waitUntilExit()
    return selected
  }
  finally {
    instance.unmount()
    instance.cleanup()
  }
}
