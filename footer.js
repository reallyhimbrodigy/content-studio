const COPYRIGHT_TEXT = `© ${new Date().getFullYear()} Promptly. All rights reserved.`;

const FOOTER_COLUMNS = [
  {
    title: 'Product',
    links: [
      { label: 'Home', href: '/' },
      { label: 'How It Works', href: '/#how-it-works' },
      { label: 'Features', href: '/#features' },
      { label: 'Pricing', href: '/#pricing' },
      { label: 'Download on iOS', href: '/#download' }
    ]
  },
  {
    title: 'Resources',
    links: [
      { label: 'Help Center', href: '/help.html' },
      { label: 'Contact', href: '/contact.html' },
      { label: 'Privacy Policy', href: '/privacy.html' },
      { label: 'Terms of Service', href: '/terms.html' }
    ]
  },
  {
    title: 'Company',
    links: [
      { label: 'About Promptly', href: '/#how-it-works' },
      { label: 'Email Support', href: 'mailto:support@usepromptly.app' }
    ]
  }
];

function ensureFooter() {
  const container = document.querySelector('.app-shell') || document.body;
  let footer = document.querySelector('footer.site-footer, footer.footer');

  if (!footer) {
    footer = document.createElement('footer');
    container.appendChild(footer);
  }

  footer.className = 'site-footer';

  // <picture> swaps the mark between black-on-light and white-on-dark
  // via prefers-color-scheme. Same pattern the homepage nav uses.
  footer.innerHTML = `
    <div class="site-footer__container">
      <div class="site-footer__grid">
        <div class="site-footer__brand">
          <a href="/" class="site-footer__logo-link" aria-label="Promptly Home">
            <picture>
              <source srcset="/assets/promptly-mark-black.png" media="(prefers-color-scheme: light)" />
              <img src="/assets/promptly-mark-white.png" alt="Promptly" class="site-footer__logo-img" width="28" height="28" />
            </picture>
            <span class="site-footer__logo-text">Promptly</span>
          </a>
          <p class="site-footer__tagline">AI video editor for iPhone creators. Talking-head clip in, viral short out.</p>
        </div>
        ${FOOTER_COLUMNS.map((column) => `
          <div class="site-footer__col">
            <h3 class="site-footer__col-title">${column.title}</h3>
            <ul class="site-footer__col-links">
              ${column.links.map((link) => `<li><a href="${link.href}">${link.label}</a></li>`).join('')}
            </ul>
          </div>
        `).join('')}
      </div>
      <div class="site-footer__bottom">
        <p class="site-footer__copyright">${COPYRIGHT_TEXT}</p>
      </div>
    </div>
  `;
}

ensureFooter();
