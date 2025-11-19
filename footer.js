// Centralized footer injection across pages
const COPYRIGHT_TEXT = `© ${new Date().getFullYear()} Promptly. All rights reserved.`;

function ensureFooter() {
  // Prefer to append inside app shell if present
  const container = document.querySelector('.app-shell') || document.body;
  let footer = document.querySelector('footer.footer');

  if (!footer) {
    footer = document.createElement('footer');
    footer.className = 'footer';
    container.appendChild(footer);
  }

  // Set/replace content with helpful links
  footer.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; align-items:center; gap:0.75rem; justify-content:space-between;">
      <p style="margin:0">${COPYRIGHT_TEXT}</p>
      <nav style=\"display:flex; gap:0.75rem; flex-wrap:wrap; font-size:0.95rem;\">
        <a href=\"/help.html\" class=\"ghost\" style=\"text-decoration:none;\">Help</a>
        <a href=\"/changelog.html\" class=\"ghost\" style=\"text-decoration:none;\">Changelog</a>
        <a href=\"/terms.html\" class=\"ghost\" style=\"text-decoration:none;\">Terms</a>
        <a href=\"/privacy.html\" class=\"ghost\" style=\"text-decoration:none;\">Privacy</a>
        <a href=\"/contact.html\" class=\"ghost\" style=\"text-decoration:none;\">Contact</a>
        <a href=\"/library.html\" class=\"ghost\" style=\"text-decoration:none;\">Library</a>
      </nav>
    </div>
  `;
}

ensureFooter();
