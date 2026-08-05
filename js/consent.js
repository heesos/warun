(() => {
  const GA_ID = 'G-NQQQYTXC3Q';
  const CONSENT_KEY = 'warun-cookie-consent';

  const banner = document.getElementById('cookie-banner');
  const acceptBtn = document.getElementById('cookie-accept');
  const declineBtn = document.getElementById('cookie-decline');
  const settingsLink = document.getElementById('cookie-settings-link');

  function loadAnalytics() {
    window[`ga-disable-${GA_ID}`] = false;
    if (window.gtag) return;
    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('js', new Date());
    window.gtag('config', GA_ID);
    const script = document.createElement('script');
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${GA_ID}`;
    document.head.appendChild(script);
  }

  // GA4's documented opt-out flag - stops it recording hits even once loaded,
  // so switching from Accept to Decline works without a page reload.
  function disableAnalytics() {
    window[`ga-disable-${GA_ID}`] = true;
  }

  function applyConsent(choice) {
    localStorage.setItem(CONSENT_KEY, choice);
    if (choice === 'accepted') {
      loadAnalytics();
    } else {
      disableAnalytics();
    }
    if (banner) banner.hidden = true;
  }

  const stored = localStorage.getItem(CONSENT_KEY);
  if (stored === 'accepted') {
    loadAnalytics();
  } else if (stored === 'declined') {
    disableAnalytics();
  } else if (banner) {
    banner.hidden = false;
  }

  acceptBtn?.addEventListener('click', () => applyConsent('accepted'));
  declineBtn?.addEventListener('click', () => applyConsent('declined'));
  settingsLink?.addEventListener('click', (event) => {
    event.preventDefault();
    if (banner) banner.hidden = false;
  });
})();
