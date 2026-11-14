import { Component, StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import { installSmoothScroll } from './smoothScroll';

installSmoothScroll();

// Only Delta's own menus: suppress the WebView's built-in one (Back/Refresh/Print) except in text fields.
document.addEventListener('contextmenu', (e) => {
  if (!(e.target as HTMLElement).closest('input, textarea')) e.preventDefault();
});

/** A render error would otherwise unmount everything and leave a blank window; show it and offer a reload. */
class Crash extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    const e = this.state.error;
    if (!e) return this.props.children;
    return (
      <div className="crash" role="alert">
        <h1>Delta Explorer hit an error</h1>
        <pre>{String(e.stack || e)}</pre>
        <button className="btn" onClick={() => location.reload()}>Reload</button>
      </div>
    );
  }
}

// Files dropped from other apps are handled by Tauri (dragdrop.tsx). Never let the WebView itself
// "open" a dropped file by navigating to it, which would replace the app with an error page.
for (const t of ['dragover', 'drop'] as const) document.addEventListener(t, (e) => e.preventDefault());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Crash><App /></Crash>
  </StrictMode>,
);
