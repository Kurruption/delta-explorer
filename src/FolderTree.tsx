// Sidebar "Folders": a lazily expanding tree of drives and folders that follows the active pane's location.
import { useEffect, useRef, useState } from 'react';
import { ChevronRight, HardDrive } from 'lucide-react';
import { motion } from 'motion/react';
import { isFolder, joinPath, listSubdirs, normPath, parentPath, HOME, type Drive } from './api';
import { FolderIcon } from './icons';
import { folderColors, settings } from './store';
import { snap } from './motion';

export function FolderTree({ drives, current, navigate }: { drives: Drive[]; current: string; navigate: (p: string, newTab?: boolean) => void }) {
  const showHidden = settings.use().showHidden;
  const colors = folderColors.use();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [kids, setKids] = useState<Record<string, string[]>>({});
  const tree = useRef<HTMLDivElement>(null);

  const load = (p: string) => listSubdirs(p, showHidden).then((names) => setKids((k) => ({ ...k, [normPath(p)]: names })), () => setKids((k) => ({ ...k, [normPath(p)]: [] })));
  const toggle = (p: string, want?: boolean) => {
    const k = normPath(p);
    const on = want ?? !open.has(k);
    if (on) load(p); // re-read on every expand, so it never shows stale folders
    setOpen((s) => { const n = new Set(s); if (on) n.add(k); else n.delete(k); return n; });
  };
  useEffect(() => { setKids({}); open.forEach((k) => load(k)); }, [showHidden]); // eslint-disable-line react-hooks/exhaustive-deps

  // Follow the current location: expand its ancestors and bring it into view.
  useEffect(() => {
    if (!isFolder(current)) return;
    const up: string[] = [];
    for (let p = parentPath(current); p !== HOME && up.length < 64; p = parentPath(p)) { up.push(p); if (parentPath(p) === p) break; }
    const missing = up.filter((p) => !open.has(normPath(p)));
    if (missing.length) {
      missing.forEach(load);
      setOpen((s) => new Set([...s, ...missing.map(normPath)]));
    }
    requestAnimationFrame(() => tree.current?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest' }));
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  // Arrow keys move between visible rows; Right/Left expand/collapse.
  const onKey = (e: React.KeyboardEvent, p: string, hasKids: boolean) => {
    const rows = [...(tree.current?.querySelectorAll<HTMLElement>('[role="treeitem"]') ?? [])];
    const i = rows.indexOf(e.currentTarget as HTMLElement);
    const isOpen = open.has(normPath(p));
    if (e.key === 'ArrowDown') rows[i + 1]?.focus();
    else if (e.key === 'ArrowUp') rows[i - 1]?.focus();
    else if (e.key === 'ArrowRight' && hasKids) { if (isOpen) rows[i + 1]?.focus(); else toggle(p, true); }
    else if (e.key === 'ArrowLeft') { if (isOpen) toggle(p, false); else rows.find((r) => r.dataset.path && normPath(r.dataset.path) === normPath(parentPath(p)))?.focus(); }
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const node = (p: string, label: string, depth: number, drive?: boolean): React.ReactNode => {
    const k = normPath(p);
    const isOpen = open.has(k);
    const children = kids[k];
    const hasKids = children === undefined || children.length > 0;
    const here = isFolder(current) && normPath(current) === k;
    return (
      <div key={k} role="none">
        <button className={`side-item tree-item${here ? ' active' : ''}`} role="treeitem" aria-level={depth + 1} aria-expanded={hasKids ? isOpen : undefined}
          aria-current={here ? 'page' : undefined} data-path={p} data-drop={p} style={{ paddingLeft: 6 + depth * 14 }} title={p}
          onClick={(e) => navigate(p, e.ctrlKey)} onAuxClick={(e) => e.button === 1 && navigate(p, true)} onKeyDown={(e) => onKey(e, p, hasKids)}>
          <span className="tree-chev" role="presentation" onClick={(e) => { e.stopPropagation(); if (hasKids) toggle(p); }}>
            {hasKids && <motion.span style={{ display: 'grid' }} animate={{ rotate: isOpen ? 90 : 0 }} transition={snap}><ChevronRight size={13} /></motion.span>}
          </span>
          {drive ? <HardDrive size={15} /> : <FolderIcon color={colors[p.toLowerCase()]} size={15} />}
          <span className="side-label">{label}</span>
        </button>
        {isOpen && children && <div role="group">{children.map((n) => node(joinPath(p, n), n, depth + 1))}</div>}
      </div>
    );
  };
  return <div className="folder-tree" role="tree" aria-label="Folders" ref={tree}>{drives.map((d) => node(d.path, `${d.label} (${d.path.slice(0, 2)})`, 0, true))}</div>;
}
