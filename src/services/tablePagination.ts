/**
 * If the active page is past the last page for the new total, clamp it and refetch.
 * Returns true when a refetch was started.
 */
export async function refetchIfPageOutOfRange(
  currentPage: { value: number },
  total: number,
  pageSize: number,
  refetch: () => Promise<void>,
): Promise<boolean> {
  const maxPage = Math.max(1, Math.ceil(total / pageSize))
  if (currentPage.value <= maxPage)
    return false
  currentPage.value = maxPage
  await refetch()
  return true
}
