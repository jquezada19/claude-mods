import type { FileChange } from '../types'

// Folder/file tree for the left column: files grouped by directory, a folder
// holding only one subfolder and no files joined onto it ("src/features/x").

export type DirNode = { kind: 'dir'; path: string; label: string; depth: number; children: TreeNode[] }
export type FileNode = { kind: 'file'; file: FileChange; label: string; depth: number }
export type TreeNode = DirNode | FileNode

type Draft = { dirs: Map<string, Draft>; files: FileChange[] }

const draft = (): Draft => ({ dirs: new Map(), files: [] })

export function buildTree(files: readonly FileChange[]): TreeNode[] {
  const root = draft()
  for (const f of files) {
    const parts = f.path.split('/')
    let at = root
    for (const part of parts.slice(0, -1)) {
      let next = at.dirs.get(part)
      if (!next) at.dirs.set(part, (next = draft()))
      at = next
    }
    at.files.push(f)
  }
  return emit(root, '', 0)
}

function emit(d: Draft, prefix: string, depth: number): TreeNode[] {
  const out: TreeNode[] = []
  for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    let label = name
    let node = sub
    // join a chain of folders that each hold exactly one folder and no files
    while (node.files.length === 0 && node.dirs.size === 1) {
      const [[childName, child]] = [...node.dirs] as [[string, Draft]]
      label = `${label}/${childName}`
      node = child
    }
    const path = prefix ? `${prefix}/${label}` : label
    out.push({ kind: 'dir', path, label, depth, children: emit(node, path, depth + 1) })
  }
  for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
    out.push({ kind: 'file', file: f, label: f.path.slice(f.path.lastIndexOf('/') + 1), depth })
  }
  return out
}

// The rows drawn, in order, skipping the insides of collapsed folders.
export function visibleRows(nodes: readonly TreeNode[], collapsed: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: readonly TreeNode[]) => {
    for (const n of list) {
      out.push(n)
      if (n.kind === 'dir' && !collapsed.has(n.path)) walk(n.children)
    }
  }
  walk(nodes)
  return out
}

// Files in tree order: what prev/next steps through.
export function fileOrder(nodes: readonly TreeNode[]): FileChange[] {
  return visibleRows(nodes, new Set()).flatMap(n => (n.kind === 'file' ? [n.file] : []))
}
