import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { startDevContrastCheck } from '@shared/contrast.js';

async function enableMocking() {
  if (!import.meta.env.DEV || import.meta.env.VITE_USE_MSW !== 'true') {
    return;
  }
  const { startMockWorker } = await import('./mocks/browser.js');
  await startMockWorker({ enabled: true });
}

startDevContrastCheck({ devMode: import.meta.env.DEV });

enableMocking().then(() => {
  createRoot(document.getElementById('root')).render(
    <StrictMode>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </StrictMode>,
  );
});
