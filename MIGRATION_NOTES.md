# Calendar Feature Removal - Migration Notes

## Date: February 20, 2026

## Changes Made
1. Removed `calendar.html` page
2. Removed calendar navigation links from editor and library sidebars
3. Removed Brand Brain modal/UI from library page
4. Updated pricing and upgrade modal copy to remove calendar/Brand Brain benefits
5. Updated auth/success/footer/service worker routes and copy to remove calendar dependencies
6. Disabled legacy calendar and Brand Brain API endpoints in `server.js`
7. Marked calendar-related database tables as deprecated in schema comments

## Files Deleted
- `calendar.html`
- `script.js`
- `brand-brain.js`
- `calendar-prompts-snapshot.md`
- `services/brand-brain.js`
- `tests/checkCalendarPrompt.js`

## Database Tables (Marked Deprecated, Not Dropped)
- `calendars`
- `brand_brain_settings`
- `feature_usage`

## Rollback Plan
If rollback is needed, restore from the git commit immediately before this feature-removal change set.

## Next Steps
1. Monitor errors and feature usage for 30 days
2. Remove dead server-side calendar code paths permanently after stability window
3. Drop deprecated tables in a controlled migration
4. Update API and product documentation to AI Video Editor-only scope
