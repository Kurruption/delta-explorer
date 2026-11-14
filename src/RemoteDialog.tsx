import { useState } from 'react';
import { motion } from 'motion/react';
import { ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import { remoteForget, remoteSetSecret, remoteTest, type RemoteConn, type RemoteProtocol } from './api';
import { remotes, toast } from './store';
import { Segmented } from './Settings';

const PROTOCOLS: { v: RemoteProtocol; label: string; port: number }[] = [
  { v: 'sftp', label: 'SFTP (SSH)', port: 22 },
  { v: 'ftps', label: 'FTPS (FTP + TLS)', port: 21 },
  { v: 'ftp', label: 'FTP (unencrypted)', port: 21 },
  { v: 'webdavs', label: 'WebDAV (HTTPS)', port: 443 },
  { v: 'webdav', label: 'WebDAV (HTTP, unencrypted)', port: 80 },
];
const FINGERPRINT = /SHA256:[A-Za-z0-9+/=]+/;

/** Add or edit a remote connection. Saving first connects (so mistakes show now, not later);
 * an SFTP server's host key is shown on first connect and pinned once trusted. */
export function RemoteDialog({ initial, onClose, onOpen }: { initial: RemoteConn | null; onClose: () => void; onOpen: (c: RemoteConn) => void }) {
  const [c, setC] = useState<RemoteConn>(initial ?? { id: crypto.randomUUID(), name: '', protocol: 'sftp', host: '', port: 0, user: '', path: '/', keyFile: '', fingerprint: '' });
  const [secret, setSecret] = useState('');
  const [useKey, setUseKey] = useState(!!initial?.keyFile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trust, setTrust] = useState<{ fp: string; changed: boolean } | null>(null);
  const set = <K extends keyof RemoteConn>(k: K, v: RemoteConn[K]) => { setC((x) => ({ ...x, [k]: v })); setError(null); setTrust(null); };
  const sftp = c.protocol === 'sftp';
  const defPort = PROTOCOLS.find((p) => p.v === c.protocol)!.port;

  const final = (fp = c.fingerprint): RemoteConn => {
    // Another server (or port) can't keep the old pinned key.
    const moved = initial && (initial.host !== c.host.trim() || initial.port !== c.port);
    return { ...c, host: c.host.trim(), name: c.name.trim() || c.host.trim(), path: c.path.trim() || '/', keyFile: sftp && useKey ? c.keyFile.trim() : '', fingerprint: sftp ? (moved && fp === initial?.fingerprint ? '' : fp) : '' };
  };
  const commit = async (conn: RemoteConn) => {
    if (secret) await remoteSetSecret(conn.id, secret);
    remotes.set((all) => (all.some((x) => x.id === conn.id) ? all.map((x) => (x.id === conn.id ? conn : x)) : [...all, conn]));
    toast(`Saved “${conn.name}”`);
    onClose();
    if (!initial) onOpen(conn);
  };
  const save = async (fp?: string) => {
    if (!c.host.trim()) return setError('Enter the server name or IP address');
    const conn = final(fp);
    setBusy(true); setError(null); setTrust(null);
    try {
      await remoteTest(conn, secret || null);
      await commit(conn);
    } catch (e) {
      const msg = String(e);
      const m = sftp && FINGERPRINT.exec(msg);
      if (m && /trusted yet|changed/.test(msg)) setTrust({ fp: m[0], changed: msg.includes('changed') });
      else setError(msg);
    } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!initial) return;
    remotes.set((all) => all.filter((x) => x.id !== initial.id));
    await remoteForget(initial.id).catch(() => { /* nothing stored */ });
    toast(`Removed “${initial.name}”. Nothing on the server was changed.`);
    onClose();
  };

  return (
    <motion.div className="modal-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <motion.form
        className="modal remote-dialog" role="dialog" aria-modal aria-labelledby="remote-title"
        initial={{ scale: 0.94, y: 10 }} animate={{ scale: 1, y: 0 }} exit={{ scale: 0.96, opacity: 0 }}
        onKeyDown={(e) => { e.stopPropagation(); if (e.key === 'Escape') onClose(); }}
        onSubmit={(e) => { e.preventDefault(); if (!busy) save(); }}
      >
        <h3 id="remote-title">{initial ? `Edit “${initial.name}”` : 'Add remote connection'}</h3>
        <label>Name<input value={c.name} placeholder={c.host || 'My server'} onChange={(e) => set('name', e.target.value)} autoFocus /></label>
        <label>Protocol
          <select value={c.protocol} onChange={(e) => set('protocol', e.target.value as RemoteProtocol)}>
            {PROTOCOLS.map((p) => <option key={p.v} value={p.v}>{p.label}</option>)}
          </select>
        </label>
        <div className="remote-row">
          <label className="grow">Server<input value={c.host} placeholder="files.example.com" spellCheck={false} onChange={(e) => set('host', e.target.value)} required /></label>
          <label className="port">Port<input type="number" min={1} max={65535} value={c.port || ''} placeholder={String(defPort)} onChange={(e) => set('port', Math.max(0, Math.min(65535, +e.target.value || 0)))} /></label>
        </div>
        <label>User name<input value={c.user} spellCheck={false} autoComplete="off" placeholder={c.protocol.startsWith('ftp') ? 'anonymous' : ''} onChange={(e) => set('user', e.target.value)} /></label>
        <label>Folder to open<input value={c.path} spellCheck={false} placeholder="/" onChange={(e) => set('path', e.target.value)} /></label>
        {sftp && (
          <div className="remote-auth">
            <span className="muted small">Sign in with</span>
            <Segmented id="remote-auth" value={useKey ? 'key' : 'pw'} options={[{ v: 'pw', label: 'Password' }, { v: 'key', label: 'SSH key file' }]} onChange={(v) => { setUseKey(v === 'key'); setError(null); }} />
          </div>
        )}
        {sftp && useKey && <label>Key file<input value={c.keyFile} spellCheck={false} placeholder="C:\Users\me\.ssh\id_ed25519" onChange={(e) => set('keyFile', e.target.value)} /></label>}
        <label>{sftp && useKey ? 'Key passphrase (if any)' : 'Password'}
          <input type="password" value={secret} autoComplete="new-password" placeholder={initial ? 'Saved; type to change' : ''} onChange={(e) => { setSecret(e.target.value); setError(null); }} />
        </label>
        <p className="muted small">Passwords are kept in Windows Credential Manager, never in Delta's settings.</p>

        {trust && (
          <div className={`remote-trust${trust.changed ? ' danger' : ''}`} role="alert">
            {trust.changed ? <ShieldAlert size={18} /> : <ShieldCheck size={18} />}
            <div>
              <strong>{trust.changed ? 'The server\'s host key changed' : 'Trust this server?'}</strong>
              <p className="small">{trust.changed ? 'This can mean someone is intercepting the connection. Only trust it if you know the server was reinstalled or re-keyed.' : 'First connection to this server. Check that the fingerprint matches the one your server admin gave you.'}</p>
              <code>{trust.fp}</code>
              <button type="button" className={`btn small ${trust.changed ? 'danger' : 'primary'}`} onClick={() => save(trust.fp)}>Trust this key and connect</button>
            </div>
          </div>
        )}
        {error && <p className="remote-error" role="alert">{error}</p>}

        <div className="confirm-buttons remote-buttons">
          {initial && <button type="button" className="btn danger" onClick={remove}><Trash2 size={14} />Remove</button>}
          <span className="grow" />
          {error && <button type="button" className="btn" onClick={() => commit(final()).catch((e) => setError(String(e)))} title="Keep these settings even though connecting failed">Save anyway</button>}
          <button type="button" className="btn" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>{busy ? <><span className="spinner" aria-hidden />Connecting…</> : 'Connect and save'}</button>
        </div>
      </motion.form>
    </motion.div>
  );
}
