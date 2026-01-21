import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ChangeEvent,
  type DragEvent,
} from 'react'
import './App.css'

type BookmarkNode = BookmarkItem | FolderItem

type BookmarkItem = {
  id: string
  type: 'bookmark'
  title: string
  url: string
  addDate?: number
  icon?: string
}

type FolderItem = {
  id: string
  type: 'folder'
  title: string
  children: BookmarkNode[]
  addDate?: number
  lastModified?: number
}

type ParsedFile = {
  root: FolderItem
  fileName: string
  fileSize: number
  lastModified: number
  importedAt: number
}

type FolderStats = {
  bookmarks: number
  folders: number
  total: number
}

type FolderInfo = {
  id: string
  title: string
  pathTitles: string[]
  pathIds: string[]
  normalized: string
  tokens: Set<string>
}

type MergeSuggestion = {
  id: string
  targetId: string
  targetTitle: string
  targetPath: string
  score: number
  sources: Array<{
    id: string
    title: string
    path: string
    score: number
  }>
}

type DropPosition = 'before' | 'after' | 'inside'

type DropTarget = {
  id: string
  position: DropPosition
}

type DuplicateItem = {
  id: string
  title: string
  url: string
  path: string
  normalized: string
}

type DuplicateGroup = {
  key: string
  items: DuplicateItem[]
}

type FlatBookmark = {
  id: string
  title: string
  url: string
  path: string
}

type ScanStatus = 'ok' | 'broken' | 'error'

type ScanResult = {
  id: string
  title: string
  url: string
  path: string
  status: ScanStatus
  statusCode?: number
  error?: string
  durationMs?: number
}

type ScanStats = {
  total: number
  scanned: number
  ok: number
  broken: number
  error: number
}

const cleanText = (value: string | null) => value?.trim() || 'Untitled'

const readNumberAttr = (element: Element, name: string) => {
  const value = element.getAttribute(name)
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

const parseBookmarkHtml = (html: string): FolderItem => {
  const parser = new DOMParser()
  const document = parser.parseFromString(html, 'text/html')
  const rootDl = document.querySelector('dl')

  if (!rootDl) {
    throw new Error('Could not find a bookmark list in this HTML file.')
  }

  let counter = 0
  const nextId = () => `node-${counter++}`

  const parseDl = (dlElement: Element): BookmarkNode[] => {
    const nodes: BookmarkNode[] = []
    const children = Array.from(dlElement.children)

    for (const element of children) {
      if (element.tagName !== 'DT') continue

      const primaryChild = element.firstElementChild

      if (primaryChild?.tagName === 'H3') {
        const folder: FolderItem = {
          id: nextId(),
          type: 'folder',
          title: cleanText(primaryChild.textContent),
          children: [],
          addDate: readNumberAttr(primaryChild, 'ADD_DATE'),
          lastModified: readNumberAttr(primaryChild, 'LAST_MODIFIED'),
        }

        let sibling = element.nextElementSibling
        while (sibling && sibling.tagName !== 'DL' && sibling.tagName !== 'DT') {
          sibling = sibling.nextElementSibling
        }

        const nestedDl =
          sibling && sibling.tagName === 'DL'
            ? sibling
            : Array.from(element.children).find((child) => child.tagName === 'DL')

        if (nestedDl) {
          folder.children = parseDl(nestedDl)
        }

        nodes.push(folder)
        continue
      }

      if (primaryChild?.tagName === 'A') {
        nodes.push({
          id: nextId(),
          type: 'bookmark',
          title: cleanText(primaryChild.textContent),
          url: primaryChild.getAttribute('HREF') || '',
          addDate: readNumberAttr(primaryChild, 'ADD_DATE'),
          icon: primaryChild.getAttribute('ICON') || undefined,
        })
      }
    }

    return nodes
  }

  return {
    id: 'root',
    type: 'folder',
    title: 'Root',
    children: parseDl(rootDl),
  }
}

const countTree = (nodes: BookmarkNode[], depth = 1) => {
  let bookmarks = 0
  let folders = 0
  let maxDepth = depth

  for (const node of nodes) {
    if (node.type === 'bookmark') {
      bookmarks += 1
      continue
    }

    folders += 1
    const childStats = countTree(node.children, depth + 1)
    bookmarks += childStats.bookmarks
    folders += childStats.folders
    maxDepth = Math.max(maxDepth, childStats.maxDepth)
  }

  return { bookmarks, folders, maxDepth }
}

const buildFolderStats = (
  folder: FolderItem,
  stats: Map<string, FolderStats> = new Map(),
): FolderStats => {
  let bookmarks = 0
  let folders = 0

  for (const child of folder.children) {
    if (child.type === 'bookmark') {
      bookmarks += 1
      continue
    }

    folders += 1
    const childStats = buildFolderStats(child, stats)
    bookmarks += childStats.bookmarks
    folders += childStats.folders
  }

  const entry = { bookmarks, folders, total: bookmarks + folders }
  stats.set(folder.id, entry)
  return entry
}

const normalizeUrl = (value: string) => {
  if (!value) return ''
  try {
    const parsed = new URL(value.trim())
    let pathname = parsed.pathname || '/'
    if (pathname.length > 1 && pathname.endsWith('/')) {
      pathname = pathname.slice(0, -1)
    }
    return `${parsed.hostname.toLowerCase()}${pathname}`
  } catch {
    return value.trim().toLowerCase()
  }
}

const flattenBookmarks = (root: FolderItem) => {
  const items: FlatBookmark[] = []

  const walk = (folder: FolderItem, path: string[]) => {
    for (const child of folder.children) {
      if (child.type === 'folder') {
        walk(child, [...path, child.title])
        continue
      }

      items.push({
        id: child.id,
        title: child.title,
        url: child.url,
        path: path.join(' / '),
      })
    }
  }

  walk(root, [])
  return items
}

const buildDuplicateGroups = (items: FlatBookmark[]) => {
  const groups = new Map<string, DuplicateItem[]>()

  for (const item of items) {
    if (!item.url) continue
    const normalized = normalizeUrl(item.url)
    if (!normalized) continue
    const entry: DuplicateItem = { ...item, normalized }
    const existing = groups.get(normalized)
    if (existing) {
      existing.push(entry)
    } else {
      groups.set(normalized, [entry])
    }
  }

  return Array.from(groups.entries())
    .filter(([, entries]) => entries.length > 1)
    .map(([key, entries]) => ({
      key,
      items: entries,
    }))
    .sort((a, b) => b.items.length - a.items.length)
}

const removeBookmarksFromTree = (
  folder: FolderItem,
  idsToRemove: Set<string>,
): FolderItem => {
  const nextChildren: BookmarkNode[] = []

  for (const child of folder.children) {
    if (child.type === 'bookmark') {
      if (!idsToRemove.has(child.id)) {
        nextChildren.push(child)
      }
      continue
    }

    nextChildren.push(removeBookmarksFromTree(child, idsToRemove))
  }

  return { ...folder, children: nextChildren }
}

const appendChildrenToFolder = (
  folder: FolderItem,
  targetId: string,
  children: BookmarkNode[],
): { folder: FolderItem; updated: boolean } => {
  if (folder.id === targetId) {
    return {
      folder: { ...folder, children: [...folder.children, ...children] },
      updated: true,
    }
  }

  let updated = false
  const nextChildren = folder.children.map((child) => {
    if (child.type !== 'folder' || updated) {
      return child
    }
    const result = appendChildrenToFolder(child, targetId, children)
    if (result.updated) {
      updated = true
      return result.folder
    }
    return child
  })

  return { folder: { ...folder, children: nextChildren }, updated }
}

const removeNodeById = (
  folder: FolderItem,
  id: string,
): { folder: FolderItem; removed?: BookmarkNode } => {
  let removed: BookmarkNode | undefined

  const nextChildren = folder.children.reduce<BookmarkNode[]>((acc, child) => {
    if (removed) {
      acc.push(child)
      return acc
    }

    if (child.id === id) {
      removed = child
      return acc
    }

    if (child.type === 'folder') {
      const result = removeNodeById(child, id)
      if (result.removed) {
        removed = result.removed
        acc.push(result.folder)
        return acc
      }
    }

    acc.push(child)
    return acc
  }, [])

  return {
    folder: { ...folder, children: nextChildren },
    removed,
  }
}

const insertNodeAt = (
  folder: FolderItem,
  parentId: string,
  node: BookmarkNode,
  index?: number,
): { folder: FolderItem; inserted: boolean } => {
  if (folder.id === parentId) {
    const nextChildren = [...folder.children]
    if (index === undefined || index < 0 || index > nextChildren.length) {
      nextChildren.push(node)
    } else {
      nextChildren.splice(index, 0, node)
    }
    return { folder: { ...folder, children: nextChildren }, inserted: true }
  }

  let inserted = false
  const nextChildren = folder.children.map((child) => {
    if (child.type !== 'folder' || inserted) {
      return child
    }
    const result = insertNodeAt(child, parentId, node, index)
    if (result.inserted) {
      inserted = true
      return result.folder
    }
    return child
  })

  return { folder: { ...folder, children: nextChildren }, inserted }
}

const findNodeLocation = (
  folder: FolderItem,
  id: string,
): { parentId: string; index: number; node: BookmarkNode } | null => {
  for (let index = 0; index < folder.children.length; index += 1) {
    const child = folder.children[index]
    if (child.id === id) {
      return { parentId: folder.id, index, node: child }
    }
    if (child.type === 'folder') {
      const result = findNodeLocation(child, id)
      if (result) return result
    }
  }
  return null
}

const findPathIds = (
  folder: FolderItem,
  targetId: string,
  path: string[] = [],
): string[] | null => {
  const nextPath = [...path, folder.id]
  for (const child of folder.children) {
    if (child.id === targetId) {
      return [...nextPath, child.id]
    }
    if (child.type === 'folder') {
      const result = findPathIds(child, targetId, nextPath)
      if (result) return result
    }
  }
  return folder.id === targetId ? nextPath : null
}

const updateFolderTitle = (
  folder: FolderItem,
  folderId: string,
  title: string,
): FolderItem => {
  if (folder.id === folderId) {
    return { ...folder, title }
  }

  const nextChildren = folder.children.map((child) => {
    if (child.type === 'folder') {
      return updateFolderTitle(child, folderId, title)
    }
    return child
  })

  return { ...folder, children: nextChildren }
}

const escapeHtml = (value: string) => {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const buildBookmarkHtml = (root: FolderItem) => {
  const lines: string[] = []
  const indent = (depth: number) => '  '.repeat(depth)

  const renderFolder = (folder: FolderItem, depth: number) => {
    const title = escapeHtml(folder.title)
    const addDate =
      folder.addDate !== undefined ? ` ADD_DATE="${folder.addDate}"` : ''
    const lastModified =
      folder.lastModified !== undefined
        ? ` LAST_MODIFIED="${folder.lastModified}"`
        : ''

    lines.push(
      `${indent(depth)}<DT><H3${addDate}${lastModified}>${title}</H3>`,
    )
    lines.push(`${indent(depth)}<DL><p>`)
    for (const child of folder.children) {
      if (child.type === 'folder') {
        renderFolder(child, depth + 1)
      } else {
        const linkTitle = escapeHtml(child.title)
        const href = escapeHtml(child.url || '')
        const linkAddDate =
          child.addDate !== undefined ? ` ADD_DATE="${child.addDate}"` : ''
        const icon = child.icon ? ` ICON="${escapeHtml(child.icon)}"` : ''
        lines.push(
          `${indent(depth + 1)}<DT><A HREF="${href}"${linkAddDate}${icon}>${linkTitle}</A>`,
        )
      }
    }
    lines.push(`${indent(depth)}</DL><p>`)
  }

  lines.push('<!DOCTYPE NETSCAPE-Bookmark-file-1>')
  lines.push('<!-- This is an automatically generated file.')
  lines.push('     It will be read and overwritten.')
  lines.push('     DO NOT EDIT! -->')
  lines.push('<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">')
  lines.push('<TITLE>Bookmarks</TITLE>')
  lines.push('<H1>Bookmarks</H1>')
  lines.push('<DL><p>')
  for (const child of root.children) {
    if (child.type === 'folder') {
      renderFolder(child, 1)
    } else {
      const linkTitle = escapeHtml(child.title)
      const href = escapeHtml(child.url || '')
      const linkAddDate =
        child.addDate !== undefined ? ` ADD_DATE="${child.addDate}"` : ''
      const icon = child.icon ? ` ICON="${escapeHtml(child.icon)}"` : ''
      lines.push(
        `${indent(1)}<DT><A HREF="${href}"${linkAddDate}${icon}>${linkTitle}</A>`,
      )
    }
  }
  lines.push('</DL><p>')

  return `${lines.join('\n')}\n`
}

const normalizeText = (value: string) => {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const stopwords = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'into',
  'about',
  'this',
  'that',
  'todo',
  'para',
  'con',
  'por',
  'los',
  'las',
  'una',
  'uno',
  'del',
  'la',
  'el',
  'de',
  'y',
  'en',
])

const tokenizeName = (value: string) => {
  const normalized = normalizeText(value)
  const tokens = normalized
    .split(' ')
    .filter((token) => token.length >= 2 && !stopwords.has(token))
  return new Set(tokens)
}

const listFolderInfos = (root: FolderItem) => {
  const items: FolderInfo[] = []

  const walk = (
    folder: FolderItem,
    pathTitles: string[],
    pathIds: string[],
  ) => {
    if (folder.id !== 'root') {
      items.push({
        id: folder.id,
        title: folder.title,
        pathTitles,
        pathIds,
        normalized: normalizeText(folder.title),
        tokens: tokenizeName(folder.title),
      })
    }

    for (const child of folder.children) {
      if (child.type === 'folder') {
        walk(child, [...pathTitles, child.title], [...pathIds, child.id])
      }
    }
  }

  walk(root, [], [root.id])
  return items
}

const scoreSimilarity = (a: FolderInfo, b: FolderInfo) => {
  if (a.normalized && a.normalized === b.normalized) return 1
  if (a.normalized && b.normalized) {
    if (
      a.normalized.includes(b.normalized) ||
      b.normalized.includes(a.normalized)
    ) {
      return 0.85
    }
  }
  if (a.tokens.size === 0 || b.tokens.size === 0) {
    return 0
  }
  let overlap = 0
  for (const token of a.tokens) {
    if (b.tokens.has(token)) overlap += 1
  }
  const union = a.tokens.size + b.tokens.size - overlap
  return union === 0 ? 0 : overlap / union
}

const buildMergeSuggestions = (
  folders: FolderInfo[],
  stats: Map<string, FolderStats>,
) => {
  const threshold = 0.6
  const tokenIndex = new Map<string, FolderInfo[]>()
  for (const folder of folders) {
    for (const token of folder.tokens) {
      const entry = tokenIndex.get(token)
      if (entry) {
        entry.push(folder)
      } else {
        tokenIndex.set(token, [folder])
      }
    }
  }

  const idToIndex = new Map<string, number>()
  folders.forEach((folder, index) => idToIndex.set(folder.id, index))
  const parent = folders.map((_, index) => index)

  const find = (index: number): number => {
    if (parent[index] !== index) {
      parent[index] = find(parent[index])
    }
    return parent[index]
  }

  const union = (a: number, b: number) => {
    const rootA = find(a)
    const rootB = find(b)
    if (rootA !== rootB) {
      parent[rootB] = rootA
    }
  }

  const seenPairs = new Set<string>()
  for (const folder of folders) {
    const candidates = new Set<FolderInfo>()
    for (const token of folder.tokens) {
      const list = tokenIndex.get(token) || []
      for (const candidate of list) {
        candidates.add(candidate)
      }
    }

    for (const candidate of candidates) {
      if (candidate.id === folder.id) continue
      const pairKey =
        folder.id < candidate.id
          ? `${folder.id}::${candidate.id}`
          : `${candidate.id}::${folder.id}`
      if (seenPairs.has(pairKey)) continue
      seenPairs.add(pairKey)

      if (
        folder.pathIds.includes(candidate.id) ||
        candidate.pathIds.includes(folder.id)
      ) {
        continue
      }

      const score = scoreSimilarity(folder, candidate)
      if (score < threshold) continue
      union(idToIndex.get(folder.id)!, idToIndex.get(candidate.id)!)
    }
  }

  const clusters = new Map<number, FolderInfo[]>()
  folders.forEach((folder, index) => {
    const root = find(index)
    const entry = clusters.get(root)
    if (entry) {
      entry.push(folder)
    } else {
      clusters.set(root, [folder])
    }
  })

  const suggestions: MergeSuggestion[] = []

  for (const cluster of clusters.values()) {
    if (cluster.length < 2) continue
    const sorted = [...cluster].sort((a, b) => {
      const depthA = a.pathIds.length
      const depthB = b.pathIds.length
      if (depthA !== depthB) return depthA - depthB
      const countA = stats.get(a.id)?.total ?? 0
      const countB = stats.get(b.id)?.total ?? 0
      if (countA !== countB) return countB - countA
      return a.title.length - b.title.length
    })
    const target = sorted[0]

    const sources = sorted
      .slice(1)
      .map((item) => ({
        id: item.id,
        title: item.title,
        path: item.pathTitles.join(' / ') || 'Root',
        score: scoreSimilarity(item, target),
        pathIds: item.pathIds,
      }))
      .filter((item) => item.score >= threshold)
      .filter((item) => !target.pathIds.includes(item.id))

    if (sources.length === 0) continue

    const score =
      sources.reduce((sum, item) => sum + item.score, 0) / sources.length
    const suggestionId =
      `${target.id}::` +
      sources
        .map((item) => item.id)
        .sort()
        .join(',')

    suggestions.push({
      id: suggestionId,
      targetId: target.id,
      targetTitle: target.title,
      targetPath: target.pathTitles.join(' / ') || 'Root',
      score,
      sources: sources.map(({ id, title, path, score }) => ({
        id,
        title,
        path,
        score,
      })),
    })
  }

  return suggestions.sort((a, b) => b.score - a.score).slice(0, 20)
}

const getInitialExpanded = (root: FolderItem, depthLimit = 1) => {
  const expanded = new Set<string>()

  const walk = (node: FolderItem, depth: number) => {
    if (depth <= depthLimit) {
      expanded.add(node.id)
    }
    for (const child of node.children) {
      if (child.type === 'folder') {
        walk(child, depth + 1)
      }
    }
  }

  walk(root, 0)
  return expanded
}

const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let size = bytes
  let unitIndex = -1
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[unitIndex]}`
}

function App() {
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    () => new Set(),
  )
  const [scanState, setScanState] = useState<
    'idle' | 'running' | 'done' | 'stopped' | 'error'
  >('idle')
  const [scanFilter, setScanFilter] = useState<'all' | 'broken'>('broken')
  const [scanStats, setScanStats] = useState<ScanStats>({
    total: 0,
    scanned: 0,
    ok: 0,
    broken: 0,
    error: 0,
  })
  const [scanResults, setScanResults] = useState<ScanResult[]>([])
  const [scanError, setScanError] = useState<string | null>(null)
  const [duplicateSelections, setDuplicateSelections] = useState<
    Record<string, string>
  >({})
  const [dismissedSuggestions, setDismissedSuggestions] = useState<
    Set<string>
  >(() => new Set())
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null)
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)
  const scanAbortRef = useRef<AbortController | null>(null)
  const scanResultsRef = useRef<ScanResult[]>([])
  const scanStatsRef = useRef<ScanStats>({
    total: 0,
    scanned: 0,
    ok: 0,
    broken: 0,
    error: 0,
  })
  const scanUpdateTimerRef = useRef<number | null>(null)

  const stats = useMemo(() => {
    if (!parsed) {
      return { bookmarks: 0, folders: 0, maxDepth: 0 }
    }
    return countTree(parsed.root.children)
  }, [parsed])

  const folderStats = useMemo(() => {
    if (!parsed) return new Map<string, FolderStats>()
    const stats = new Map<string, FolderStats>()
    buildFolderStats(parsed.root, stats)
    return stats
  }, [parsed])

  const scanTargets = useMemo(() => {
    if (!parsed) return []
    return flattenBookmarks(parsed.root)
  }, [parsed])

  const duplicateGroups = useMemo(() => {
    if (!parsed) return []
    return buildDuplicateGroups(flattenBookmarks(parsed.root))
  }, [parsed])

  const folderInfos = useMemo(() => {
    if (!parsed) return []
    return listFolderInfos(parsed.root)
  }, [parsed])

  const mergeSuggestions = useMemo(() => {
    if (!parsed) return []
    return buildMergeSuggestions(folderInfos, folderStats)
  }, [folderInfos, folderStats, parsed])

  const visibleSuggestions = useMemo(() => {
    if (dismissedSuggestions.size === 0) return mergeSuggestions
    return mergeSuggestions.filter(
      (suggestion) => !dismissedSuggestions.has(suggestion.id),
    )
  }, [mergeSuggestions, dismissedSuggestions])

  useEffect(() => {
    if (parsed) {
      setExpandedFolders(getInitialExpanded(parsed.root, 1))
    } else {
      setExpandedFolders(new Set())
    }
  }, [parsed])

  useEffect(() => {
    return () => {
      scanAbortRef.current?.abort()
      if (scanUpdateTimerRef.current !== null) {
        window.clearTimeout(scanUpdateTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (duplicateGroups.length === 0) {
      setDuplicateSelections({})
      return
    }

    setDuplicateSelections((prev) => {
      const next: Record<string, string> = {}
      for (const group of duplicateGroups) {
        const existing = prev[group.key]
        next[group.key] =
          existing && group.items.find((item) => item.id === existing)
            ? existing
            : group.items[0]?.id || ''
      }
      return next
    })
  }, [duplicateGroups])

  useEffect(() => {
    setDismissedSuggestions((prev) => {
      const next = new Set<string>()
      for (const suggestion of mergeSuggestions) {
        if (prev.has(suggestion.id)) {
          next.add(suggestion.id)
        }
      }
      return next
    })
  }, [mergeSuggestions])

  const resetScan = () => {
    scanAbortRef.current?.abort()
    scanAbortRef.current = null
    if (scanUpdateTimerRef.current !== null) {
      window.clearTimeout(scanUpdateTimerRef.current)
      scanUpdateTimerRef.current = null
    }
    scanResultsRef.current = []
    scanStatsRef.current = {
      total: 0,
      scanned: 0,
      ok: 0,
      broken: 0,
      error: 0,
    }
    setScanResults([])
    setScanStats({ ...scanStatsRef.current })
    setScanState('idle')
    setScanError(null)
  }

  const preserveScroll = (action: () => void) => {
    const scrollY = window.scrollY
    action()
    window.requestAnimationFrame(() => {
      window.scrollTo({ top: scrollY })
    })
  }

  const scheduleScanUpdate = () => {
    if (scanUpdateTimerRef.current !== null) return
    scanUpdateTimerRef.current = window.setTimeout(() => {
      scanUpdateTimerRef.current = null
      setScanResults([...scanResultsRef.current])
      setScanStats({ ...scanStatsRef.current })
    }, 200)
  }

  const handleFile = async (file: File) => {
    setError(null)
    setIsLoading(true)
    resetScan()
    setRenamingFolderId(null)
    setRenameValue('')
    try {
      const content = await file.text()
      const root = parseBookmarkHtml(content)
      setParsed({
        root,
        fileName: file.name,
        fileSize: file.size,
        lastModified: file.lastModified,
        importedAt: Date.now(),
      })
    } catch (err) {
      setParsed(null)
      setError(err instanceof Error ? err.message : 'Import failed.')
    } finally {
      setIsLoading(false)
    }
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    const file = event.dataTransfer.files?.[0]
    if (file) {
      void handleFile(file)
    }
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (file) {
      void handleFile(file)
    }
    event.target.value = ''
  }

  const checkBookmark = async (
    bookmark: FlatBookmark,
    signal: AbortSignal,
  ): Promise<ScanResult | null> => {
    if (!bookmark.url) {
      return {
        id: bookmark.id,
        title: bookmark.title,
        url: '',
        path: bookmark.path,
        status: 'error',
        error: 'Missing URL',
      }
    }

    try {
      const response = await fetch('/api/check', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: bookmark.url, timeoutMs: 8000 }),
        signal,
      })

      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        return {
          id: bookmark.id,
          title: bookmark.title,
          url: bookmark.url,
          path: bookmark.path,
          status: 'error',
          error: data?.error || `Request failed (${response.status})`,
        }
      }

      if (!data?.ok) {
        return {
          id: bookmark.id,
          title: bookmark.title,
          url: bookmark.url,
          path: bookmark.path,
          status: 'error',
          error: data?.error || 'Check failed',
          durationMs:
            typeof data?.durationMs === 'number' ? data.durationMs : undefined,
        }
      }

      const statusCode =
        typeof data?.status === 'number' ? data.status : undefined
      if (statusCode === undefined) {
        return {
          id: bookmark.id,
          title: bookmark.title,
          url: bookmark.url,
          path: bookmark.path,
          status: 'error',
          error: 'Missing status code',
        }
      }

      return {
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
        path: bookmark.path,
        status: statusCode >= 400 ? 'broken' : 'ok',
        statusCode,
        durationMs:
          typeof data?.durationMs === 'number' ? data.durationMs : undefined,
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return null
      }
      return {
        id: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
        path: bookmark.path,
        status: 'error',
        error: err instanceof Error ? err.message : 'Request failed',
      }
    }
  }

  const startScan = async () => {
    if (!parsed) return
    if (scanTargets.length === 0) {
      setScanError('No bookmarks available to scan.')
      return
    }

    resetScan()
    scanStatsRef.current = {
      total: scanTargets.length,
      scanned: 0,
      ok: 0,
      broken: 0,
      error: 0,
    }
    setScanStats({ ...scanStatsRef.current })
    setScanState('running')

    const controller = new AbortController()
    scanAbortRef.current = controller
    const concurrency = 8
    let cursor = 0

    const nextItem = () => {
      if (controller.signal.aborted) return null
      if (cursor >= scanTargets.length) return null
      const item = scanTargets[cursor]
      cursor += 1
      return item
    }

    const worker = async () => {
      while (true) {
        const item = nextItem()
        if (!item) break
        const result = await checkBookmark(item, controller.signal)
        if (!result) break
        scanResultsRef.current.push(result)
        scanStatsRef.current.scanned += 1
        if (result.status === 'ok') scanStatsRef.current.ok += 1
        if (result.status === 'broken') scanStatsRef.current.broken += 1
        if (result.status === 'error') scanStatsRef.current.error += 1
        scheduleScanUpdate()
      }
    }

    try {
      const workers = Array.from(
        { length: Math.min(concurrency, scanTargets.length) },
        () => worker(),
      )
      await Promise.all(workers)
      if (controller.signal.aborted) {
        setScanState('stopped')
      } else {
        setScanState('done')
      }
    } catch (err) {
      setScanState('error')
      setScanError(err instanceof Error ? err.message : 'Scan failed.')
    } finally {
      scanAbortRef.current = null
      if (scanUpdateTimerRef.current !== null) {
        window.clearTimeout(scanUpdateTimerRef.current)
        scanUpdateTimerRef.current = null
      }
      setScanResults([...scanResultsRef.current])
      setScanStats({ ...scanStatsRef.current })
    }
  }

  const stopScan = () => {
    scanAbortRef.current?.abort()
    setScanState('stopped')
  }

  const downloadExport = () => {
    if (!parsed) return
    const html = buildBookmarkHtml(parsed.root)
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const baseName = parsed.fileName.replace(/\.html?$/i, '') || 'bookmarks'
    const dateStamp = new Date().toISOString().slice(0, 10)
    link.href = url
    link.download = `${baseName}-cleaned-${dateStamp}.html`
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }

  const startRename = (folder: FolderItem) => {
    setRenamingFolderId(folder.id)
    setRenameValue(folder.title)
  }

  const cancelRename = () => {
    setRenamingFolderId(null)
    setRenameValue('')
  }

  const saveRename = () => {
    if (!parsed || !renamingFolderId) return
    const nextTitle = renameValue.trim()
    if (!nextTitle) return
    const nextRoot = updateFolderTitle(parsed.root, renamingFolderId, nextTitle)
    setParsed({ ...parsed, root: nextRoot })
    setRenamingFolderId(null)
    setRenameValue('')
  }

  const deleteFolder = (folderId: string, title: string) => {
    if (!parsed) return
    if (!window.confirm(`Delete folder "${title}" and all its contents?`)) {
      return
    }
    const result = removeNodeById(parsed.root, folderId)
    if (!result.removed) return
    setParsed({ ...parsed, root: result.folder })
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      next.delete(folderId)
      return next
    })
    if (renamingFolderId === folderId) {
      setRenamingFolderId(null)
      setRenameValue('')
    }
    resetScan()
  }

  const isDropAllowed = (
    sourceId: string,
    target: BookmarkNode,
    position: DropPosition,
  ) => {
    if (!parsed) return false
    if (sourceId === target.id) return false
    const sourceLocation = findNodeLocation(parsed.root, sourceId)
    if (!sourceLocation) return false
    if (position === 'inside' && target.type !== 'folder') return false
    if (sourceLocation.node.type === 'folder') {
      const path = findPathIds(parsed.root, target.id)
      if (path && path.includes(sourceId)) {
        return false
      }
    }
    return true
  }

  const moveNode = (
    sourceId: string,
    target: BookmarkNode,
    position: DropPosition,
  ) => {
    if (!parsed) return
    if (!isDropAllowed(sourceId, target, position)) return
    const removed = removeNodeById(parsed.root, sourceId)
    if (!removed.removed) return

    const targetLocation =
      position === 'inside'
        ? findNodeLocation(removed.folder, target.id)
        : findNodeLocation(removed.folder, target.id)

    if (!targetLocation) {
      setParsed({ ...parsed, root: parsed.root })
      return
    }

    if (position === 'inside') {
      if (target.type !== 'folder') return
      const inserted = insertNodeAt(
        removed.folder,
        target.id,
        removed.removed,
      )
      if (inserted.inserted) {
        setParsed({ ...parsed, root: inserted.folder })
        setExpandedFolders((prev) => new Set(prev).add(target.id))
        resetScan()
      }
      return
    }

    const insertIndex =
      targetLocation.index + (position === 'after' ? 1 : 0)
    const inserted = insertNodeAt(
      removed.folder,
      targetLocation.parentId,
      removed.removed,
      insertIndex,
    )
    if (inserted.inserted) {
      setParsed({ ...parsed, root: inserted.folder })
      resetScan()
    }
  }

  const handleDragStart = (event: DragEvent, id: string) => {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', id)
    setDraggingId(id)
  }

  const handleDragEnd = () => {
    setDraggingId(null)
    setDropTarget(null)
  }

  const handleDragOver = (
    event: DragEvent<HTMLDivElement>,
    node: BookmarkNode,
  ) => {
    if (!draggingId || !parsed) return
    if (draggingId === node.id) return
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / rect.height
    let position: DropPosition
    if (node.type === 'folder' && ratio > 0.25 && ratio < 0.75) {
      position = 'inside'
    } else {
      position = ratio < 0.5 ? 'before' : 'after'
    }
    if (!isDropAllowed(draggingId, node, position)) {
      setDropTarget(null)
      event.dataTransfer.dropEffect = 'none'
      return
    }
    event.dataTransfer.dropEffect = 'move'
    setDropTarget({ id: node.id, position })
  }

  const handleDrop = (
    event: DragEvent<HTMLDivElement>,
    node: BookmarkNode,
  ) => {
    event.preventDefault()
    const sourceId = draggingId || event.dataTransfer.getData('text/plain')
    if (!sourceId) return
    const position =
      dropTarget?.id === node.id ? dropTarget.position : 'after'
    moveNode(sourceId, node, position)
    setDraggingId(null)
    setDropTarget(null)
  }

  const mergeFoldersIntoTarget = (
    root: FolderItem,
    sourceIds: string[],
    targetId: string,
  ) => {
    let nextRoot = root
    for (const sourceId of sourceIds) {
      if (sourceId === targetId) continue
      const targetPath = findPathIds(nextRoot, targetId)
      if (targetPath?.includes(sourceId)) {
        continue
      }
      const removed = removeNodeById(nextRoot, sourceId)
      if (!removed.removed || removed.removed.type !== 'folder') {
        continue
      }
      const merged = appendChildrenToFolder(
        removed.folder,
        targetId,
        removed.removed.children,
      )
      if (merged.updated) {
        nextRoot = merged.folder
      }
    }
    return nextRoot
  }

  const acceptSuggestion = (suggestion: MergeSuggestion) => {
    if (!parsed) return
    if (suggestion.sources.length === 0) return
    preserveScroll(() => {
      const nextRoot = mergeFoldersIntoTarget(
        parsed.root,
        suggestion.sources.map((source) => source.id),
        suggestion.targetId,
      )
      if (nextRoot === parsed.root) return
      setParsed({ ...parsed, root: nextRoot })
      setExpandedFolders((prev) => {
        const next = new Set(prev)
        next.add(suggestion.targetId)
        return next
      })
      resetScan()
    })
  }

  const dismissSuggestion = (id: string) => {
    preserveScroll(() => {
      setDismissedSuggestions((prev) => new Set(prev).add(id))
    })
  }

  const updateDuplicateSelection = (key: string, id: string) => {
    setDuplicateSelections((prev) => ({ ...prev, [key]: id }))
  }

  const removeDuplicateGroup = (group: DuplicateGroup) => {
    if (!parsed) return
    const keepId = duplicateSelections[group.key]
    if (!keepId) return
    const idsToRemove = new Set(
      group.items.filter((item) => item.id !== keepId).map((item) => item.id),
    )
    if (idsToRemove.size === 0) return
    preserveScroll(() => {
      const nextRoot = removeBookmarksFromTree(parsed.root, idsToRemove)
      setParsed({ ...parsed, root: nextRoot })
      resetScan()
    })
  }

  const scanProgress = scanStats.total
    ? Math.round((scanStats.scanned / scanStats.total) * 100)
    : 0

  const scanStateLabel = (() => {
    switch (scanState) {
      case 'running':
        return 'Scanning'
      case 'done':
        return 'Scan complete'
      case 'stopped':
        return 'Scan stopped'
      case 'error':
        return 'Scan error'
      default:
        return 'Ready to scan'
    }
  })()

  const filteredResults =
    scanFilter === 'broken'
      ? scanResults.filter((result) => result.status === 'broken')
      : scanResults
  const scanResultLimit = scanFilter === 'broken' ? 500 : 300
  const visibleResults = filteredResults.slice(0, scanResultLimit)
  const isResultsTruncated = filteredResults.length > visibleResults.length
  const scanEmptyMessage =
    scanStats.scanned === 0
      ? 'Run a scan to see results.'
      : filteredResults.length === 0
        ? scanFilter === 'broken'
          ? 'No broken links found yet.'
          : 'No results to show.'
        : ''

  const toggleFolder = (id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const statusLine = (() => {
    if (isLoading) return 'Parsing bookmarks...'
    if (error) return error
    if (parsed)
      return `Imported ${stats.bookmarks.toLocaleString()} bookmarks in ${stats.folders.toLocaleString()} folders.`
    return 'Drop a Chrome/Edge bookmark HTML export to begin.'
  })()

  const renderNode = (current: BookmarkNode, depth: number) => {
    const isDragging = draggingId === current.id
    const isDropTarget = dropTarget?.id === current.id
    const dropClass = isDropTarget ? `drop-${dropTarget?.position}` : ''
    if (current.type === 'bookmark') {
      return (
        <li
          key={current.id}
          className={`tree-row bookmark ${dropClass} ${isDragging ? 'dragging' : ''}`}
          style={{ '--depth': depth } as CSSProperties}
        >
          <div
            className="tree-row-inner"
            onDragOver={(event) => handleDragOver(event, current)}
            onDrop={(event) => handleDrop(event, current)}
          >
            <span
              className="drag-handle"
              draggable
              aria-label="Drag bookmark"
              onDragStart={(event) => handleDragStart(event, current.id)}
              onDragEnd={handleDragEnd}
            >
              ::
            </span>
            <span className="tree-toggle-spacer" aria-hidden="true" />
            <span className="tree-badge">Link</span>
            <div className="tree-content">
              <span className="tree-title">{current.title}</span>
              <span className="tree-meta" title={current.url}>
                {current.url || 'No URL found'}
              </span>
            </div>
            <div className="tree-actions" />
          </div>
        </li>
      )
    }

    const isExpanded = expandedFolders.has(current.id)
    const statsForFolder = folderStats.get(current.id)
    const isRenaming = renamingFolderId === current.id
    return (
      <li
        key={current.id}
        className={`tree-row folder ${isExpanded ? 'open' : ''} ${dropClass} ${isDragging ? 'dragging' : ''}`}
        style={{ '--depth': depth } as CSSProperties}
      >
        <div
          className="tree-row-inner"
          onDragOver={(event) => handleDragOver(event, current)}
          onDrop={(event) => handleDrop(event, current)}
        >
          <span
            className="drag-handle"
            draggable={!isRenaming}
            aria-label="Drag folder"
            onDragStart={(event) => handleDragStart(event, current.id)}
            onDragEnd={handleDragEnd}
          >
            ::
          </span>
          <button
            type="button"
            className="tree-toggle"
            onClick={() => toggleFolder(current.id)}
            aria-expanded={isExpanded}
            aria-label={isExpanded ? 'Collapse folder' : 'Expand folder'}
          >
            {isExpanded ? '-' : '+'}
          </button>
          <span className="tree-badge">Folder</span>
          <div className="tree-content">
            {isRenaming ? (
              <>
                <input
                  className="rename-input"
                  value={renameValue}
                  onChange={(event) => setRenameValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      saveRename()
                    }
                    if (event.key === 'Escape') {
                      cancelRename()
                    }
                  }}
                  autoFocus
                />
                <div className="rename-actions">
                  <button
                    type="button"
                    className="action-button"
                    onClick={saveRename}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    className="action-button ghost"
                    onClick={cancelRename}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <span className="tree-title">{current.title}</span>
                <span className="tree-meta">
                  {statsForFolder
                    ? `${statsForFolder.bookmarks} bookmarks, ${statsForFolder.folders} folders`
                    : '0 bookmarks, 0 folders'}
                </span>
              </>
            )}
          </div>
          <div className="tree-actions">
            {isRenaming ? null : (
              <>
                <button
                  type="button"
                  className="action-button"
                  onClick={() => startRename(current)}
                >
                  Rename
                </button>
                <button
                  type="button"
                  className="action-button danger"
                  onClick={() => deleteFolder(current.id, current.title)}
                >
                  Delete
                </button>
              </>
            )}
          </div>
        </div>
        {isExpanded && current.children.length > 0 ? (
          <ul className="tree-children">
            {current.children.map((child) => renderNode(child, depth + 1))}
          </ul>
        ) : null}
      </li>
    )
  }

  return (
    <div className="app">
      <header className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Bookmark Cleanup Manager</span>
          <h1>Rescue the archive.</h1>
          <p className="subtitle">
            Import an export file from Chrome or Edge, rebuild the folder tree,
            and prepare your collection for a full cleanup workflow.
          </p>
          <div className="stepper">
            <span className="step active">01 Import</span>
            <span className="step">02 Scan</span>
            <span className="step">03 Deduplicate</span>
            <span className="step">04 Organize</span>
            <span className="step">05 Export</span>
          </div>
        </div>
        <div className="hero-card">
          <div className="hero-card-header">
            <h2>Import status</h2>
            <span className={`status ${error ? 'error' : 'ok'}`}>
              {parsed ? 'Loaded' : 'Awaiting file'}
            </span>
          </div>
          <p className={`status-line ${error ? 'error' : ''}`}>{statusLine}</p>
          <div className="meta-grid">
            <div>
              <span className="meta-label">File name</span>
              <span className="meta-value">
                {parsed?.fileName || 'No file yet'}
              </span>
            </div>
            <div>
              <span className="meta-label">File size</span>
              <span className="meta-value">
                {parsed ? formatFileSize(parsed.fileSize) : '--'}
              </span>
            </div>
            <div>
              <span className="meta-label">Imported at</span>
              <span className="meta-value">
                {parsed
                  ? new Date(parsed.importedAt).toLocaleString()
                  : '--'}
              </span>
            </div>
            <div>
              <span className="meta-label">Depth</span>
              <span className="meta-value">
                {parsed ? `${stats.maxDepth} levels` : '--'}
              </span>
            </div>
          </div>
        </div>
      </header>

      <main className="content-grid">
        <section
          className={`panel drop-panel ${isDragging ? 'dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault()
            setIsDragging(true)
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
        >
          <div className="drop-header">
            <span className="drop-icon">[]</span>
            <div>
              <h3>Import bookmark file</h3>
              <p>
                Drag your exported HTML file here. We rebuild folder structure
                and keep every URL intact.
              </p>
            </div>
          </div>
          <div className="drop-actions">
            <button
              className="primary"
              type="button"
              onClick={() => fileInputRef.current?.click()}
            >
              Choose file
            </button>
            <span className="drop-hint">or drop the HTML file here</span>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".html,text/html"
            onChange={onFileChange}
            hidden
          />
          <div className="drop-details">
            <div>
              <span className="detail-label">Supported</span>
              <span className="detail-value">Chrome + Edge export format</span>
            </div>
            <div>
              <span className="detail-label">Capacity</span>
              <span className="detail-value">10,000+ bookmarks</span>
            </div>
            <div>
              <span className="detail-label">Parsing</span>
              <span className="detail-value">In-browser, no upload</span>
            </div>
          </div>
        </section>

        <section className="panel stats-panel">
          <h3>Collection snapshot</h3>
          <div className="stats-grid">
            <div className="stat">
              <span className="stat-label">Bookmarks</span>
              <span className="stat-value">
                {parsed ? stats.bookmarks.toLocaleString() : '--'}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Folders</span>
              <span className="stat-value">
                {parsed ? stats.folders.toLocaleString() : '--'}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Total items</span>
              <span className="stat-value">
                {parsed
                  ? (stats.bookmarks + stats.folders).toLocaleString()
                  : '--'}
              </span>
            </div>
            <div className="stat">
              <span className="stat-label">Last modified</span>
              <span className="stat-value">
                {parsed
                  ? new Date(parsed.lastModified).toLocaleDateString()
                  : '--'}
              </span>
            </div>
          </div>
          <div className="stat-note">
            Parsing stays local. Large files can take a few seconds.
          </div>
        </section>

        <section className="panel tree-panel">
          <div className="preview-header">
            <h3>Bookmark tree</h3>
            <span className="preview-limit">expand folders to explore</span>
          </div>
          {parsed ? (
            <ul className="tree-list">
              {parsed.root.children.map((node) => renderNode(node, 0))}
            </ul>
          ) : (
            <div className="preview-empty">
              Import a file to reveal your full bookmark tree.
            </div>
          )}
        </section>

        <section className="panel scan-panel">
          <div className="scan-header">
            <div>
              <h3>Broken link scan</h3>
              <p>
                Check bookmark URLs for 4xx/5xx responses. Status checks run
                locally via the scan service.
              </p>
            </div>
            <div className="scan-actions">
              <button
                className="primary"
                type="button"
                onClick={() => void startScan()}
                disabled={!parsed || scanState === 'running' || isLoading}
              >
                {scanState === 'running' ? 'Scanning...' : 'Start scan'}
              </button>
              {scanState === 'running' ? (
                <button
                  className="secondary"
                  type="button"
                  onClick={stopScan}
                >
                  Stop
                </button>
              ) : null}
            </div>
          </div>

          <div className="scan-meta">
            <span className="scan-state">{scanStateLabel}</span>
            <span className="scan-targets">
              {scanTargets.length.toLocaleString()} bookmarks ready
            </span>
          </div>

          <div className="scan-progress">
            <div className="progress-track">
              <div
                className="progress-bar"
                style={{ width: `${scanProgress}%` }}
              />
            </div>
            <div className="progress-meta">
              <span>
                {scanStats.scanned.toLocaleString()} /{' '}
                {scanStats.total.toLocaleString()}
              </span>
              <span>{scanProgress}%</span>
            </div>
          </div>

          <div className="scan-summary">
            <div className="scan-stat">
              <span className="stat-label">OK</span>
              <span className="stat-value">
                {scanStats.ok.toLocaleString()}
              </span>
            </div>
            <div className="scan-stat">
              <span className="stat-label">Broken</span>
              <span className="stat-value">
                {scanStats.broken.toLocaleString()}
              </span>
            </div>
            <div className="scan-stat">
              <span className="stat-label">Errors</span>
              <span className="stat-value">
                {scanStats.error.toLocaleString()}
              </span>
            </div>
            <div className="scan-stat">
              <span className="stat-label">Remaining</span>
              <span className="stat-value">
                {(scanStats.total - scanStats.scanned).toLocaleString()}
              </span>
            </div>
          </div>

          <div className="scan-filter">
            <button
              type="button"
              className={`chip ${scanFilter === 'all' ? 'active' : ''}`}
              onClick={() => setScanFilter('all')}
            >
              All results
            </button>
            <button
              type="button"
              className={`chip ${scanFilter === 'broken' ? 'active' : ''}`}
              onClick={() => setScanFilter('broken')}
            >
              Broken only
            </button>
          </div>

          {scanError ? <p className="scan-error">{scanError}</p> : null}

          {scanEmptyMessage ? (
            <p className="scan-empty">{scanEmptyMessage}</p>
          ) : (
            <ul className="scan-results">
              {visibleResults.map((result) => {
                const statusLabel =
                  result.status === 'error'
                    ? 'Error'
                    : result.status === 'broken'
                      ? `Broken ${result.statusCode ?? ''}`.trim()
                      : `OK ${result.statusCode ?? ''}`.trim()
                return (
                  <li key={result.id} className={`scan-row ${result.status}`}>
                    <span className="scan-status">{statusLabel}</span>
                    <div className="scan-main">
                      <span className="scan-title">{result.title}</span>
                      <span className="scan-url" title={result.url}>
                        {result.url || 'No URL'}
                      </span>
                      {result.path ? (
                        <span className="scan-path">{result.path}</span>
                      ) : null}
                      {result.error ? (
                        <span className="scan-error-detail">
                          {result.error}
                        </span>
                      ) : null}
                    </div>
                  </li>
                )
              })}
            </ul>
          )}

          {isResultsTruncated ? (
            <p className="scan-truncate">
              Showing first {scanResultLimit.toLocaleString()} results. Refine
              the filter to see more.
            </p>
          ) : null}
        </section>

        <section className="panel dup-panel">
          <div className="dup-header">
            <div>
              <h3>Duplicate finder</h3>
              <p>
                Groups bookmarks by URL variants (http/https, trailing slash,
                query string removed). Choose a primary link and remove the rest.
              </p>
            </div>
            <span className="dup-count">
              {duplicateGroups.length.toLocaleString()} groups
            </span>
          </div>

          {duplicateGroups.length === 0 ? (
            <p className="dup-empty">No duplicates detected yet.</p>
          ) : (
            <ul className="dup-groups">
              {duplicateGroups.map((group) => (
                <li key={group.key} className="dup-group">
                  <div className="dup-group-header">
                    <div>
                      <span className="dup-label">Normalized URL</span>
                      <span className="dup-key" title={group.key}>
                        {group.key}
                      </span>
                    </div>
                    <div className="dup-actions">
                      <span className="dup-count-chip">
                        {group.items.length} items
                      </span>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => removeDuplicateGroup(group)}
                      >
                        Remove others
                      </button>
                    </div>
                  </div>
                  <ul className="dup-items">
                    {group.items.map((item) => (
                      <li key={item.id} className="dup-item">
                        <label className="dup-radio">
                          <input
                            type="radio"
                            name={`dup-${group.key}`}
                            value={item.id}
                            checked={duplicateSelections[group.key] === item.id}
                            onChange={() =>
                              updateDuplicateSelection(group.key, item.id)
                            }
                          />
                          <span className="dup-radio-label">Primary</span>
                        </label>
                        <div className="dup-item-main">
                          <span className="dup-title">{item.title}</span>
                          <span className="dup-url" title={item.url}>
                            {item.url}
                          </span>
                          {item.path ? (
                            <span className="dup-path">{item.path}</span>
                          ) : (
                            <span className="dup-path">Root</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel suggest-panel">
          <div className="suggest-header">
            <div>
              <h3>Organization suggestions</h3>
              <p>
                We look for similar folder names and suggest safe merges to
                reduce clutter.
              </p>
            </div>
            <span className="suggest-count">
              {visibleSuggestions.length.toLocaleString()} suggestions
            </span>
          </div>

          {visibleSuggestions.length === 0 ? (
            <p className="suggest-empty">No merge suggestions right now.</p>
          ) : (
            <ul className="suggest-list">
              {visibleSuggestions.map((suggestion) => (
                <li key={suggestion.id} className="suggest-row">
                  <div className="suggest-main">
                    <span className="suggest-score">
                      {Math.round(suggestion.score * 100)}% match
                    </span>
                    <div className="suggest-target">
                      <span className="suggest-label">Target</span>
                      <span className="suggest-title">
                        {suggestion.targetTitle}
                      </span>
                      <span className="suggest-path">
                        {suggestion.targetPath}
                      </span>
                    </div>
                    <div className="suggest-sources">
                      <span className="suggest-label">Sources</span>
                      <ul className="suggest-source-list">
                        {suggestion.sources.map((source) => (
                          <li key={source.id}>
                            <span className="suggest-title">{source.title}</span>
                            <span className="suggest-path">{source.path}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </div>
                  <div className="suggest-actions">
                    <button
                      type="button"
                      className="action-button"
                      onClick={() => acceptSuggestion(suggestion)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="action-button ghost"
                      onClick={() => dismissSuggestion(suggestion.id)}
                    >
                      Dismiss
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel export-panel">
          <div className="export-header">
            <div>
              <h3>Export cleaned bookmarks</h3>
              <p>
                Generate a new Chrome/Edge bookmark HTML file from the current
                tree order.
              </p>
            </div>
            <button
              className="primary"
              type="button"
              onClick={downloadExport}
              disabled={!parsed}
            >
              Export HTML
            </button>
          </div>
          <div className="export-note">
            {parsed
              ? 'This export reflects the current tree order and any changes you made.'
              : 'Import a bookmark file to enable export.'}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
