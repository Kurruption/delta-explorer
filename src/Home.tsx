import { motion } from 'motion/react';
import { ChartPie, Clock, Cloud, HardDrive, Pin } from 'lucide-react';
import { useEffect } from 'react';
import { baseName, existing, fmtSize, parentPath, type Places } from './api';
import { FileVisual, FolderIcon, toneFor } from './icons';
import { openTool, pinned, pruneRecent, recent } from './store';
import { glide, snap } from './motion';

const list = { initial: 'hidden', animate: 'show', variants: { hidden: {}, show: { transition: { staggerChildren: 0.035 } } } } as const;
const card = { variants: { hidden: { opacity: 0, y: 14 }, show: { opacity: 1, y: 0, transition: glide } } };
const tileV = { variants: { hidden: { opacity: 0, y: 10, scale: 0.94 }, show: { opacity: 1, y: 0, scale: 1, transition: snap } } };

/** Home page (Dorion): system-folder tiles, drives, cloud, pinned and recent files. Everything cascades in. */
export function Home({ places, onOpen, onOpenFile }: { places: Places | null; onOpen: (p: string, newTab?: boolean) => void; onOpenFile: (p: string) => void }) {
  const pins = pinned.use();
  const rec = recent.use();
  // Files that were deleted or moved since drop out of Recent.
  useEffect(() => {
    if (rec.length) existing(rec).then((ok) => pruneRecent(rec.filter((_, i) => !ok[i])), () => { /* keep the list as is */ });
  }, [rec]);
  if (!places) return null;
  const tile = (path: string, name: string, icon = <FolderIcon tone={toneFor(name, path, places.home)} size={64} />) => (
    <motion.button
      key={path}
      className="tile"
      data-drop={path}
      {...tileV}
      whileHover={{ y: -4, transition: snap }}
      whileTap={{ scale: 0.95 }}
      onClick={() => onOpen(path)}
      onAuxClick={(e) => e.button === 1 && onOpen(path, true)}
      title={path}
    >
      {icon}
      <span>{name}</span>
    </motion.button>
  );
  return (
    <motion.div className="home" {...list}>
      <motion.section className="card" {...card}>
        <h2><FolderIcon size={18} /> System Folders</h2>
        <motion.div className="tiles" {...list}>
          {places.quick.map((q) => tile(q.path, q.name))}
          {tile(places.home, 'Home')}
        </motion.div>
      </motion.section>

      {rec.length > 0 && (
        <motion.section className="card" {...card}>
          <h2><Clock size={18} aria-hidden /> Recent files</h2>
          <motion.div className="recent-list" {...list}>
            {rec.slice(0, 8).map((f) => (
              <motion.button key={f} className="recent-item" {...tileV} whileHover={{ x: 3, transition: snap }} onClick={() => onOpenFile(f)} title={f}>
                <FileVisual name={baseName(f)} path={f} mtime={0} size={28} grid={false} />
                <span className="recent-text"><strong>{baseName(f)}</strong><span className="muted small">{parentPath(f)}</span></span>
              </motion.button>
            ))}
          </motion.div>
        </motion.section>
      )}

      <motion.section className="card" {...card}>
        <h2><HardDrive size={18} aria-hidden /> Drives</h2>
        <motion.div className="drives" {...list}>
          {places.drives.map((d) => (
            <div key={d.path} className="drive-wrap">
            <motion.button className="drive-card" data-drop={d.path} {...tileV} whileHover={{ y: -2, transition: snap }} whileTap={{ scale: 0.98 }} onClick={() => onOpen(d.path)}>
              <HardDrive size={28} aria-hidden className="accent" />
              <span className="drive-text">
                <strong>{d.label} ({d.path.slice(0, 2)})</strong>
                {d.total > 0 && (
                  <>
                    <span className="bar" aria-hidden>
                      <motion.span initial={{ width: 0 }} animate={{ width: `${(1 - d.free / d.total) * 100}%` }} transition={{ ...glide, delay: 0.25 }} />
                    </span>
                    <span className="muted small">{fmtSize(d.free)} free of {fmtSize(d.total)}</span>
                  </>
                )}
              </span>
            </motion.button>
            <button className="icon-btn small drive-analyse" title="Analyse storage" aria-label={`Analyse storage of ${d.label}`} onClick={() => openTool('storage', [d.path])}><ChartPie size={15} /></button>
            </div>
          ))}
        </motion.div>
      </motion.section>

      {places.cloud.length > 0 && (
        <motion.section className="card" {...card}>
          <h2><Cloud size={18} aria-hidden /> Cloud</h2>
          <motion.div className="tiles" {...list}>{places.cloud.map((c) => tile(c.path, c.name, <span className="cloud-tile"><Cloud size={40} /></span>))}</motion.div>
        </motion.section>
      )}

      {pins.length > 0 && (
        <motion.section className="card" {...card}>
          <h2><Pin size={18} aria-hidden /> Pinned</h2>
          <motion.div className="tiles" {...list}>{pins.map((x) => tile(x, baseName(x)))}</motion.div>
        </motion.section>
      )}
      <p className="home-foot muted small">Tip: <kbd>Ctrl K</kbd> opens the command palette · <kbd>Ctrl \</kbd> splits the view</p>
    </motion.div>
  );
}
