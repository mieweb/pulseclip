import './LoginLanding.scss';
import { useLocation } from 'react-router-dom';

function getDestination(requestedDestination: string | null) {
  if (!requestedDestination) {
    return '/';
  }

  try {
    const destinationUrl = new URL(requestedDestination, window.location.origin);

    return destinationUrl.origin === window.location.origin
      ? `${destinationUrl.pathname}${destinationUrl.search}${destinationUrl.hash}`
      : '/';
  } catch {
    return '/';
  }
}

export function LoginLanding() {
  const location = useLocation();
  const destination = getDestination(new URLSearchParams(location.search).get('rd'));

  return (
    <main className="login-landing">
      <section className="login-landing__content" aria-labelledby="login-landing-title">
        <div className="login-landing__brand" aria-label="PulseClip">
          <span className="login-landing__mark" aria-hidden="true">
            <span className="login-landing__mark-bar login-landing__mark-bar--short" />
            <span className="login-landing__mark-bar login-landing__mark-bar--tall" />
            <span className="login-landing__mark-bar login-landing__mark-bar--middle" />
            <span className="login-landing__mark-bar login-landing__mark-bar--tall" />
            <span className="login-landing__mark-bar login-landing__mark-bar--short" />
          </span>
          <span className="login-landing__wordmark">PulseClip</span>
        </div>

        <div className="login-landing__intro">
          <p className="login-landing__eyebrow">Media transcription workspace</p>
          <h1 id="login-landing-title">Turn recordings into clear, editable transcripts.</h1>
          <p>Sign in to access your PulseClip workspace.</p>
        </div>

        <a className="login-landing__google-button" href={`/oauth2/sign_in?rd=${encodeURIComponent(destination)}`} aria-label="Log in to PulseClip with Google">
          <span className="login-landing__google-icon" aria-hidden="true">G</span>
          <span>Log in with Google</span>
        </a>
      </section>
    </main>
  );
}