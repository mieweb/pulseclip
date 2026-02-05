/**
 * Debug logging utility
 * 
 * Toggle from console: window.toggleDebug()
 * Check status: window.isDebugEnabled()
 */

const DEBUG_KEY = 'voicepoc_debug';

// Initialize from localStorage
let debugEnabled = localStorage.getItem(DEBUG_KEY) === 'true';

export function isDebugEnabled(): boolean {
  return debugEnabled;
}

export function setDebugEnabled(enabled: boolean): void {
  debugEnabled = enabled;
  localStorage.setItem(DEBUG_KEY, enabled ? 'true' : 'false');
  console.log(`[Debug] ${enabled ? 'ENABLED' : 'DISABLED'}`);
}

export function toggleDebug(): boolean {
  setDebugEnabled(!debugEnabled);
  return debugEnabled;
}

export function debug(category: string, message: string, ...args: unknown[]): void {
  if (debugEnabled) {
    console.log(`[${category}] ${message}`, ...args);
  }
}

// Expose to window for console access
declare global {
  interface Window {
    toggleDebug: () => boolean;
    isDebugEnabled: () => boolean;
    setDebugEnabled: (enabled: boolean) => void;
  }
}

window.toggleDebug = toggleDebug;
window.isDebugEnabled = isDebugEnabled;
window.setDebugEnabled = setDebugEnabled;
