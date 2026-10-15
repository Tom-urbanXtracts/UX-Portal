# Store Workspace onboarding design QA

## Evidence

- Source visual truth path: `/Users/Apple/Documents/GitHub/UX-Portal/artifacts/store-onboarding/source-brand-company.png`
- Original content source: `/Users/Apple/Documents/GitHub/UX-Portal/artifacts/store-onboarding/source-monday-form.png`
- Implementation screenshot path: `/Users/Apple/Documents/GitHub/UX-Portal/artifacts/store-onboarding/implementation-six-section.png`
- Combined comparison surface: `/Users/Apple/Documents/GitHub/UX-Portal/artifacts/store-onboarding/design-comparison.html`
- Rendered implementation: `http://127.0.0.1:4173/dist/portal.html?v=8#onboarding-preview`
- Desktop viewport/state: 1440 × 1000 CSS px, section 01 Company Profile, empty onboarding state. The captured implementation is 1440 × 970 px; browser chrome is excluded and no density resampling was used.
- Source pixels: 2400 × 1624. The Brand reference and Store implementation are top-aligned and scaled into equal comparison columns; the comparison is structural rather than a 1:1 pixel-density claim.
- Responsive evidence: the in-app browser's initial 658 px-wide view collapsed the workspace to one column while keeping the six-section journey horizontally scrollable.

## Findings

No actionable P0, P1, or P2 differences remain. The Store screen now carries the same defining Brand onboarding structure: six journey tiles, a draft-status strip, persistent section queue, active form workspace, supporting-document rail, progress/readiness states, and a final review action.

The absent authenticated Brand sidebar, reviewer assignment, and section approval badges are intentional. Store onboarding is a public intake boundary, so it cannot imply an authenticated reviewer or server-side approval state before the final request is submitted.

## Full-view comparison evidence

The Brand reference and rendered Store implementation were opened together in the combined comparison surface. Both lead with Company & Onboarding, present six horizontal journey tiles, follow with a pale-green draft/status strip, and use the same three-column desktop composition. The Store version preserves the portal's warm ground, black ink, green operational accent, Archivo typography, square controls, compact monospaced metadata, and rule-based information density.

The Store workspace adapts the Brand sections to Company Profile, Store & Licence, Contacts & Access, Delivery & Commercial, Documents & Terms, and Review & Submit. All Omeed-source fields remain represented within that structure.

## Focused-region evidence

The active-section region was readable in the full desktop capture, so a separate crop was unnecessary. The comparison visibly confirms the active Company Profile treatment, left section queue, draft action, completion percentage, supporting licence control, and request-readiness summary. Browser interaction then filled the legal business name and advanced to Store & Licence, confirming that forward validation and section navigation work together.

## Required fidelity surfaces

- Fonts and typography: Archivo, the Brand screen's bold display hierarchy, and monospaced operational metadata are preserved. Labels and statuses remain optically distinct at the tested desktop and narrow widths.
- Spacing and layout rhythm: the desktop uses the Brand screen's journey strip plus 220 px / flexible / 230 px workspace proportions. Square cards, fine rules, compact padding, and restrained vertical rhythm match the existing Portal system.
- Colors and visual tokens: the implementation uses the same ink, warm neutral, green accent, pale green status strip, and clay error tokens. Active and readiness states keep adequate contrast.
- Image quality and asset fidelity: the existing urbanXtracts logo asset is reused. No target logo, icon, or decorative image was replaced with generated art, custom SVG, CSS drawing, emoji, or a placeholder.
- Copy and content: the section names and explanatory copy are Store-specific, while the workflow language clearly distinguishes browser-tab drafts from a submitted request and avoids claiming approval before qualification.

## Primary interactions tested

- Rendered the local-only onboarding preview in the in-app browser.
- Confirmed all six journey tiles, section cards, readiness rows, supporting-document rail, and active section were present.
- Entered a synthetic legal business name and advanced from Company Profile to Store & Licence.
- Reloaded to the clean empty state without submitting or transmitting a request.
- Checked the final browser tab for console errors after navigation: none.
- Verified the responsive one-column workspace in the initial narrow in-app-browser view.

## Comparison history

1. Prior intake pass — the Store form used four sequential wizard steps. Fix: reorganized the exact Store fields into the Brand workspace's six-section journey and added persistent navigation, per-section progress, an always-visible document rail, explicit draft retention, and a final review boundary.
2. Boundary review — the first draft language could have implied Brand-like server approval semantics. Fix: limited drafts to the current browser-tab session, requires files to be reselected, and states that only final submission starts qualification and review.
3. Final visual pass — the side-by-side Brand/Store comparison shows no actionable P0, P1, or P2 fidelity issue. Public-versus-authenticated differences are explicit product constraints.

## Follow-up polish

- P3: if abandonment data warrants it, move Store drafts from tab-session storage to an authenticated, server-side draft record with explicit retention and deletion policy.

final result: passed

---

# Brand workspace design QA

Retained prior release evidence:

- Company implementation: `/tmp/ux-brand-design/implemented-company-final.png`
- Home implementation: `/tmp/ux-brand-design/implemented-home-final.png`
- Company now exposes the six-stage journey, section queue, active form, and supporting-document rail in one desktop workspace.
- Home now leads with wholesale performance, onboarding progress, SKU performance, and actionable exceptions.
- Retailer/store identity and retailer sell-through remain explicitly excluded from Brand views.

## Result

passed
