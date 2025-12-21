// Centralized footer injection across pages
const COPYRIGHT_TEXT = `© ${new Date().getFullYear()} Promptly. All rights reserved.`;

const FOOTER_LINK_SECTIONS = [
  {
    title: 'Platform',
    links: [
      { label: 'Home', href: '/' },
      { label: 'Content Library', href: '/library.html' },
      { label: 'Analytics', href: '/analytics.html' }
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
      { label: 'Contact', href: '/contact.html' },
      { label: 'Reset Access', href: '/reset-password.html' }
    ]
  }
];

const FOOTER_SOCIAL_LINKS = [];

function renderLinkSections() {
  return FOOTER_LINK_SECTIONS.map((section) => `
      <div class="footer__column">
        <p class="footer__column-title">${section.title}</p>
        <ul class="footer__link-list">
          ${section.links
            .map((link) => `
              <li>
                <a href="${link.href}">${link.label}</a>
              </li>
            `)
            .join('')}
        </ul>
      </div>
    `)
    .join('');
}

function renderSocialLinks() {
  return FOOTER_SOCIAL_LINKS.map((link) => {
    const attrs = link.external
      ? ' target="_blank" rel="noreferrer noopener"'
      : '';
    return `<a href="${link.href}"${attrs}>${link.label}</a>`;
  }).join('');
}

function ensureFooter() {
  // Prefer to append inside app shell if present
  const container = document.querySelector('.app-shell') || document.body;
  let footer = document.querySelector('footer.footer');

  if (!footer) {
    footer = document.createElement('footer');
    footer.className = 'footer';
    container.appendChild(footer);
  }

  const sectionsMarkup = renderLinkSections();
  const socialsMarkup = renderSocialLinks();

  footer.innerHTML = `
    <div class="footer__inner">
      <div class="footer__brand">
        <p class="footer__eyebrow">Promptly</p>
        <p class="footer__tagline">Content studio that keeps campaigns organized, aligned, and moving fast.</p>
      </div>
      <nav class="footer__links" aria-label="Footer">
        ${sectionsMarkup}
      </nav>
    </div>
    <div class="footer__meta">
      <div class="footer__legal">
        <span>${COPYRIGHT_TEXT}</span>
      </div>
      <div class="footer__socials" aria-label="Social links">
        ${socialsMarkup}
      </div>
    </div>
  `;
}

ensureFooter();
