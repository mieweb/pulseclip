import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { ThemeProvider } from '@mieweb/ui/components/ThemeProvider';
import App from './App.tsx';
import { LoginLanding } from './components/LoginLanding.tsx';
import { SharedArtipod } from './components/SharedArtipod.tsx';
import './mieweb-ui.css';
import './index.scss';
import './debug'; // Initialize debug utilities on window

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider defaultTheme="system">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<App />} />
          <Route path="/login" element={<LoginLanding />} />
          <Route path="/artipod/:artipodId" element={<App />} />
          <Route path="/share/:token" element={<SharedArtipod />} />
          {/* Legacy route for backward compatibility */}
          <Route path="/file/:artipodId" element={<App />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  </React.StrictMode>,
);
