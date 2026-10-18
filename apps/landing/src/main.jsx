import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { registerSW } from 'virtual:pwa-register';
import { swUpdate } from '@/lib/swUpdate.js';

// The worker waits after installing an update; UpdatePrompt offers the reload.
const updateSW = registerSW({
  onNeedRefresh: () => swUpdate.needRefresh(updateSW),
  onOfflineReady: () => swUpdate.offlineReady(),
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
