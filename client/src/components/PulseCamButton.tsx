import type { FC } from 'react';
import { useState, useEffect } from 'react';
import './PulseCamButton.scss';

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

  const handleClick = () => {
    fetchDeeplink();
  };

  const closeModal = () => {
    setShowModal(false);
  };

  // Generate QR code URL using a QR code API
  const getQrCodeUrl = (data: string): string => {
    const encoded = encodeURIComponent(data);
    return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encoded}&bgcolor=1a1a2e&color=ffffff`;
  };

  return (
    <>
      <div className="pulsecam-card">
        <span className="pulsecam-card__icon" role="img" aria-hidden="true">📱</span>
        <span className="pulsecam-card__text">Use your phone as a camera</span>
        <span className="pulsecam-card__hint">Scan QR code to connect</span>
        <button
          className="pulsecam-card__button"
          onClick={handleClick}
          disabled={loading}
          aria-label="Record with PulseCam mobile app"
        >
          {loading ? 'Loading...' : isMobile ? 'Open PulseCam' : 'Launch PulseCam'}
        </button>
        <span className="pulsecam-card__formats">iOS &amp; Android</span>
      </div>

      {showModal && deeplinkData && (
        <div className="pulsecam-modal" onClick={closeModal} role="dialog" aria-modal="true" aria-label="PulseCam QR Code">
          <div className="pulsecam-modal__content" onClick={e => e.stopPropagation()}>
            <button 
              className="pulsecam-modal__close" 
              onClick={closeModal}
              aria-label="Close modal"
            >
              ×
            </button>
            
            <h2 className="pulsecam-modal__title">Record with PulseCam</h2>
            <p className="pulsecam-modal__subtitle">
              Scan this QR code with your phone to start recording
            </p>
            
            <div className="pulsecam-modal__qr">
              <img 
                src={getQrCodeUrl(deeplinkData.deeplink)} 
                alt="PulseCam QR Code"
                width={200}
                height={200}
              />
            </div>

            <p className="pulsecam-modal__instruction">
              Videos will be uploaded directly to PulseClip
            </p>

            <div className="pulsecam-modal__stores">
              <p className="pulsecam-modal__stores-label">Don't have PulseCam?</p>
              <div className="pulsecam-modal__store-links">
                <a 
                  href={deeplinkData.appStoreLinks.ios}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pulsecam-modal__store-link"
                  aria-label="Download on the App Store"
                >
                  <img 
                    src="https://tools.applemediaservices.com/api/badges/download-on-the-app-store/black/en-us?size=250x83" 
                    alt="Download on the App Store"
                    height={40}
                  />
                </a>
                <a 
                  href={deeplinkData.appStoreLinks.android}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pulsecam-modal__store-link"
                  aria-label="Get it on Google Play"
                >
                  <img 
                    src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png" 
                    alt="Get it on Google Play"
                    height={60}
                  />
                </a>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
