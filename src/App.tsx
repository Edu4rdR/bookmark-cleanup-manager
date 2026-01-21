import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
} from 'react'
import './App.css'

// Types
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

type Tab = 'import' | 'browse' | 'scan' | 'duplicates' | 'organize' | 'export'

// Utility functions
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
    .replace(/"/g, '&quot;')
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
  'the', 'and', 'for', 'with', 'from', 'into', 'about', 'this', 'that',
  'todo', 'para', 'con', 'por', 'los', 'las', 'una', 'uno', 'del',
  'la', 'el', 'de', 'y', 'en',
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

// Main App Component
function App() {
  const [parsed, setParsed] = useState<ParsedFile | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const [activeTab, setActiveTab] = useState<Tab>('import')
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
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(
    () => new Set(),
  )
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
      setActiveTab('browse')
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
  }

  const dismissSuggestion = (id: string) => {
    setDismissedSuggestions((prev) => new Set(prev).add(id))
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
    const nextRoot = removeBookmarksFromTree(parsed.root, idsToRemove)
    setParsed({ ...parsed, root: nextRoot })
    resetScan()
  }

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

  const scanProgress = scanStats.total
    ? Math.round((scanStats.scanned / scanStats.total) * 100)
    : 0

  const filteredResults =
    scanFilter === 'broken'
      ? scanResults.filter((result) => result.status === 'broken')
      : scanResults

  const renderTreeNode = (node: BookmarkNode, depth: number) => {
    const isExpanded = node.type === 'folder' && expandedFolders.has(node.id)
    const isDraggingThis = draggingId === node.id
    const isDropTarget =
      dropTarget?.id === node.id && dropTarget.position === 'inside'
    const isRenaming = renamingFolderId === node.id
    const nodeStats = node.type === 'folder' ? folderStats.get(node.id) : null

    return (
      <li key={node.id} className="tree-item">
        <div
          className={`tree-row ${isDraggingThis ? 'dragging' : ''} ${isDropTarget ? 'drop-target' : ''}`}
          draggable={!isRenaming}
          onDragStart={(e) => handleDragStart(e, node.id)}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => handleDragOver(e, node)}
          onDrop={(e) => handleDrop(e, node)}
        >
          <div className="tree-indent" style={{ '--depth': depth } as CSSProperties} />
          {node.type === 'folder' ? (
            <button
              type="button"
              className="tree-toggle"
              onClick={() => toggleFolder(node.id)}
            >
              {isExpanded ? '−' : '+'}
            </button>
          ) : (
            <div className="tree-toggle-placeholder" />
          )}
          <span className={`tree-icon ${node.type}`}>
            {node.type === 'folder' ? '📁' : '🔗'}
          </span>
          <div className="tree-content">
            {isRenaming ? (
              <input
                className="rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveRename()
                  if (e.key === 'Escape') cancelRename()
                }}
                autoFocus
              />
            ) : (
              <>
                <div className="tree-title">{node.title}</div>
                {node.type === 'bookmark' && (
                  <div className="tree-meta">{node.url}</div>
                )}
              </>
            )}
          </div>
          {nodeStats && (
            <span className="tree-count">{nodeStats.bookmarks}</span>
          )}
          {node.type === 'folder' && !isRenaming && (
            <div className="tree-actions">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => startRename(node)}
              >
                Rename
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => deleteFolder(node.id, node.title)}
              >
                Delete
              </button>
            </div>
          )}
          {isRenaming && (
            <div className="tree-actions">
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={saveRename}
              >
                Save
              </button>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={cancelRename}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
        {node.type === 'folder' && isExpanded && node.children.length > 0 && (
          <ul className="tree-children">
            {node.children.map((child) => renderTreeNode(child, depth + 1))}
          </ul>
        )}
      </li>
    )
  }

  const tabs: { id: Tab; label: string; icon: string; badge?: number }[] = [
    { id: 'import', label: 'Import', icon: '📥' },
    { id: 'browse', label: 'Browse', icon: '📂', badge: stats.bookmarks || undefined },
    { id: 'scan', label: 'Scan Links', icon: '🔍', badge: scanStats.broken || undefined },
    { id: 'duplicates', label: 'Duplicates', icon: '📋', badge: duplicateGroups.length || undefined },
    { id: 'organize', label: 'Organize', icon: '✨', badge: visibleSuggestions.length || undefined },
    { id: 'export', label: 'Export', icon: '📤' },
  ]

  return (
    <div className="app">
      <header className="header">
        <div className="logo">
          <div className="logo-icon">📚</div>
          <span className="logo-text">Bookmark Cleaner</span>
        </div>
        {parsed && (
          <div className="header-stats">
            <div className="header-stat">
              <strong>{stats.bookmarks.toLocaleString()}</strong> bookmarks
            </div>
            <div className="header-stat">
              <strong>{stats.folders.toLocaleString()}</strong> folders
            </div>
            <div className="header-stat">
              <strong>{duplicateGroups.length}</strong> duplicates
            </div>
          </div>
        )}
      </header>

      <main className="main">
        <aside className="sidebar">
          <nav className="nav">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`nav-item ${activeTab === tab.id ? 'active' : ''} ${
                  !parsed && tab.id !== 'import' ? 'disabled' : ''
                }`}
                onClick={() => {
                  if (parsed || tab.id === 'import') {
                    setActiveTab(tab.id)
                  }
                }}
                disabled={!parsed && tab.id !== 'import'}
              >
                <span className="nav-icon">{tab.icon}</span>
                {tab.label}
                {tab.badge !== undefined && tab.badge > 0 && (
                  <span className="nav-badge">{tab.badge}</span>
                )}
              </button>
            ))}
          </nav>
        </aside>

        <section className="content">
          {/* Import Tab */}
          {activeTab === 'import' && (
            <div className="panel">
              <div className="panel-header">
                <h1 className="panel-title">Import Bookmarks</h1>
                <p className="panel-subtitle">
                  Upload your Chrome or Edge bookmark export file to get started
                </p>
              </div>
              <div className="panel-body">
                <div
                  className={`import-zone ${isDragging ? 'dragging' : ''}`}
                  onDragOver={(e) => {
                    e.preventDefault()
                    setIsDragging(true)
                  }}
                  onDragLeave={() => setIsDragging(false)}
                  onDrop={onDrop}
                >
                  <div className="import-icon">📁</div>
                  <h3 className="import-title">
                    {isLoading ? 'Processing...' : 'Drop your bookmarks file here'}
                  </h3>
                  <p className="import-text">
                    Supports Chrome and Edge HTML bookmark exports
                  </p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={isLoading}
                  >
                    Choose File
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".html,text/html"
                    onChange={onFileChange}
                    hidden
                  />
                </div>

                {error && (
                  <p style={{ color: 'var(--danger)', marginTop: '1rem' }}>
                    {error}
                  </p>
                )}

                {parsed && (
                  <div className="file-info">
                    <div className="file-info-item">
                      <div className="file-info-label">File name</div>
                      <div className="file-info-value">{parsed.fileName}</div>
                    </div>
                    <div className="file-info-item">
                      <div className="file-info-label">File size</div>
                      <div className="file-info-value">
                        {formatFileSize(parsed.fileSize)}
                      </div>
                    </div>
                    <div className="file-info-item">
                      <div className="file-info-label">Bookmarks</div>
                      <div className="file-info-value">
                        {stats.bookmarks.toLocaleString()}
                      </div>
                    </div>
                    <div className="file-info-item">
                      <div className="file-info-label">Folders</div>
                      <div className="file-info-value">
                        {stats.folders.toLocaleString()}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Browse Tab */}
          {activeTab === 'browse' && parsed && (
            <div className="panel">
              <div className="panel-header">
                <h1 className="panel-title">Browse Bookmarks</h1>
                <p className="panel-subtitle">
                  Explore your bookmark tree and reorganize with drag and drop
                </p>
              </div>
              <div className="panel-body">
                <div className="stats-grid">
                  <div className="stat-card">
                    <div className="stat-value">
                      {stats.bookmarks.toLocaleString()}
                    </div>
                    <div className="stat-label">Bookmarks</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">
                      {stats.folders.toLocaleString()}
                    </div>
                    <div className="stat-label">Folders</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{stats.maxDepth}</div>
                    <div className="stat-label">Max Depth</div>
                  </div>
                  <div className="stat-card">
                    <div className="stat-value">{duplicateGroups.length}</div>
                    <div className="stat-label">Duplicates</div>
                  </div>
                </div>

                <div className="tree-container">
                  <ul className="tree-list">
                    {parsed.root.children.map((node) =>
                      renderTreeNode(node, 0),
                    )}
                  </ul>
                </div>
              </div>
            </div>
          )}

          {/* Scan Tab */}
          {activeTab === 'scan' && parsed && (
            <div className="panel">
              <div className="panel-header">
                <h1 className="panel-title">Scan for Broken Links</h1>
                <p className="panel-subtitle">
                  Check all your bookmarks for broken URLs
                </p>
              </div>
              <div className="panel-body">
                <div className="scan-controls">
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => void startScan()}
                    disabled={scanState === 'running'}
                  >
                    {scanState === 'running' ? 'Scanning...' : 'Start Scan'}
                  </button>
                  {scanState === 'running' && (
                    <button
                      type="button"
                      className="btn btn-secondary"
                      onClick={stopScan}
                    >
                      Stop
                    </button>
                  )}
                  <span
                    className={`scan-status ${scanState === 'running' ? 'running' : ''} ${scanState === 'done' ? 'done' : ''}`}
                  >
                    {scanState === 'idle' && 'Ready to scan'}
                    {scanState === 'running' && `Scanning... ${scanProgress}%`}
                    {scanState === 'done' && 'Scan complete'}
                    {scanState === 'stopped' && 'Scan stopped'}
                    {scanState === 'error' && 'Scan error'}
                  </span>
                </div>

                {scanStats.total > 0 && (
                  <>
                    <div className="progress-bar">
                      <div
                        className="progress-fill"
                        style={{ width: `${scanProgress}%` }}
                      />
                    </div>

                    <div className="scan-summary">
                      <div className="scan-stat ok">
                        <div className="scan-stat-value">
                          {scanStats.ok.toLocaleString()}
                        </div>
                        <div className="scan-stat-label">OK</div>
                      </div>
                      <div className="scan-stat broken">
                        <div className="scan-stat-value">
                          {scanStats.broken.toLocaleString()}
                        </div>
                        <div className="scan-stat-label">Broken</div>
                      </div>
                      <div className="scan-stat error">
                        <div className="scan-stat-value">
                          {scanStats.error.toLocaleString()}
                        </div>
                        <div className="scan-stat-label">Errors</div>
                      </div>
                      <div className="scan-stat">
                        <div className="scan-stat-value">
                          {(scanStats.total - scanStats.scanned).toLocaleString()}
                        </div>
                        <div className="scan-stat-label">Remaining</div>
                      </div>
                    </div>
                  </>
                )}

                {scanError && (
                  <p style={{ color: 'var(--danger)' }}>{scanError}</p>
                )}

                {scanResults.length > 0 && (
                  <>
                    <div className="filter-tabs">
                      <button
                        type="button"
                        className={`filter-tab ${scanFilter === 'all' ? 'active' : ''}`}
                        onClick={() => setScanFilter('all')}
                      >
                        All ({scanResults.length})
                      </button>
                      <button
                        type="button"
                        className={`filter-tab ${scanFilter === 'broken' ? 'active' : ''}`}
                        onClick={() => setScanFilter('broken')}
                      >
                        Broken ({scanStats.broken})
                      </button>
                    </div>

                    <ul className="results-list">
                      {filteredResults.slice(0, 100).map((result) => (
                        <li key={result.id} className="result-item">
                          <span className={`result-status ${result.status}`}>
                            {result.status === 'ok' && `OK ${result.statusCode || ''}`}
                            {result.status === 'broken' && `${result.statusCode || 'Broken'}`}
                            {result.status === 'error' && 'Error'}
                          </span>
                          <div className="result-content">
                            <div className="result-title">{result.title}</div>
                            <div className="result-url">{result.url}</div>
                            {result.path && (
                              <div className="result-path">{result.path}</div>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {scanStats.scanned === 0 && scanState === 'idle' && (
                  <div className="results-empty">
                    Click "Start Scan" to check all your bookmarks for broken links.
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Duplicates Tab */}
          {activeTab === 'duplicates' && parsed && (
            <div className="panel">
              <div className="panel-header">
                <h1 className="panel-title">Find Duplicates</h1>
                <p className="panel-subtitle">
                  {duplicateGroups.length} duplicate groups found
                </p>
              </div>
              <div className="panel-body">
                {duplicateGroups.length === 0 ? (
                  <div className="dup-empty">
                    No duplicate bookmarks found. Your collection is clean!
                  </div>
                ) : (
                  <ul className="dup-list">
                    {duplicateGroups.map((group) => (
                      <li key={group.key} className="dup-group">
                        <div className="dup-group-header">
                          <span className="dup-url" title={group.key}>
                            {group.key}
                          </span>
                          <span className="dup-count">
                            {group.items.length} copies
                          </span>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => removeDuplicateGroup(group)}
                          >
                            Remove Others
                          </button>
                        </div>
                        <ul className="dup-items">
                          {group.items.map((item) => (
                            <li key={item.id} className="dup-item">
                              <input
                                type="radio"
                                name={`dup-${group.key}`}
                                checked={
                                  duplicateSelections[group.key] === item.id
                                }
                                onChange={() =>
                                  updateDuplicateSelection(group.key, item.id)
                                }
                              />
                              <div className="dup-item-content">
                                <div className="dup-item-title">{item.title}</div>
                                <div className="dup-item-path">
                                  {item.path || 'Root'}
                                </div>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* Organize Tab */}
          {activeTab === 'organize' && parsed && (
            <div className="panel">
              <div className="panel-header">
                <h1 className="panel-title">Organization Suggestions</h1>
                <p className="panel-subtitle">
                  {visibleSuggestions.length} folder merge suggestions
                </p>
              </div>
              <div className="panel-body">
                {visibleSuggestions.length === 0 ? (
                  <div className="suggest-empty">
                    No merge suggestions available. Your folders are well organized!
                  </div>
                ) : (
                  <ul className="suggest-list">
                    {visibleSuggestions.map((suggestion) => (
                      <li key={suggestion.id} className="suggest-card">
                        <div className="suggest-header">
                          <span className="suggest-score">
                            {Math.round(suggestion.score * 100)}% match
                          </span>
                          <div className="suggest-actions">
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => acceptSuggestion(suggestion)}
                            >
                              Merge
                            </button>
                            <button
                              type="button"
                              className="btn btn-sm btn-ghost"
                              onClick={() => dismissSuggestion(suggestion.id)}
                            >
                              Dismiss
                            </button>
                          </div>
                        </div>
                        <div className="suggest-body">
                          <div className="suggest-section">
                            <div className="suggest-label">Keep</div>
                            <div className="suggest-folder">
                              {suggestion.targetTitle}
                            </div>
                            <div className="suggest-path">
                              {suggestion.targetPath}
                            </div>
                          </div>
                          <div className="suggest-section">
                            <div className="suggest-label">
                              Merge into above ({suggestion.sources.length})
                            </div>
                            {suggestion.sources.map((source) => (
                              <div key={source.id} style={{ marginTop: '0.5rem' }}>
                                <div className="suggest-folder">{source.title}</div>
                                <div className="suggest-path">{source.path}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}

          {/* Export Tab */}
          {activeTab === 'export' && parsed && (
            <div className="panel">
              <div className="panel-header">
                <h1 className="panel-title">Export Bookmarks</h1>
                <p className="panel-subtitle">
                  Download your cleaned bookmark file
                </p>
              </div>
              <div className="panel-body">
                <div className="export-info">
                  <div className="export-stat">
                    <span className="export-stat-label">Total Bookmarks</span>
                    <span className="export-stat-value">
                      {stats.bookmarks.toLocaleString()}
                    </span>
                  </div>
                  <div className="export-stat">
                    <span className="export-stat-label">Total Folders</span>
                    <span className="export-stat-value">
                      {stats.folders.toLocaleString()}
                    </span>
                  </div>
                  <div className="export-stat">
                    <span className="export-stat-label">Original File</span>
                    <span className="export-stat-value">{parsed.fileName}</span>
                  </div>
                  <div className="export-stat">
                    <span className="export-stat-label">Format</span>
                    <span className="export-stat-value">
                      Chrome/Edge HTML
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={downloadExport}
                >
                  Download Cleaned Bookmarks
                </button>
              </div>
            </div>
          )}

          {/* Empty state for tabs when no file is loaded */}
          {!parsed && activeTab !== 'import' && (
            <div className="panel">
              <div className="empty-state">
                <div className="empty-icon">📁</div>
                <h2 className="empty-title">No bookmarks loaded</h2>
                <p className="empty-text">
                  Import a bookmark file first to access this feature.
                </p>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => setActiveTab('import')}
                  style={{ marginTop: '1rem' }}
                >
                  Go to Import
                </button>
              </div>
            </div>
          )}
        </section>
      </main>
    </div>
  )
}

export default App
