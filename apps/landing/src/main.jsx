import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { registerSW } from 'virtual:pwa-register';
import { swUpdate } from '@/lib/swUpdate.js';

if (import.meta.env.DEV && import.meta.env.VITE_USE_MSW === 'true') {
  import('./mocks/browser').then(({ worker }) => {
    worker.start();
  });
}

// The worker waits after installing an update; UpdatePrompt offers the reload.
const updateSW = registerSW({
  onNeedRefresh: () => swUpdate.needRefresh(updateSW),
  onOfflineReady: () => swUpdate.offlineReady(),
});
import { startDevContrastCheck } from '@shared/contrast.js';
import { initTheme } from './lib/theme.js';

initTheme();
registerSW();
startDevContrastCheck({ devMode: import.meta.env.DEV });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
