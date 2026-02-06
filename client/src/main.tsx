import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route } from 'react-router-dom';
import App from './App.tsx';
import './index.scss';
import './debug'; // Initialize debug utilities on window

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<App />} />
        <Route path="/artipod/:artipodId" element={<App />} />
        {/* Legacy route for backward compatibility */}
        <Route path="/file/:artipodId" element={<App />} />
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
);
