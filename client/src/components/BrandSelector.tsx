import { useEffect, useState, type FC } from 'react';
import { Select } from '@mieweb/ui/components/Select';
import { brands, generateBrandCSS } from '@mieweb/ui/brands';

const STORAGE_KEY = 'pulseclip_brand';
const STYLE_ID = 'pulseclip-brand-css';

/** Display labels for the @mieweb/ui brand registry */
const BRAND_LABELS: Record<string, string> = {
  mieweb: 'MIE',
  'enterprise-health': 'Enterprise Health',
  bluehive: 'BlueHive',
  webchart: 'WebChart',
  ccme: 'CCME',
  ozwell: 'Ozwell',
  waggleline: 'Waggleline',
  default: 'Default',
};

const BRAND_OPTIONS = Object.keys(brands)
  .sort((a, b) => (BRAND_LABELS[a] || a).localeCompare(BRAND_LABELS[b] || b))
  .map((key) => ({ value: key, label: BRAND_LABELS[key] || key }));

/** Load a brand's config and inject its CSS variables, overriding the base brand */
async function applyBrand(key: string): Promise<void> {
  const loader = brands[key as keyof typeof brands];
  if (!loader) return;
  const config = await loader();
  let styleEl = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement('style');
    styleEl.id = STYLE_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = generateBrandCSS(config);
}

/** Restore the persisted brand on app boot (no-op for the default mieweb brand) */
export function restoreBrand(): void {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && saved !== 'mieweb') {
    void applyBrand(saved);
  }
}

/** Dropdown that switches the active @mieweb/ui brand color theme at runtime */
export const BrandSelector: FC = () => {
  const [brand, setBrand] = useState<string>(() => localStorage.getItem(STORAGE_KEY) || 'mieweb');

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, brand);
    void applyBrand(brand);
  }, [brand]);

  return (
    <Select
      options={BRAND_OPTIONS}
      value={brand}
      onValueChange={setBrand}
      size="sm"
      label="Brand color theme"
      hideLabel
      className="w-36"
    />
  );
};
