import type { FC } from 'react';
import { useState, useEffect } from 'react';
import { Card } from '@mieweb/ui/components/Card';
import { Button } from '@mieweb/ui/components/Button';
import { Modal, ModalHeader, ModalTitle, ModalClose, ModalBody } from '@mieweb/ui/components/Modal';

/** Store pages for the Pulse app — static, shown before any pairing fetch */
const STORE_LINKS = {
  ios: 'https://apps.apple.com/us/app/pulse-cam/id6748621024',
  android: 'https://play.google.com/store/apps/details?id=com.mieweb.pulse',
};

/** App Store / Google Play badge pair (official badge art) */
function StoreBadges({ appleHeight, googleHeight }: { appleHeight: number; googleHeight: number }) {
  return (
    <div className="flex items-center justify-center gap-3">
      <a
        href={STORE_LINKS.ios}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Download on the App Store"
      >
        <img
          src="https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83"
          alt="Download on the App Store"
          height={appleHeight}
          style={{ height: appleHeight }}
        />
      </a>
      <a
        href={STORE_LINKS.android}
        target="_blank"
        rel="noopener noreferrer"
        aria-label="Get it on Google Play"
      >
        <img
          src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png"
          alt="Get it on Google Play"
          height={googleHeight}
          style={{ height: googleHeight }}
        />
      </a>
    </div>
  );
}

interface PulseCamDeeplinkResponse {
  deeplink: string;
  serverUrl: string;
  token: string;
  appStoreLinks: {
    ios: string;
    android: string;
  };
}

interface PulseCamButtonProps {
  onError?: (error: string) => void;
}

/**
 * Button to launch PulseCam mobile app for video recording
 * Shows QR code on desktop, deep link on mobile
 */
export const PulseCamButton: FC<PulseCamButtonProps> = ({ onError }) => {
  const [deeplinkData, setDeeplinkData] = useState<PulseCamDeeplinkResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    // Detect if user is on mobile and platform
    const checkMobile = () => {
      const userAgent = navigator.userAgent.toLowerCase();
      return /iphone|ipad|ipod|android/.test(userAgent);
    };
    setIsMobile(checkMobile());
  }, []);

  const fetchDeeplink = async () => {
    setLoading(true);
    try {
      const response = await fetch('/api/pulsecam/deeplink');
      if (!response.ok) {
        throw new Error('Failed to generate deep link');
      }
      const data = await response.json();
      setDeeplinkData(data);

      if (isMobile) {
        // On mobile, try to open the app directly
        window.location.href = data.deeplink;
      } else {
        // On desktop, show modal with QR code
        setShowModal(true);
      }
    } catch (error) {
      console.error('Failed to get PulseCam deep link:', error);
      onError?.(error instanceof Error ? error.message : 'Failed to connect');
    } finally {
      setLoading(false);
    }
  };

  // Generate QR code URL using a QR code API
  const getQrCodeUrl = (data: string): string => {
    const encoded = encodeURIComponent(data);
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}&bgcolor=ffffff&color=111111`;
  };

  return (
    <>
      <Card padding="lg" className="h-full">
        <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-center">
          <img
            src="/pulse-icon.png"
            alt=""
            aria-hidden="true"
            className="h-12 w-12 rounded-xl shadow-sm"
          />
          <p className="m-0 font-medium text-foreground">Record with your phone</p>
          <Button
            onClick={fetchDeeplink}
            isLoading={loading}
            loadingText="Connecting..."
            size="sm"
            aria-label="Record with PulseCam mobile app"
          >
            {isMobile ? 'Open PulseCam' : 'Launch PulseCam'}
          </Button>
          <p className="m-0 text-xs text-muted-foreground">
            Scan a QR code to connect &mdash; iOS &amp; Android
          </p>
          <StoreBadges appleHeight={32} googleHeight={48} />
        </div>
      </Card>

      <Modal open={showModal && !!deeplinkData} onOpenChange={(open) => !open && setShowModal(false)} size="sm">
        <ModalHeader>
          <ModalTitle>
            <span className="flex items-center gap-2">
              <img src="/pulse-icon.png" alt="" aria-hidden="true" className="h-6 w-6 rounded-md" />
              Record with PulseCam
            </span>
          </ModalTitle>
          <ModalClose />
        </ModalHeader>
        <ModalBody>
          <div className="flex flex-col items-center gap-4 text-center">
            <p className="m-0 text-sm text-muted-foreground">
              Scan this QR code with your phone to start recording. Videos upload directly to PulseClip.
            </p>
            {deeplinkData && (
              <div className="rounded-lg border border-border bg-white p-3">
                <img
                  src={getQrCodeUrl(deeplinkData.deeplink)}
                  alt="PulseCam QR Code"
                  width={200}
                  height={200}
                />
              </div>
            )}
            <div className="flex flex-col items-center gap-2">
              <p className="m-0 text-xs text-muted-foreground">Don&apos;t have PulseCam?</p>
              <StoreBadges appleHeight={40} googleHeight={60} />
            </div>
          </div>
        </ModalBody>
      </Modal>
    </>
  );
};
