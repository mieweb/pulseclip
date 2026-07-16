/**
 * Tailwind config for the pulseclip client.
 * Pulls in the @mieweb/ui preset so staged components use the same
 * semantic tokens (bg-card, border-border, primary scale, …) as the library.
 */
import miewebPreset from '@mieweb/ui/tailwind-preset';

/** @type {import('tailwindcss').Config} */
export default {
  presets: [miewebPreset],
  darkMode: ['class', '[data-theme="dark"]'],
};
