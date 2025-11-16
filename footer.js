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

  // Set/replace content
  footer.innerHTML = `<p>${COPYRIGHT_TEXT}</p>`;
}

ensureFooter();
