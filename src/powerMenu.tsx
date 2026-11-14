// Context-menu items for the power features (shelf, collections, compare, metadata), shared by FileList.
import { useState } from 'react';
import { FileText, GitCompare, Inbox, Library, ListX, Pencil, Plus, X } from 'lucide-react';
import { META_FILE } from './api';
import type { MenuItem } from './ContextMenu';
import {
  addToCollection, addToShelf, collections, compareDialog, metaDialog, newCollection, removeFromCollection, toast, undoable, type Collection,
} from './store';

export function powerMenu(paths: string[], isDir: (p: string) => boolean, here: string): MenuItem[] {
  const cols = collections.get();
  const inCol = here.startsWith('v:col:') ? here.slice(6) : null;
  const two = paths.length === 2;
  return [
    { label: 'Add to shelf', icon: <Inbox size={15} />, run: () => addToShelf(paths) },
    {
      label: 'Add to collection', icon: <Library size={15} />, sub: () => [
        ...cols.map((c) => ({ label: c.name, icon: <Library size={15} />, run: () => { addToCollection(c.id, paths); toast(`Added to “${c.name}”`); } })),
        ...(cols.length ? ['sep' as const] : []),
        { label: 'New collection', icon: <Plus size={15} />, run: () => { const c = newCollection(`Collection ${cols.length + 1}`, paths); toast(`Added to “${c.name}” (rename it in the sidebar)`); } },
      ],
    },
    ...(inCol ? [{ label: 'Remove from collection', icon: <ListX size={15} />, run: () => removeFromCollection(inCol, paths) }] : []),
    ...(two && paths.every(isDir) ? [{ label: 'Compare folders', icon: <GitCompare size={15} />, run: () => compareDialog.set({ kind: 'folders', a: paths[0], b: paths[1] }) }] : []),
    ...(two && !paths.some(isDir) ? [{ label: 'Compare files', icon: <GitCompare size={15} />, run: () => compareDialog.set({ kind: 'files', a: paths[0], b: paths[1] }) }] : []),
    ...(paths.length === 1 && !isDir(paths[0]) && META_FILE.test(paths[0]) ? [{ label: 'Metadata…', icon: <FileText size={15} />, run: () => metaDialog.set(paths[0]) }] : []),
  ];
}

/** Sidebar "Collections" body: open, create, rename (double-click or F2), delete (undoable). */
export function CollectionsList({ current, navigate }: { current: string; navigate: (p: string, newTab?: boolean) => void }) {
  const cols = collections.use();
  const [naming, setNaming] = useState<{ id: string | null; text: string } | null>(null);
  const commit = () => {
    const t = naming?.text.trim();
    if (t) {
      if (naming!.id) collections.set((cs) => cs.map((c) => (c.id === naming!.id ? { ...c, name: t } : c)));
      else navigate(`v:col:${newCollection(t).id}`);
    }
    setNaming(null);
  };
  const remove = (c: Collection) => {
    collections.set((cs) => cs.filter((x) => x.id !== c.id));
    undoable({ label: `Delete collection “${c.name}”`, run: async () => collections.set((cs) => [...cs, c]) }, `Deleted collection “${c.name}” (the files are untouched)`);
  };
  const input = (
    <form className="side-name" onSubmit={(e) => { e.preventDefault(); commit(); }}>
      <input autoFocus value={naming?.text ?? ''} placeholder="Collection name" aria-label="Collection name" onChange={(e) => setNaming((n) => n && { ...n, text: e.target.value })} onBlur={commit} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
    </form>
  );
  return (
    <>
      {cols.map((c) => naming?.id === c.id ? <div key={c.id}>{input}</div> : (
        <button key={c.id} className={`side-item${current === `v:col:${c.id}` ? ' active' : ''}`} data-drop={`col:${c.id}`} title={`${c.paths.length} items · double-click to rename`}
          onClick={(e) => navigate(`v:col:${c.id}`, e.ctrlKey)} onDoubleClick={() => setNaming({ id: c.id, text: c.name })}
          onKeyDown={(e) => e.key === 'F2' && setNaming({ id: c.id, text: c.name })} aria-current={current === `v:col:${c.id}` ? 'page' : undefined}>
          <Library size={16} /><span className="side-label">{c.name}</span>
          <span className="side-x" role="button" tabIndex={0} aria-label={`Rename collection ${c.name}`} onClick={(e) => { e.stopPropagation(); setNaming({ id: c.id, text: c.name }); }}><Pencil size={12} /></span>
          <span className="side-x" role="button" tabIndex={0} aria-label={`Delete collection ${c.name}`} onClick={(e) => { e.stopPropagation(); remove(c); }}><X size={13} /></span>
        </button>
      ))}
      {naming && !naming.id ? input : (
        <button className="side-item" onClick={() => setNaming({ id: null, text: '' })}><Plus size={16} /><span className="side-label">New collection</span></button>
      )}
    </>
  );
}
