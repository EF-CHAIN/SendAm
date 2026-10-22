import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.jsx';
import { registerSW } from 'virtual:pwa-register';
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
