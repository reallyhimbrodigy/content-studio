const COPYRIGHT_TEXT = `© ${new Date().getFullYear()} Promptly. All rights reserved.`;

const FOOTER_COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Home', href: '/' },
      { label: 'AI Editor', href: '/editor' },
      { label: 'How It Works', href: '/#how-it-works' },
      { label: 'Features', href: '/#features' },
      { label: 'Pricing', href: '/#pricing' }
    ]
  },
  {
    title: 'Account',
    links: [
      { label: 'Sign Up', href: '/auth.html' },
      { label: 'Log In', href: '/auth.html?mode=login' },
      { label: 'Library', href: '/library.html' },
      { label: 'Reset Access', href: '/reset-password.html' }
    ]
  },
  {
    title: 'Resources',
    links: [
      { label: 'Help Center', href: '/help.html' },
      { label: 'Privacy Policy', href: '/privacy.html' },
      { label: 'Terms of Service', href: '/terms.html' }
    ]
  },
  {
    title: 'Company',
    links: [
      { label: 'Contact', href: '/contact.html' }
    ]
  }
];

function getLogoSrc() {
  return '/assets/promptly-mark-white.png';
}

function renderColumns() {
  return FOOTER_COLUMNS.map((column) => `
    <div class="site-footer__col">
      <h3 class="site-footer__col-title">${column.title}</h3>
      <ul class="site-footer__col-links">
        ${column.links
          .map((link) => `<li><a href="${link.href}">${link.label}</a></li>`)
          .join('')}
      </ul>
    </div>
  `).join('');
}

function ensureFooter() {
  const container = document.querySelector('.app-shell') || document.body;
  let footer = document.querySelector('footer.site-footer, footer.footer');

  if (!footer) {
    footer = document.createElement('footer');
    container.appendChild(footer);
  }

  footer.className = 'site-footer';

  footer.innerHTML = `
    <div class="site-footer__container">
      <div class="site-footer__grid">
        <div class="site-footer__brand">
          <a href="/" class="site-footer__logo-link" aria-label="Promptly Home">
            <img src="${getLogoSrc()}" alt="Promptly" class="site-footer__logo-img" />
            <span class="site-footer__logo-text">Promptly</span>
          </a>
          <p class="site-footer__tagline">Professional video edits in 60 seconds.</p>
        </div>
        ${renderColumns()}
      </div>
      <div class="site-footer__bottom">
        <p class="site-footer__copyright">${COPYRIGHT_TEXT}</p>
      </div>
    </div>
  `;
}

ensureFooter();
