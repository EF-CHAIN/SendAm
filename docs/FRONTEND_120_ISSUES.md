# SendAm 120 Frontend Issue Backlog (Non-Backend)

**Project:** `EF-CHAIN/SendAm`  
**Target Areas:** `apps/landing`, `apps/admin`, `apps/chat-sim`, `packages/shared`, Frontend E2E / Unit Tests, PWA & Web Vitals  
**Constraint:** Purely frontend, client UI/UX, accessibility, design systems, performance, and client testing. **Zero backend touches.**

---

## Executive Summary

This backlog specifies **120 production-grade, actionable frontend issues** across the SendAm monorepo. Every issue is strictly scoped to frontend codebases, avoiding backend services, databases, or API routes.

### Distribution by Area:
1. **Apps / Landing (`apps/landing`):** 30 Issues (#1 - #30)
2. **Apps / Admin (`apps/admin`):** 35 Issues (#31 - #65)
3. **Apps / Chat Simulator (`apps/chat-sim`):** 20 Issues (#66 - #85)
4. **Packages / Shared (`packages/shared`):** 15 Issues (#86 - #100)
5. **Frontend Performance, SEO & PWA:** 10 Issues (#101 - #110)
6. **Frontend Testing & Accessibility Quality Assurance:** 10 Issues (#111 - #120)

---

## Issue 1: Add live rate staleness warning and countdown timer in CurrencyCalculator.jsx

**Target Area:** `apps/landing/src/components/CurrencyCalculator.jsx`  
**Category:** Landing / UI & Data Freshness  
**Labels:** `landing, frontend, currency-calculator, ux`

### Problem
Exchange rates fluctuate frequently on the Stellar network. CurrencyCalculator currently displays static rates without indicating when the rates were last refreshed or if they are stale.

### Required Frontend Scope
Add a live countdown badge displaying 'Rates refresh in 30s', an animated pulse dot indicating connection state, and a warning alert if the rates are older than 60 seconds.

### Acceptance Criteria
- User sees countdown timer; when expired, triggers refresh; shows clear visual warning if rates fail to refresh or become stale.

---

## Issue 2: Implement WebGL context loss recovery and 2D canvas fallback in CorridorGlobe.jsx

**Target Area:** `apps/landing/src/components/CorridorGlobe.jsx`  
**Category:** Landing / 3D Graphics & Resiliency  
**Labels:** `landing, frontend, 3d, webgl, accessibility`

### Problem
On low-power mobile devices or after GPU memory pressure, WebGL context loss causes CorridorGlobe to render as a blank or frozen block without recovery.

### Required Frontend Scope
Add listeners for 'webglcontextlost' and 'webglcontextrestored', and provide an SVG/2D canvas fallback corridor diagram if WebGL is unavailable or fails to initialize.

### Acceptance Criteria
- CorridorGlobe catches context loss, gracefully falls back to interactive SVG projection, and restores WebGL if context is restored.

---

## Issue 3: Provide keyboard-accessible corridor switcher alternative to 3D globe in CorridorGlobe.jsx

**Target Area:** `apps/landing/src/components/CorridorGlobe.jsx`  
**Category:** Landing / Accessibility & WCAG  
**Labels:** `landing, frontend, accessibility, a11y, wcag-aa`

### Problem
CorridorGlobe relies purely on pointer drag and mouse rotation to inspect payment corridors, making it inaccessible to screen reader and keyboard-only users.

### Required Frontend Scope
Add a visible, keyboard-focusable corridor selector with tablist semantics (ARIA role='tablist') allowing users to select corridors with Arrow keys and read source/target fees and times.

### Acceptance Criteria
- All payment corridors can be selected and inspected using keyboard navigation alone; screen readers announce corridor details via live region.

---

## Issue 4: Implement client-side E.164 phone number auto-formatter and country flag picker in OnboardingWizard.jsx

**Target Area:** `apps/landing/src/components/OnboardingWizard.jsx`  
**Category:** Landing / Forms & Input UX  
**Labels:** `landing, frontend, onboarding, forms, ux`

### Problem
Users entering phone numbers during onboarding must manually type country codes, leading to malformed phone strings and validation drops.

### Required Frontend Scope
Integrate a lightweight client-side country selector dropdown with flags for Nigeria (+234), Ghana (+233), Kenya (+254), UK (+44), and US (+1), automatically formatting the input to E.164.

### Acceptance Criteria
- Typing numbers formats with spaces according to national patterns; selecting a country updates prefix and validation regex instantly.

---

## Issue 5: Persist multi-step wizard state in localStorage with draft resume prompt in OnboardingWizard.jsx

**Target Area:** `apps/landing/src/components/OnboardingWizard.jsx`  
**Category:** Landing / State Persistence  
**Labels:** `landing, frontend, onboarding, local-storage, resiliency`

### Problem
If a user accidentally refreshes or navigates away while filling out the onboarding form, all inputted fields are lost, causing high drop-off rates.

### Required Frontend Scope
Add safe debounced client-side serialization to localStorage, excluding sensitive PIN fields, and show a 'Resume your application' banner if saved draft exists.

### Acceptance Criteria
- Page refresh preserves name, currency preferences, and corridor choices; clear button discards draft cleanly.

---

## Issue 6: Add interactive audio wave visualizer and scrub bar to voice message bubble in ChatMockup.jsx

**Target Area:** `apps/landing/src/components/ChatMockup.jsx`  
**Category:** Landing / Multimedia & Micro-interactions  
**Labels:** `landing, frontend, chat-mockup, audio, animations`

### Problem
ChatMockup features a voice note bubble but it displays a static line without playable audio scrubbing or interactive playback animation.

### Required Frontend Scope
Implement an animated SVG audio waveform bar with play/pause toggle, simulated time elapsed counter (0:00 / 0:14), and scrubbable progress handle.

### Acceptance Criteria
- Clicking play triggers animated waveform equalizer and increments counter smoothly until playback ends.

---

## Issue 7: Simulate WhatsApp receipt ticks (sending, sent, delivered, read) animation in ChatMockup.jsx

**Target Area:** `apps/landing/src/components/ChatMockup.jsx`  
**Category:** Landing / Micro-interactions  
**Labels:** `landing, frontend, chat-mockup, animations, ui`

### Problem
Messages in the landing mockup display static checkmarks, failing to demonstrate the real-time settlement speed of the WhatsApp-first bot.

### Required Frontend Scope
Add timed state progression for outbound messages transitioning from single grey tick (sent) to double grey ticks (delivered) to double blue ticks (read/settled).

### Acceptance Criteria
- Outbound messages animate checkmark states sequentially with subtle fade transitions matching WhatsApp Web aesthetics.

---

## Issue 8: Eliminate Cumulative Layout Shift (CLS) on Hero image load in Hero.jsx

**Target Area:** `apps/landing/src/components/Hero.jsx`  
**Category:** Landing / Core Web Vitals & Performance  
**Labels:** `landing, frontend, performance, web-vitals, cls`

### Problem
The floating mockup graphics in Hero.jsx render without explicit aspect-ratio containment, triggering layout shifts as image assets resolve.

### Required Frontend Scope
Add explicit aspect-ratio containers with CSS skeleton placeholders and priority hint (fetchpriority='high') on hero LCP image elements.

### Acceptance Criteria
- Zero layout shift during hero section load; Lighthouse CLS score maintains < 0.05 on mobile and desktop viewports.

---

## Issue 9: Add focus trap and smooth backdrop blur transition to mobile navigation drawer in Navbar.jsx

**Target Area:** `apps/landing/src/components/Navbar.jsx`  
**Category:** Landing / Navigation & Accessibility  
**Labels:** `landing, frontend, navbar, accessibility, mobile`

### Problem
When the mobile drawer opens, focus escapes into the obscured background page, and pressing Escape does not dismiss the drawer.

### Required Frontend Scope
Implement focus trapping (keeping Tab within drawer links), bind Escape key listener to close, and apply backdrop-blur-md with smooth opacity transition.

### Acceptance Criteria
- Focus cycles exclusively within mobile drawer while open; Escape or backdrop tap closes drawer and restores focus to menu toggle button.

---

## Issue 10: Implement scroll-driven SVG connector line progression in HowItWorks.jsx

**Target Area:** `apps/landing/src/components/HowItWorks.jsx`  
**Category:** Landing / Scroll Animations  
**Labels:** `landing, frontend, animation, svg, scroll`

### Problem
The 3 steps in HowItWorks appear disconnected on tablet and mobile viewports with no visual continuity between steps.

### Required Frontend Scope
Add an animated dashed SVG connector line that illuminates or fills with gradient color as the user scrolls down through Step 1, Step 2, and Step 3.

### Acceptance Criteria
- Connector line tracks scroll position smoothly without layout thrashing using requestAnimationFrame or CSS scroll-driven animation.

---

## Issue 11: Add 3D card tilt and specular highlight hover effect in Features.jsx

**Target Area:** `apps/landing/src/components/Features.jsx`  
**Category:** Landing / UI Polish & Micro-interactions  
**Labels:** `landing, frontend, css, micro-interactions, ui`

### Problem
Features cards have flat border hover states that feel dated and lack modern FinTech visual depth.

### Required Frontend Scope
Implement subtle mouse-tracking 3D perspective tilt (rotateX, rotateY) and radial specular glow following mouse cursor within each card.

### Acceptance Criteria
- Cards respond smoothly to cursor hover with subtle perspective rotation and glassmorphic glow; disabled on touch devices via pointer query.

---

## Issue 12: Implement full WAI-ARIA accordion keyboard pattern in Faq.jsx

**Target Area:** `apps/landing/src/components/Faq.jsx`  
**Category:** Landing / Accessibility & WCAG  
**Labels:** `landing, frontend, accessibility, a11y, faq`

### Problem
Accordion headers in Faq.jsx do not support ArrowUp, ArrowDown, Home, and End keyboard navigation required by WAI-ARIA 1.2 Accordion specification.

### Required Frontend Scope
Add keyboard event handler to accordion button headers enabling arrow key cycling between questions and Home/End jumping to first/last questions.

### Acceptance Criteria
- User can navigate between all FAQ items seamlessly using arrow keys; expanded state is announced via aria-expanded attributes.

---

## Issue 13: Add dynamic live Stellar network ping badge in Footer.jsx

**Target Area:** `apps/landing/src/components/Footer.jsx`  
**Category:** Landing / Transparency & UI  
**Labels:** `landing, frontend, footer, stellar, ui`

### Problem
Footer displays a static copyright without giving users real-time confidence in Stellar network operational status.

### Required Frontend Scope
Integrate a lightweight client-side network health indicator badge showing 'Stellar Mainnet: Operational' with a pulsing green indicator dot.

### Acceptance Criteria
- Badge renders in footer with accessible aria-label and tooltips linking to official Stellar status page.

---

## Issue 14: Add automated polling interval and countdown toggle in OnboardingStatus.jsx

**Target Area:** `apps/landing/src/pages/OnboardingStatus.jsx`  
**Category:** Landing / User Activation  
**Labels:** `landing, frontend, onboarding, polling, ux`

### Problem
Users checking KYC or wallet onboarding status must manually refresh the browser to discover whether their account was activated.

### Required Frontend Scope
Add automated 10-second polling with visual circular progress countdown indicator, pause/resume toggle, and exponential backoff after 5 minutes.

### Acceptance Criteria
- Status updates automatically without full page reload; user can pause auto-refresh; countdown ring clearly visualizes next check.

---

## Issue 15: Implement one-click copy button with accessible tooltip in OnboardingStatus.jsx

**Target Area:** `apps/landing/src/pages/OnboardingStatus.jsx`  
**Category:** Landing / Usability  
**Labels:** `landing, frontend, clipboard, accessibility, ui`

### Problem
Users need to copy their generated Stellar public key (G... address) to fund their wallet, but selecting the long string on mobile is prone to truncation errors.

### Required Frontend Scope
Add an accessible copy button beside the address displaying 'Copied to clipboard!' tooltip and announcing via screen-reader live region.

### Acceptance Criteria
- Clicking copies the full 56-character address; button icon swaps to checkmark for 2 seconds and reads out via ARIA live region.

---

## Issue 16: Add quick search and contextual recovery routes in NotFound.jsx

**Target Area:** `apps/landing/src/pages/NotFound.jsx`  
**Category:** Landing / Error Recovery & UX  
**Labels:** `landing, frontend, routing, 404, ux`

### Problem
The 404 page is a plain error message without helpful links to popular sections (Calculator, FAQ, Onboarding) or site search.

### Required Frontend Scope
Revamp NotFound.jsx with a search input filtering available routes, quick action pills ('Go to Calculator', 'Check Onboarding Status'), and a friendly illustration.

### Acceptance Criteria
- NotFound page renders responsive illustration, functioning quick navigation buttons, and maintains site navbar/footer.

---

## Issue 17: Implement iOS Safari 'Add to Home Screen' modal instructions in PWABanner.jsx

**Target Area:** `apps/landing/src/components/PWABanner.jsx`  
**Category:** Landing / PWA & Mobile Web  
**Labels:** `landing, frontend, pwa, ios, safari`

### Problem
iOS Safari does not support the native 'beforeinstallprompt' event, leaving iPhone users with no visual guidance on how to install the PWA.

### Required Frontend Scope
Detect iOS Safari browser user-agent and present a custom step-by-step instruction bubble pointing to the Share icon -> 'Add to Home Screen'.

### Acceptance Criteria
- iOS users see tailored instructions with share icon graphic; dismissed state is remembered in sessionStorage.

---

## Issue 18: Add offline action sync notification badge in PWABanner.jsx

**Target Area:** `apps/landing/src/components/PWABanner.jsx`  
**Category:** Landing / Offline UX & PWA  
**Labels:** `landing, frontend, pwa, offline, notifications`

### Problem
When users browse offline, they receive no indication of what features work offline or whether background sync is active.

### Required Frontend Scope
Display a subtle persistent indicator banner when offline informing users that rates are cached and online sync will resume automatically upon reconnection.

### Acceptance Criteria
- Banner appears immediately upon 'offline' window event and auto-dismisses with a green 'Back online' toast when connection restores.

---

## Issue 19: Add SVG screen reflection and dynamic device bezel color toggle in PhoneFrame.jsx

**Target Area:** `apps/landing/src/components/PhoneFrame.jsx`  
**Category:** Landing / Design Polish  
**Labels:** `landing, frontend, svg, design-system, ui`

### Problem
PhoneFrame mockup has a flat outline without realistic glass reflections or customizable bezel colors (Midnight, Titanium, Silver).

### Required Frontend Scope
Add SVG linear gradient specular highlights, realistic speaker notch and dynamic Dynamic Island bezel toggle.

### Acceptance Criteria
- Mockup displays refined bezel aesthetics that automatically scale responsively across all device screen sizes.

---

## Issue 20: Add localized greeting parameters to WhatsApp deep-link in CtaBand.jsx

**Target Area:** `apps/landing/src/components/CtaBand.jsx`  
**Category:** Landing / Conversion Optimization  
**Labels:** `landing, frontend, whatsapp, cta, conversions`

### Problem
The CTA button links to a generic WhatsApp URL without pre-populating user intent based on the corridor or action the user was exploring.

### Required Frontend Scope
Dynamically encode WhatsApp message text parameter (e.g., `text=Hello%20SendAm,%20I%20want%20to%20send%20money%20to%20Nigeria`) based on user selected corridor.

### Acceptance Criteria
- Clicking WhatsApp CTA opens WhatsApp chat with relevant pre-filled introductory message corresponding to the active corridor.

---

## Issue 21: Add lightweight client-side i18n switcher (English, French, Swahili, Yoruba) in Navbar.jsx

**Target Area:** `apps/landing/src/components/Navbar.jsx`  
**Category:** Landing / Internationalization  
**Labels:** `landing, frontend, i18n, localization, navbar`

### Problem
SendAm serves West and East African cross-border corridors, but the landing page is currently English-only, hindering adoption in Francophone and multilingual corridors.

### Required Frontend Scope
Add client-side translation dictionary context and a language dropdown switcher in Navbar supporting English, French, Swahili, and Yoruba.

### Acceptance Criteria
- Switching language immediately updates navigation labels, headings, and CTA buttons without reloading the application.

---

## Issue 22: Add currency swap animation with 180-degree icon spin in CurrencyCalculator.jsx

**Target Area:** `apps/landing/src/components/CurrencyCalculator.jsx`  
**Category:** Landing / Micro-interactions  
**Labels:** `landing, frontend, animation, calculator, ux`

### Problem
Switching source and target currencies occurs abruptly with no visual feedback to help users orient the change.

### Required Frontend Scope
Add a two-way swap button with smooth CSS transform rotation (`rotate-180`), animating currency flags and exchanging input values smoothly.

### Acceptance Criteria
- Clicking the swap button triggers smooth 300ms transition; correctly recalculates net received amounts and savings.

---

## Issue 23: Implement collapsible fee transparency breakdown card in CurrencyCalculator.jsx

**Target Area:** `apps/landing/src/components/CurrencyCalculator.jsx`  
**Category:** Landing / Transparency & UX  
**Labels:** `landing, frontend, calculator, fees, transparency`

### Problem
Users see the flat 1% SendAm fee but have questions about Stellar network base fees, anchor withdrawal fees, and recipient FX spread.

### Required Frontend Scope
Add an expandable 'View fee breakdown' drawer detailing SendAm service fee ($1.00), Stellar network transaction fee (<$0.0001), and guaranteed FX rate.

### Acceptance Criteria
- Fee details toggle smoothly with accessible ARIA attributes; itemized amounts sum up precisely to the net send amount.

---

## Issue 24: Respect prefers-reduced-motion in CorridorGlobe.jsx rotation loop

**Target Area:** `apps/landing/src/components/CorridorGlobe.jsx`  
**Category:** Landing / Accessibility  
**Labels:** `landing, frontend, accessibility, animation, wcag`

### Problem
The continuous spinning animation in CorridorGlobe can induce vestibular motion sickness for users who have requested reduced motion in their OS.

### Required Frontend Scope
Query `window.matchMedia('(prefers-reduced-motion: reduce)')` and disable continuous requestAnimationFrame rotation when active, rendering a static view.

### Acceptance Criteria
- When reduced motion is enabled, globe remains stationary, allowing manual interaction while halting automated continuous spinning.

---

## Issue 25: Add dynamic OpenGraph and Twitter card preview tags in landing index.html

**Target Area:** `apps/landing/index.html`  
**Category:** Landing / SEO & Social Sharing  
**Labels:** `landing, frontend, seo, social-media, html`

### Problem
Sharing SendAm links on WhatsApp, Twitter, or LinkedIn produces a plain text link without branded preview image, title, or summary.

### Required Frontend Scope
Add complete `og:title`, `og:description`, `og:image`, `og:url`, `twitter:card`, and `twitter:image` meta tags targeting social crawlers.

### Acceptance Criteria
- Social preview validators (WhatsApp link preview, Twitter card validator) render high-res branded thumbnail and crisp description.

---

## Issue 26: Add client-side image drag-and-drop preview and camera capture in OnboardingWizard.jsx

**Target Area:** `apps/landing/src/components/OnboardingWizard.jsx`  
**Category:** Landing / Document Verification UX  
**Labels:** `landing, frontend, onboarding, file-upload, ui`

### Problem
Identity document upload requires navigating standard OS file dialogs with no drag-and-drop zone, camera capture button, or thumbnail preview.

### Required Frontend Scope
Implement a drag-and-drop dropzone supporting image and PDF types, with instant client-side thumbnail rendering and remove/replace actions.

### Acceptance Criteria
- Users can drop ID photos or tap 'Take Photo' on mobile; thumbnail preview appears with file name, size, and delete button.

---

## Issue 27: Add client-side browser image compression before upload in OnboardingWizard.jsx

**Target Area:** `apps/landing/src/components/OnboardingWizard.jsx`  
**Category:** Landing / Client Performance  
**Labels:** `landing, frontend, canvas, image-compression, performance`

### Problem
Smartphone cameras produce 10MB+ photo files, which fail or timeout on slow African 3G mobile networks during identity upload.

### Required Frontend Scope
Implement client-side HTML5 canvas downsampling to resize and compress document images to < 1MB JPEG before staging for upload.

### Acceptance Criteria
- Large photos are compressed in browser in under 400ms without quality loss for OCR; progress bar visualizes compression.

---

## Issue 28: Implement scroll-spy active section highlighting for navigation in Navbar.jsx

**Target Area:** `apps/landing/src/components/Navbar.jsx`  
**Category:** Landing / Navigation  
**Labels:** `landing, frontend, navbar, intersection-observer, ui`

### Problem
As users scroll through Calculator, How It Works, Features, and FAQ, navbar menu links do not highlight the currently visible section.

### Required Frontend Scope
Use IntersectionObserver to track viewport intersection of major section tags and apply active indicator styling to corresponding navbar links.

### Acceptance Criteria
- Active section nav link highlights smoothly with primary color underline as user scrolls through the page.

---

## Issue 29: Add dark mode theme toggle with system preference synchronization in landing App.jsx

**Target Area:** `apps/landing/src/App.jsx`  
**Category:** Landing / Theming & Dark Mode  
**Labels:** `landing, frontend, dark-mode, tailwind, ui`

### Problem
Landing page is locked in light mode, causing visual jarring when users with OS dark mode switch from system WhatsApp to SendAm.

### Required Frontend Scope
Add Tailwind `dark` class support, a sleek Sun/Moon toggle button in Navbar, and synchronize with `(prefers-color-scheme: dark)`.

### Acceptance Criteria
- Theme toggle switches all landing sections to sleek dark mode; preference persists in localStorage across visits.

---

## Issue 30: Implement GDPR / NDPR compliant cookie and local storage consent banner in landing App.jsx

**Target Area:** `apps/landing/src/App.jsx`  
**Category:** Landing / Compliance & Privacy  
**Labels:** `landing, frontend, privacy, cookies, compliance`

### Problem
SendAm lacks a cookie and client storage consent banner, risking non-compliance with NDPR (Nigeria Data Protection Regulation) and GDPR.

### Required Frontend Scope
Create a lightweight, accessible consent banner with 'Accept All', 'Reject Non-Essential', and granular preferences modal.

### Acceptance Criteria
- Banner renders on first visit at bottom of viewport; choice is saved and respects user preference for analytics cookies.

---

## Issue 31: Implement virtualized row rendering for 1,000+ transaction logs in DataTable.jsx

**Target Area:** `apps/admin/src/components/DataTable.jsx`  
**Category:** Admin / Performance & Big Data  
**Labels:** `admin, frontend, datatable, performance, virtualization`

### Problem
Rendering large tables of transactions or audit logs causes DOM bloat and scroll stuttering on operator laptops.

### Required Frontend Scope
Integrate a lightweight windowing/virtual scroll mechanism rendering only the DOM nodes visible in current viewport.

### Acceptance Criteria
- Table renders 5,000 rows at consistent 60fps scrolling without memory leaks or UI lockup.

---

## Issue 32: Add multi-column sorting with visual sort priority badges in DataTable.jsx

**Target Area:** `apps/admin/src/components/DataTable.jsx`  
**Category:** Admin / Data Grid UX  
**Labels:** `admin, frontend, datatable, sorting, ui`

### Problem
DataTable only supports single-column sorting, making it difficult for compliance officers to sort transactions by status and then by date.

### Required Frontend Scope
Support Shift+Click to add secondary and tertiary sort keys, displaying sort direction arrows and numerical priority badges (1, 2).

### Acceptance Criteria
- Clicking column header sorts ascending/descending; Shift+Click adds secondary column sort; clears properly on regular click.

---

## Issue 33: Implement column visibility selector modal with localStorage persistence in DataTable.jsx

**Target Area:** `apps/admin/src/components/DataTable.jsx`  
**Category:** Admin / Customization UX  
**Labels:** `admin, frontend, datatable, local-storage, customization`

### Problem
DataTable contains 10+ columns, causing horizontal overflow on smaller laptops where operators only care about specific fields.

### Required Frontend Scope
Add a 'Customize Columns' button opening a checkbox popover to show/hide columns and reorder them, persisting preferences in localStorage.

### Acceptance Criteria
- Toggling column checkboxes immediately hides/shows table columns; user preferences are restored on page reload.

---

## Issue 34: Add table density switcher (Compact, Default, Comfortable) in DataTable.jsx

**Target Area:** `apps/admin/src/components/DataTable.jsx`  
**Category:** Admin / Display Density  
**Labels:** `admin, frontend, datatable, ui, accessibility`

### Problem
Operators reviewing hundreds of entries need higher data density, while auditing officers prefer larger touch-friendly row spacing.

### Required Frontend Scope
Add a segmented density toggle adjusting padding (py-1 vs py-3 vs py-5) and font size across table rows.

### Acceptance Criteria
- Switching density dynamically updates table row heights without re-fetching data or triggering layout thrashing.

---

## Issue 35: Add debounced multi-field search with one-click filter tag dismissal in FilterBar.jsx

**Target Area:** `apps/admin/src/components/FilterBar.jsx`  
**Category:** Admin / Search & Filtering  
**Labels:** `admin, frontend, filterbar, search, ux`

### Problem
Typing into FilterBar fires search queries on every single keystroke, causing rapid layout flicker and race conditions.

### Required Frontend Scope
Implement a 300ms debounce hook on search input and display active filter badges with 'x' dismissal pills underneath the search bar.

### Acceptance Criteria
- Search delays API calls until user stops typing for 300ms; active filters show as removable chips with clear-all action.

---

## Issue 36: Add quick date preset buttons (Today, Yesterday, Last 7D, MTD) in FilterBar.jsx

**Target Area:** `apps/admin/src/components/FilterBar.jsx`  
**Category:** Admin / Filtering UX  
**Labels:** `admin, frontend, filterbar, dates, ui`

### Problem
Selecting dates requires manually choosing start and end dates from native date pickers, slowing down daily reconciliation tasks.

### Required Frontend Scope
Add quick-select pills for 'Today', 'Yesterday', 'Last 7 Days', 'Month to Date', and 'Year to Date' above date range inputs.

### Acceptance Criteria
- Clicking a preset automatically populates ISO start/end dates and triggers filter update immediately.

---

## Issue 37: Synchronize FilterBar state with URL query parameters in FilterBar.jsx

**Target Area:** `apps/admin/src/components/FilterBar.jsx`  
**Category:** Admin / URL Routing & Collaboration  
**Labels:** `admin, frontend, routing, query-params, filterbar`

### Problem
When an operator filters by failed transactions and shares the link with an engineer, the URL does not reflect the filter state.

### Required Frontend Scope
Sync all active filter values (status, corridor, date range, search) to browser URL search params via `useSearchParams`.

### Acceptance Criteria
- Sharing filtered URL reproduces exact search, filter, and pagination state when opened in another browser tab.

---

## Issue 38: Add jump-to-page input with boundary clamping in Pagination.jsx

**Target Area:** `apps/admin/src/components/Pagination.jsx`  
**Category:** Admin / Pagination UX  
**Labels:** `admin, frontend, pagination, navigation, ui`

### Problem
Navigating to page 45 out of 100 requires clicking 'Next' dozens of times because there is no direct jump-to-page input.

### Required Frontend Scope
Add an accessible 'Go to page: [ ]' numeric input field validating against 1 to totalPages with instant navigation on Enter.

### Acceptance Criteria
- Entering valid page number navigates instantly; invalid numbers (negative, > total) clamp safely with visual error border.

---

## Issue 39: Implement syntax-highlighted JSON viewer with folding and copy action in XdrDecoderModal.jsx

**Target Area:** `apps/admin/src/components/XdrDecoderModal.jsx`  
**Category:** Admin / Stellar Tooling  
**Labels:** `admin, frontend, stellar, xdr, json-viewer`

### Problem
Decoded Stellar XDR is displayed as a raw unformatted string, making complex multi-operation transaction envelopes impossible to inspect.

### Required Frontend Scope
Integrate a collapsible tree-view JSON viewer with syntax highlighting (keys in blue, strings in green, numbers in orange) and 'Copy Formatted JSON'.

### Acceptance Criteria
- Decoded XDR renders as expandable tree; operators can collapse operations, inspect signatures, and copy clean JSON with one click.

---

## Issue 40: Add Stellar simulation error decoding and remediation tips in XdrDecoderModal.jsx

**Target Area:** `apps/admin/src/components/XdrDecoderModal.jsx`  
**Category:** Admin / Error Diagnosis  
**Labels:** `admin, frontend, stellar, errors, xdr`

### Problem
When a transaction fails simulation (e.g. `op_underfunded`, `op_no_trust`), operators see only raw error codes without plain-language explanations.

### Required Frontend Scope
Map Stellar error codes to human-readable explanations (e.g., 'Source wallet does not have enough XLM reserve') and actionable remediation steps.

### Acceptance Criteria
- Failed simulation displays an alert box translating Stellar result codes into clear operator instructions.

---

## Issue 41: Implement WebAuthn passkey step-up authentication fallback modal in PasskeyPromptModal.jsx

**Target Area:** `apps/admin/src/components/PasskeyPromptModal.jsx`  
**Category:** Admin / Security UX  
**Labels:** `admin, frontend, passkeys, webauthn, security`

### Problem
If an operator's hardware security key or biometric sensor fails, PasskeyPromptModal hangs without offering fallback TOTP or recovery code entry.

### Required Frontend Scope
Add error boundary for `NotAllowedError` / `AbortError`, and provide a secondary tab to enter an authenticator app TOTP code or backup recovery key.

### Acceptance Criteria
- Failing biometric prompt gracefully presents secondary TOTP form; preserves operator workflow without locking the screen.

---

## Issue 42: Implement global keyboard shortcut (Cmd+K / Ctrl+K) omnibox modal in GlobalSearchModal.jsx

**Target Area:** `apps/admin/src/components/GlobalSearchModal.jsx`  
**Category:** Admin / Productivity & Shortcuts  
**Labels:** `admin, frontend, search, shortcuts, productivity`

### Problem
Operators must manually navigate to specific pages to search for users, transactions, or wallets, slowing down emergency triage.

### Required Frontend Scope
Implement global `Cmd+K` / `Ctrl+K` listener opening an omnibox modal that searches across users, transaction hashes, and wallet addresses.

### Acceptance Criteria
- Pressing Cmd+K opens modal instantly from any admin screen; arrow keys navigate results; Enter jumps to target detail view.

---

## Issue 43: Categorize global search results with iconography in GlobalSearchModal.jsx

**Target Area:** `apps/admin/src/components/GlobalSearchModal.jsx`  
**Category:** Admin / Search UX  
**Labels:** `admin, frontend, search, ui, navigation`

### Problem
Global search results are mixed together in a flat list without distinguishing whether an item is a User, a Transaction, or an Escrow Wallet.

### Required Frontend Scope
Group search results into titled sections ('Users', 'Transactions', 'Stellar Accounts') with distinct category badges and metadata snippets.

### Acceptance Criteria
- Results display grouped by entity with highlight matching search terms and distinct icons.

---

## Issue 44: Implement side-by-side document image comparison with zoom and pan in KycReview.jsx

**Target Area:** `apps/admin/src/pages/KycReview.jsx`  
**Category:** Admin / Compliance & Verification  
**Labels:** `admin, frontend, kyc, compliance, image-viewer`

### Problem
Reviewing passport/NIN photos against selfie liveness photos requires switching tabs or squinting at small fixed thumbnails.

### Required Frontend Scope
Add a side-by-side split screen viewer with synchronized zoom, 90-degree image rotation, brightness/contrast adjustments, and pan controls.

### Acceptance Criteria
- Compliance officers can zoom in on document signatures and compare directly with liveness selfies; supports mousewheel zoom and dragging.

---

## Issue 45: Add preset rejection reason tags with mandatory explanation in KycReview.jsx

**Target Area:** `apps/admin/src/pages/KycReview.jsx`  
**Category:** Admin / Compliance UX  
**Labels:** `admin, frontend, kyc, validation, compliance`

### Problem
Rejecting a KYC submission currently allows submitting without a structured reason, making customer communication unhelpful.

### Required Frontend Scope
Add clickable preset tags ('Blurry Document', 'Expired ID', 'Name Mismatch', 'Selfie Mismatch') that populate a customer-facing reason textarea.

### Acceptance Criteria
- Rejection requires selecting at least one tag or entering >= 20 characters; button remains disabled until valid reason is supplied.

---

## Issue 46: Add visual audit timeline of previous KYC review events in KycReview.jsx

**Target Area:** `apps/admin/src/pages/KycReview.jsx`  
**Category:** Admin / Audit & Compliance  
**Labels:** `admin, frontend, kyc, audit, timeline`

### Problem
When a KYC application has been reviewed multiple times, operators cannot see the historical notes of previous reviewers.

### Required Frontend Scope
Add an expandable timeline sidebar showing reviewer username, timestamp, previous status changes, and reviewer internal comments.

### Acceptance Criteria
- Timeline displays chronological cards with status badges and operator avatars; auto-scrolls to latest event.

---

## Issue 47: Implement progress bar and date filter in KycExportModal.jsx

**Target Area:** `apps/admin/src/components/KycExportModal.jsx`  
**Category:** Admin / Data Export  
**Labels:** `admin, frontend, export, csv, ui`

### Problem
Exporting thousands of KYC records freezes the modal with no indication of progress or ability to cancel.

### Required Frontend Scope
Add an animated progress bar displaying percentage and record count, with date range filters and a 'Cancel Export' button.

### Acceptance Criteria
- Modal shows real-time export progress; cancels safely on button press; triggers automatic file download upon completion.

---

## Issue 48: Add interactive crosshair and tooltips to payment volume chart in CorridorChart.jsx

**Target Area:** `apps/admin/src/components/CorridorChart.jsx`  
**Category:** Admin / Data Visualization  
**Labels:** `admin, frontend, charts, svg, visualization`

### Problem
CorridorChart renders static SVG bars without hover tooltips displaying exact transaction count and total volume in USD.

### Required Frontend Scope
Implement interactive mouse tracking showing a vertical crosshair guide and floating tooltip card with detailed corridor metrics.

### Acceptance Criteria
- Hovering over chart points displays exact date, volume in USD, transaction count, and average settlement latency.

---

## Issue 49: Add time range filter pills (24H, 7D, 30D, 1Y) with skeleton loading in CorridorChart.jsx

**Target Area:** `apps/admin/src/components/CorridorChart.jsx`  
**Category:** Admin / Analytics UX  
**Labels:** `admin, frontend, charts, analytics, loading`

### Problem
CorridorChart is locked to a fixed 7-day view with no option to inspect monthly or daily hourly payment volume trends.

### Required Frontend Scope
Add segmented control pills for '24H', '7D', '30D', and '1Y', showing a sleek skeleton shimmer while new chart datasets load.

### Acceptance Criteria
- Clicking time range switches chart interval; skeleton placeholder prevents layout shift during dataset transition.

---

## Issue 50: Add percentage change badges and comparison trend arrows in StatCard.jsx

**Target Area:** `apps/admin/src/components/StatCard.jsx`  
**Category:** Admin / Dashboard Analytics  
**Labels:** `admin, frontend, dashboard, metrics, ui`

### Problem
KPI StatCards display raw totals (e.g., $142,500) without contextual trend indicators showing whether metrics increased or decreased vs last week.

### Required Frontend Scope
Add support for `trend: { value: 12.4, isPositive: true, period: 'vs last week' }` props rendering green/red trend badges with arrow icons.

### Acceptance Criteria
- StatCard displays formatted percentage with upward or downward trend icon and accessible color-contrast compliant badge.

---

## Issue 51: Implement live transaction stream ticker with entry fade animations in Dashboard.jsx

**Target Area:** `apps/admin/src/pages/Dashboard.jsx`  
**Category:** Admin / Real-time Feed UX  
**Labels:** `admin, frontend, dashboard, live-feed, animations`

### Problem
Dashboard shows static tables that require manual browser reload to see recent payments flowing through WhatsApp.

### Required Frontend Scope
Add a 'Live Activity' ticker component with flashing pulse dot and smooth top-insert slide animations as new payments arrive.

### Acceptance Criteria
- New simulated payments slide smoothly into the top of the feed; operators can pause the stream with a dedicated button.

---

## Issue 52: Add quick actions dropdown menu (Deactivate, Reset PIN, Export Dossier) in Users.jsx

**Target Area:** `apps/admin/src/pages/Users.jsx`  
**Category:** Admin / User Management UX  
**Labels:** `admin, frontend, users, dropdown, actions`

### Problem
Actions on users are buried inside full-screen views, requiring multiple clicks to perform common support actions like resetting PINs.

### Required Frontend Scope
Add a three-dot kebab action menu to each table row with options to 'View Dossier', 'Reset PIN', 'Deactivate Account', and 'Export Audit Log'.

### Acceptance Criteria
- Menu opens with accessible popup semantics (`aria-haspopup`); clicking an action triggers appropriate modal with pre-selected user.

---

## Issue 53: Add dual-confirmation modal with typed phone confirmation for deactivation in Users.jsx

**Target Area:** `apps/admin/src/pages/Users.jsx`  
**Category:** Admin / Critical Actions UX  
**Labels:** `admin, frontend, security, confirmation, users`

### Problem
Deactivating a user account terminates their ability to send money; the current confirmation modal is too easy to trigger by accident.

### Required Frontend Scope
Require the operator to type the user's phone number or 'CONFIRM' into a text input before the final Deactivate button becomes clickable.

### Acceptance Criteria
- Deactivate button remains disabled until exact string matches; highlights destructive nature with amber warning banner.

---

## Issue 54: Implement interactive Stellar payment path visualizer in TransactionDetail.jsx

**Target Area:** `apps/admin/src/pages/TransactionDetail.jsx`  
**Category:** Admin / Stellar Payment Inspection  
**Labels:** `admin, frontend, stellar, visualization, transactions`

### Problem
Cross-asset payments (e.g. USDC -> NGN via Stellar path payment) only display raw amounts without showing the intermediate liquidity path.

### Required Frontend Scope
Add an interactive node-and-arrow diagram illustrating Source Asset -> Orderbook Path / AMM Pool -> Destination Asset with exchange ratios.

### Acceptance Criteria
- Path payment renders visually with exchange rates and liquidity pool IDs clearly labeled.

---

## Issue 55: Add direct deep-links to Stellar.Expert and Horizon in TransactionDetail.jsx

**Target Area:** `apps/admin/src/pages/TransactionDetail.jsx`  
**Category:** Admin / External Integrations  
**Labels:** `admin, frontend, stellar, links, transactions`

### Problem
Operators investigating stuck transactions must copy hashes and manually navigate to external block explorers.

### Required Frontend Scope
Add external link buttons for 'View on Stellar.Expert' and 'View Horizon JSON' that dynamically select Testnet or Public network.

### Acceptance Criteria
- Clicking opens external explorer in new tab with `rel='noopener noreferrer'` and displays verified external link icon.

---

## Issue 56: Add hot wallet vs escrow reserve ratio visual progress bars in Wallets.jsx

**Target Area:** `apps/admin/src/pages/Wallets.jsx`  
**Category:** Admin / Treasury & Wallets  
**Labels:** `admin, frontend, wallets, treasury, ui`

### Problem
Treasury managers must mentally calculate the proportion of funds held in active distribution hot wallets versus cold/escrow custody.

### Required Frontend Scope
Render stacked horizontal progress bars showing percentage allocation between Hot Reserve, Channel Accounts, and Escrow Vaults.

### Acceptance Criteria
- Wallets page renders visual allocation gauge with color-coded legend and numerical asset totals.

---

## Issue 57: Add low XLM base reserve threshold warning banners in Wallets.jsx

**Target Area:** `apps/admin/src/pages/Wallets.jsx`  
**Category:** Admin / Operational Alerts  
**Labels:** `admin, frontend, wallets, alerts, stellar`

### Problem
If an issuing or channel account runs low on native XLM reserves, automated payments fail without advance warning in the admin UI.

### Required Frontend Scope
Calculate remaining transaction capacity based on XLM balance and show a warning card when reserve drops below 20 XLM.

### Acceptance Criteria
- Accounts under threshold display prominent warning badge with 'Refill Account' instructions.

---

## Issue 58: Add expandable JSON metadata diff viewer in AuditLogs.jsx

**Target Area:** `apps/admin/src/pages/AuditLogs.jsx`  
**Category:** Admin / Audit Inspection  
**Labels:** `admin, frontend, audit, diff-viewer, ui`

### Problem
Audit log entries that record state modifications display unformatted blobs, making it hard to see what changed.

### Required Frontend Scope
Implement a side-by-side or inline diff viewer highlighting changed fields in red (before) and green (after).

### Acceptance Criteria
- Clicking an audit row reveals clean visual diff showing exactly which fields were updated.

---

## Issue 59: Add configurable auto-refresh interval selector in SystemHealth.jsx

**Target Area:** `apps/admin/src/pages/SystemHealth.jsx`  
**Category:** Admin / Observability UX  
**Labels:** `admin, frontend, system-health, polling, observability`

### Problem
System health metrics are only queried on page load, forcing operators during an incident to repeatedly refresh the browser.

### Required Frontend Scope
Add a segmented refresh dropdown (5s, 15s, 30s, 1m, Paused) with a circular countdown ring indicating when metrics will reload.

### Acceptance Criteria
- Metrics auto-refresh at the selected frequency; visually highlights degraded services in amber/red.

---

## Issue 60: Implement collapsible off-canvas mobile drawer in AdminSidebar.jsx

**Target Area:** `apps/admin/src/components/AdminSidebar.jsx`  
**Category:** Admin / Mobile Navigation  
**Labels:** `admin, frontend, sidebar, mobile, responsive`

### Problem
On tablet or mobile screens, the admin sidebar crushes the main content area into an unreadable column.

### Required Frontend Scope
Convert sidebar into an off-canvas drawer on screens under 1024px with hamburger toggle button, backdrop overlay, and swipe-to-close.

### Acceptance Criteria
- Sidebar slides out smoothly over content on mobile; closes automatically upon clicking any navigation route.

---

## Issue 61: Add real-time pending KYC counter badge in AdminSidebar.jsx

**Target Area:** `apps/admin/src/components/AdminSidebar.jsx`  
**Category:** Admin / Notification Badges  
**Labels:** `admin, frontend, sidebar, kyc, notifications`

### Problem
Compliance operators must navigate to the KYC page to see if any user identity verification submissions are waiting for review.

### Required Frontend Scope
Display an amber counter pill beside the 'KYC Review' navigation link showing the number of unreviewed submissions.

### Acceptance Criteria
- Counter displays live pending count; animates gently when a new submission arrives; disappears when count is zero.

---

## Issue 62: Add WCAG AAA high-contrast mode toggle in ThemeToggle.jsx

**Target Area:** `apps/admin/src/components/ThemeToggle.jsx`  
**Category:** Admin / Accessibility & Contrast  
**Labels:** `admin, frontend, accessibility, contrast, a11y`

### Problem
Subtle borders and slate text in the admin dashboard fail WCAG AAA contrast ratios for visually impaired operators.

### Required Frontend Scope
Add a high-contrast mode setting applying pure black backgrounds, high-contrast borders (2px solid), and stark text colors.

### Acceptance Criteria
- Enabling high-contrast mode achieves > 7:1 contrast ratio across all text and interactive elements.

---

## Issue 63: Add password visibility toggle and caps-lock indicator in Login.jsx

**Target Area:** `apps/admin/src/pages/Login.jsx`  
**Category:** Admin / Authentication UX  
**Labels:** `admin, frontend, login, auth, forms`

### Problem
Operators frequently lock their accounts due to silent Caps-Lock activation and lack of a show/hide password toggle.

### Required Frontend Scope
Add an eye icon button to toggle password masking and detect `getModifierState('CapsLock')` to show a warning badge.

### Acceptance Criteria
- Toggling eye reveals/masks password; pressing Caps-Lock displays immediate warning badge below input.

---

## Issue 64: Implement visual password strength and entropy meter in SetPassword.jsx

**Target Area:** `apps/admin/src/pages/SetPassword.jsx`  
**Category:** Admin / Security UX  
**Labels:** `admin, frontend, security, password, validation`

### Problem
When resetting or rotating passwords, operators receive no guidance on meeting length, character variety, or dictionary entropy standards.

### Required Frontend Scope
Integrate a client-side password strength meter with animated segments (Weak, Fair, Good, Strong) and checklist of requirements.

### Acceptance Criteria
- Meter updates dynamically as user types; submit button stays disabled until password reaches 'Strong' rating.

---

## Issue 65: Implement idle session warning modal with 'Stay Logged In' countdown in ProtectedRoute.jsx

**Target Area:** `apps/admin/src/components/ProtectedRoute.jsx`  
**Category:** Admin / Session Management UX  
**Labels:** `admin, frontend, auth, session, security`

### Problem
When an operator's JWT session expires, the app abruptly redirects to `/login`, losing any unsaved review notes or form inputs.

### Required Frontend Scope
Detect 15 minutes of inactivity and display a modal with a 60-second countdown allowing the user to click 'Stay Logged In' to renew.

### Acceptance Criteria
- Modal alerts operator before logout; clicking renew refreshes session token; expiration logs out cleanly.

---

## Issue 66: Simulate WhatsApp audio note voice recording and timer in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Voice Experience  
**Labels:** `chat-sim, frontend, voice, audio, simulation`

### Problem
Chat simulator only allows typing text, failing to test SendAm's core feature of sending money via WhatsApp voice notes in Nigerian Pidgin/English.

### Required Frontend Scope
Implement a simulated microphone press-and-hold button with recording duration timer (0:01, 0:02...) and simulated voice note dispatch.

### Acceptance Criteria
- Pressing mic button displays audio wave recording bar; releasing sends an interactive voice message bubble into the conversation.

---

## Issue 67: Implement audio waveform scrubber with playback speed toggle (1x, 1.5x, 2x) in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Audio Playback  
**Labels:** `chat-sim, frontend, audio, playback, ux`

### Problem
Voice messages in the chat simulator do not support variable speed playback or scrubbing along the message duration.

### Required Frontend Scope
Add audio speed pills (1x, 1.5x, 2x) on simulated voice notes and allow scrubbing along the waveform timeline.

### Acceptance Criteria
- Clicking speed toggle cycles playback rates; scrubbing seeks audio time position smoothly.

---

## Issue 68: Add WhatsApp quick-reply interactive pill buttons in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Bot UI  
**Labels:** `chat-sim, frontend, whatsapp, quick-reply, ui`

### Problem
When the bot offers options (e.g., '1: Check Balance', '2: Send Money'), testers must manually type numbers instead of tapping buttons.

### Required Frontend Scope
Render interactive WhatsApp quick-reply buttons below bot messages that automatically submit the selected payload on click.

### Acceptance Criteria
- Clicking a quick-reply button sends that text as the user response and disables the buttons to prevent duplicate taps.

---

## Issue 69: Simulate WhatsApp interactive list message modal drawer in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Interactive Messages  
**Labels:** `chat-sim, frontend, whatsapp, list-messages, ui`

### Problem
WhatsApp list messages (menus with sections and item descriptions) cannot be previewed or tested in the current simulator.

### Required Frontend Scope
Add modal drawer rendering WhatsApp list message payload with section titles, row descriptions, and radio selection buttons.

### Acceptance Criteria
- Opening menu displays formatted list; selecting an option submits choice and closes drawer seamlessly.

---

## Issue 70: Group messages by date headers (Today, Yesterday, Date) in MessageList.js

**Target Area:** `apps/chat-sim/src/MessageList.js`  
**Category:** Chat Simulator / Layout & Grouping  
**Labels:** `chat-sim, frontend, messagelist, ui, timestamps`

### Problem
Messages render in a continuous stream without sticky date separators, making multi-day simulated conversations hard to parse.

### Required Frontend Scope
Add floating rounded date pills ('Today', 'Yesterday', 'October 14, 2026') centered between messages across date boundaries.

### Acceptance Criteria
- Date headers render cleanly between messages of different calendar days matching WhatsApp mobile UI.

---

## Issue 71: Implement in-chat message search with jump navigation in MessageList.js

**Target Area:** `apps/chat-sim/src/MessageList.js`  
**Category:** Chat Simulator / Productivity  
**Labels:** `chat-sim, frontend, search, messagelist, ux`

### Problem
In long test sessions, finding a specific transaction confirmation message or error code requires endless scrolling.

### Required Frontend Scope
Add a search bar in the chat header that filters messages, highlights matched terms in yellow, and provides Up/Down navigation buttons.

### Acceptance Criteria
- Typing search term highlights matches and displays '1 of 5'; clicking Up/Down auto-scrolls to matched bubble.

---

## Issue 72: Implement swipe-to-reply gesture animation in MessageList.js

**Target Area:** `apps/chat-sim/src/MessageList.js`  
**Category:** Chat Simulator / Gestures  
**Labels:** `chat-sim, frontend, gestures, animations, mobile`

### Problem
The simulator lacks WhatsApp's signature swipe-to-reply gesture, making contextual bot conversation testing clunky.

### Required Frontend Scope
Add horizontal pan gesture handler allowing users to swipe any message bubble right to attach it as a quoted reply.

### Acceptance Criteria
- Swiping right displays a reply arrow icon; releasing snaps bubble back and pins quote banner above input box.

---

## Issue 73: Add image and document attachment picker with thumbnail preview in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Media Simulation  
**Labels:** `chat-sim, frontend, media, attachments, forms`

### Problem
Testing identity verification or receipt submission via WhatsApp requires sending images, which chat-sim currently cannot do.

### Required Frontend Scope
Add a paperclip attachment menu with options for 'Photo' and 'Document', generating an inline media preview bubble.

### Acceptance Criteria
- Selecting a file renders photo thumbnail with caption input; sending adds media card into the chat thread.

---

## Issue 74: Add one-click message copy action with ephemeral checkmark in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Usability  
**Labels:** `chat-sim, frontend, clipboard, usability, ui`

### Problem
Copying bot response text (e.g., Stellar deposit addresses or reference codes) requires highlighting text manually.

### Required Frontend Scope
Add a hover copy icon on message bubbles that writes message content to clipboard and displays a 1-second checkmark animation.

### Acceptance Criteria
- Clicking copies message text to clipboard; provides clear visual feedback without selecting text manually.

---

## Issue 75: Add clear conversation confirmation dialog with session reset in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / State Management  
**Labels:** `chat-sim, frontend, state, dialog, session`

### Problem
Resetting a test conversation currently wipes memory immediately without confirmation, causing lost test notes if clicked accidentally.

### Required Frontend Scope
Add a confirmation alert dialog ('Clear chat history and reset payment state machine?') before purging conversation history.

### Acceptance Criteria
- Clicking Reset prompts user; confirming clears conversation and resets bot state machine to idle.

---

## Issue 76: Implement network latency simulator selector (Fast, 3G, Offline) in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Developer Experience  
**Labels:** `chat-sim, frontend, testing, network-simulation, latency`

### Problem
Developers cannot simulate high-latency Nigerian mobile network conditions to verify UI loading states in chat-sim.

### Required Frontend Scope
Add a dropdown in chat simulator toolbar to throttle responses: 'No Throttling (0ms)', 'Fast 3G (500ms)', 'Slow 3G (2000ms)', or 'Offline (Error)'.

### Acceptance Criteria
- Simulator delays bot responses according to selected network profile; displays connection status badge in header.

---

## Issue 77: Implement QR code payment request generator modal in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / QR Code & Payments  
**Labels:** `chat-sim, frontend, qr-code, payments, modal`

### Problem
Testing Stellar SEP-0007 payment links requires scanning QR codes from mobile wallets, which chat-sim cannot render.

### Required Frontend Scope
Render SVG QR code modal for payment requests containing SEP-0007 / SEP-0043 URI, with a 'Copy Payment Link' button.

### Acceptance Criteria
- Clicking 'Show QR Code' generates scannable QR code; testable with mobile wallet apps on the same network.

---

## Issue 78: Add animated double blue ticks delivery receipt transition in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Animations  
**Labels:** `chat-sim, frontend, animation, checkmarks, whatsapp`

### Problem
Message status ticks appear instantly without the realistic micro-delays that signal message transit across WhatsApp servers.

### Required Frontend Scope
Implement animated checkmark progression (Clock icon -> single tick -> double grey -> double blue) keyed to bot processing state.

### Acceptance Criteria
- Checkmarks update in sequence as the simulated bot transitions from receiving to thinking to replying.

---

## Issue 79: Add emoji picker popover with category tabs and search in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Input UX  
**Labels:** `chat-sim, frontend, emoji, input, popover`

### Problem
Testing bot recognition of emojis (e.g. 🇳🇬, 💵, 👍) requires copying and pasting from external tools.

### Required Frontend Scope
Integrate a lightweight emoji picker popover categorized by smileys, currency symbols, and flags with real-time text search.

### Acceptance Criteria
- Clicking smiley icon opens popover; clicking emoji inserts it at cursor position in text input.

---

## Issue 80: Synchronize typing indicator delay with bot payment state transitions in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / State Synchronization  
**Labels:** `chat-sim, frontend, typing-indicator, state-machine, animation`

### Problem
The typing indicator currently renders for a fixed timer regardless of whether the bot state machine is validating PIN or broadcasting to Stellar.

### Required Frontend Scope
Bind TypingIndicator visibility directly to `PaymentStateMachine.state === 'AUTHORIZING'` and `'SUBMITTING'`. 

### Acceptance Criteria
- Typing indicator stays active precisely while transaction state machine is running and disappears when response renders.

---

## Issue 81: Implement authentic WhatsApp Web dark theme styling in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Theme & Aesthetics  
**Labels:** `chat-sim, frontend, dark-mode, styling, whatsapp`

### Problem
Chat simulator lacks WhatsApp Web dark mode palette (#111b21 background, #005c4b outbound bubbles, #202c33 inbound bubbles).

### Required Frontend Scope
Add theme toggle applying WhatsApp Web official dark mode color tokens across message thread, input bar, and headers.

### Acceptance Criteria
- Dark theme matches official WhatsApp Web hex codes with proper contrast ratios and chat wallpaper pattern.

---

## Issue 82: Add exponential backoff and browser tab visibility throttling in usePolling.js

**Target Area:** `apps/chat-sim/src/usePolling.js`  
**Category:** Chat Simulator / Performance & Battery  
**Labels:** `chat-sim, frontend, polling, performance, background-tabs`

### Problem
When the chat simulator tab is hidden or backgrounded, `usePolling.js` continues hammering endpoints at fixed intervals, wasting battery.

### Required Frontend Scope
Pause polling or throttle interval to 30s when `document.visibilityState === 'hidden'`, resuming immediately upon tab focus.

### Acceptance Criteria
- Backgrounding tab throttles polling frequency; focusing tab triggers immediate refresh and restores active polling.

---

## Issue 83: Implement export chat transcript to formatted text and JSON in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / QA & Bug Reporting  
**Labels:** `chat-sim, frontend, export, qa, debugging`

### Problem
QA testers reproducing chat payment edge cases cannot easily export the transcript to attach to bug reports.

### Required Frontend Scope
Add an 'Export Transcript' button generating downloadable `.txt` and structured `.json` files containing timestamps and message payloads.

### Acceptance Criteria
- Clicking export downloads formatted transcript file ready to attach to bug tickets.

---

## Issue 84: Add synthetic webhook event injector panel in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Testing Utilities  
**Labels:** `chat-sim, frontend, webhooks, testing, simulation`

### Problem
Testers cannot simulate inbound WhatsApp status webhooks (e.g. user blocked bot, payment receipt failed) without backend mock tools.

### Required Frontend Scope
Add a developer drawer in chat-sim allowing one-click injection of synthetic inbound events (e.g. 'Simulate KYC Approved Notification').

### Acceptance Criteria
- Selecting a synthetic event triggers corresponding bot push notification message in the chat thread.

---

## Issue 85: Add responsive split-screen view on desktop showing state machine inspector in ChatScreen.js

**Target Area:** `apps/chat-sim/src/ChatScreen.js`  
**Category:** Chat Simulator / Developer UX  
**Labels:** `chat-sim, frontend, state-machine, inspector, desktop`

### Problem
On wide desktop monitors, the chat simulator is a narrow centered column leaving 70% of screen space empty.

### Required Frontend Scope
Add an optional side panel on desktop displays showing live `PaymentStateMachine` state, context variables, and event logs.

### Acceptance Criteria
- Side panel visualizes current state machine node (e.g. `AWAITING_PIN`) and updates in real-time as user chats.

---

## Issue 86: Enhance ErrorBoundary with expandable stack trace and 'Copy Error Details' in ErrorBoundary.jsx

**Target Area:** `packages/shared/src/ErrorBoundary.jsx`  
**Category:** Shared / Error Handling  
**Labels:** `shared, frontend, error-boundary, debugging, react`

### Problem
When a React component crashes, ErrorBoundary renders a minimal generic alert with no way for users to copy diagnostic info.

### Required Frontend Scope
Add an expandable 'Technical Details' accordion with sanitized component stack and a one-click 'Copy Error Details' button.

### Acceptance Criteria
- Clicking copies error name, message, stack, and browser user agent to clipboard for support tickets.

---

## Issue 87: Implement automatic reconnect notification and retry countdown in NetworkStatusBanner.jsx

**Target Area:** `packages/shared/src/NetworkStatusBanner.jsx`  
**Category:** Shared / Network Resiliency  
**Labels:** `shared, frontend, offline, network, banners`

### Problem
When internet drops and reconnects, NetworkStatusBanner disappears abruptly without confirming data synchronization status.

### Required Frontend Scope
Display a green 'Connection restored. Syncing...' toast for 3 seconds when online event triggers, followed by automatic retry.

### Acceptance Criteria
- Restoring connection flashes confirmation toast and automatically retries failed queries.

---

## Issue 88: Add offline pending action queue counter badge in NetworkStatusBanner.jsx

**Target Area:** `packages/shared/src/NetworkStatusBanner.jsx`  
**Category:** Shared / Offline Synchronization  
**Labels:** `shared, frontend, offline, queue, badge`

### Problem
If an operator performs actions while offline, there is no visual indicator showing how many requests are waiting in memory.

### Required Frontend Scope
Add a badge to the banner displaying '3 actions queued for replay when online' with a button to view pending operations.

### Acceptance Criteria
- Badge increments as actions are queued offline and decrements as replay succeeds after connection restores.

---

## Issue 89: Add accessible screen-reader announcement (`aria-live='polite'`) in Loader.jsx

**Target Area:** `packages/shared/src/Loader.jsx`  
**Category:** Shared / Accessibility  
**Labels:** `shared, frontend, loader, accessibility, a11y`

### Problem
The Loader spinner is a visual CSS animation with no ARIA live region announcement, leaving blind screen-reader users unaware that content is loading.

### Required Frontend Scope
Wrap loader in `<div role='status' aria-live='polite'>` with a visually hidden `<span className='sr-only'>Loading data, please wait...</span>`.

### Acceptance Criteria
- Assistive technologies announce loading state immediately upon mount without breaking layout.

---

## Issue 90: Add relative time formatting ('2 minutes ago') with live tick updates in formatDate.js

**Target Area:** `packages/shared/src/formatDate.js`  
**Category:** Shared / Date Formatting  
**Labels:** `shared, frontend, dates, formatters, utilities`

### Problem
formatDate only returns static absolute dates ('Oct 15, 2026, 11:20 AM'), which feel stale in real-time feeds.

### Required Frontend Scope
Add `formatRelativeTime(date)` utility using `Intl.RelativeTimeFormat` that updates every minute for recent events (< 1 hour).

### Acceptance Criteria
- Outputs 'Just now', '5m ago', '2h ago' correctly with automatic fallback to full date after 24 hours.

---

## Issue 91: Implement universal currency formatter supporting Stellar assets in packages/shared

**Target Area:** `packages/shared/src/formatCurrency.js`  
**Category:** Shared / Financial Formatting  
**Labels:** `shared, frontend, currency, stellar, formatters`

### Problem
Different apps format currency strings inconsistently (e.g. 7 decimal places for XLM vs 2 for USD vs integer for NGN).

### Required Frontend Scope
Create a shared `formatCurrency(amount, currencyCode)` utility using `Intl.NumberFormat` with strict asset decimal rule enforcement.

### Acceptance Criteria
- USD/EUR formats to 2 decimal places, NGN formats with ₦ symbol, and XLM/crypto assets format with up to 7 decimal places.

---

## Issue 92: Implement phone number masking utility with privacy toggle in packages/shared

**Target Area:** `packages/shared/src/maskPhoneNumber.js`  
**Category:** Shared / Privacy Utilities  
**Labels:** `shared, frontend, privacy, masking, security`

### Problem
Customer phone numbers are displayed in full across admin tables, creating shoulder-surfing and PII compliance risks.

### Required Frontend Scope
Create a shared `maskPhoneNumber(phone, isRevealed)` utility masking middle digits (`+234 ••• ••• 4219`) with an eye toggle.

### Acceptance Criteria
- Masks phone numbers by default; clicking toggle button unmasks phone with security audit trail.

---

## Issue 93: Create Stellar public key truncation component with copy action in packages/shared

**Target Area:** `packages/shared/src/StellarAddress.jsx`  
**Category:** Shared / Stellar UI Components  
**Labels:** `shared, frontend, stellar, address, components`

### Problem
Full 56-character Stellar addresses (`G...`) break table layouts across both admin and landing dashboards.

### Required Frontend Scope
Create a reusable `<StellarAddress address={addr} />` rendering `GABC...WXYZ` with full address tooltip and one-click copy.

### Acceptance Criteria
- Component truncates to first 4 and last 4 characters; hover shows full address; click copies full address with checkmark.

---

## Issue 94: Add automated client-side WCAG contrast checking utility in a11yAudit.js

**Target Area:** `packages/shared/src/a11yAudit.js`  
**Category:** Shared / Accessibility Tools  
**Labels:** `shared, frontend, accessibility, contrast, a11y`

### Problem
Color contrast issues between text and dynamic background cards can slip into production without automated detection.

### Required Frontend Scope
Enhance `a11yAudit.js` with a helper that computes relative luminance and flags elements failing WCAG AA (4.5:1) in browser console in dev mode.

### Acceptance Criteria
- Dev mode logs actionable warnings identifying DOM nodes that fail color contrast standards.

---

## Issue 95: Standardize client-side API error normalization in normalizeError.js

**Target Area:** `packages/shared/src/normalizeError.js`  
**Category:** Shared / Error Standardization  
**Labels:** `shared, frontend, errors, api, normalization`

### Problem
API responses return varying error formats (Axios error, fetch error, Stellar Horizon error), leading to 'undefined is not an object' crashes in UI.

### Required Frontend Scope
Expand `normalizeError.js` to parse HTTP status codes, network disconnects, and Stellar transaction error codes into uniform `{ title, message, code }`.

### Acceptance Criteria
- Any thrown error returns user-friendly title and actionable message for display in UI toasts and alerts.

---

## Issue 96: Implement client-side in-memory ring-buffer logger in logger.js

**Target Area:** `packages/shared/src/logger.js`  
**Category:** Shared / Observability & Telemetry  
**Labels:** `shared, frontend, logging, telemetry, debugging`

### Problem
Frontend errors on operator laptops leave no trace when console is cleared or page navigates.

### Required Frontend Scope
Implement a circular in-memory buffer storing the last 100 log entries (info, warn, error) with an export function for diagnostics.

### Acceptance Criteria
- Keeps rolling 100 logs in memory; provides `logger.getRecentLogs()` and `logger.downloadLogs()` for support tickets.

---

## Issue 97: Create accessible modal backdrop portal component in packages/shared

**Target Area:** `packages/shared/src/ModalPortal.jsx`  
**Category:** Shared / Modal Architecture  
**Labels:** `shared, frontend, modal, portal, accessibility`

### Problem
Modals rendered directly inside nested component trees suffer from z-index clipping and body scroll leaks.

### Required Frontend Scope
Create a `<ModalPortal>` component using React `createPortal` rendering to `#modal-root`, automatically locking `document.body` scroll while open.

### Acceptance Criteria
- Modals mount at document root; locks body scroll without layout shift; unlocks cleanly on unmount.

---

## Issue 98: Create shared toast notification provider with auto-dismiss timers in packages/shared

**Target Area:** `packages/shared/src/ToastProvider.jsx`  
**Category:** Shared / Notifications UI  
**Labels:** `shared, frontend, toast, notifications, context`

### Problem
Alerts across admin and landing use inconsistent ad-hoc alerts instead of a unified non-intrusive toast notification system.

### Required Frontend Scope
Create a `<ToastProvider>` and `useToast()` hook supporting success, error, warning, and info toasts with smooth exit animations.

### Acceptance Criteria
- Toasts stack gracefully in bottom-right corner; automatically dismiss after 4 seconds; dismissible via click.

---

## Issue 99: Create shared skeleton placeholder component with configurable shimmer in packages/shared

**Target Area:** `packages/shared/src/Skeleton.jsx`  
**Category:** Shared / Loading UI  
**Labels:** `shared, frontend, skeleton, loading, design-system`

### Problem
Multiple components write custom grey placeholder divs with inconsistent pulse animations and sizes.

### Required Frontend Scope
Create a shared `<Skeleton width='100%' height='24px' variant='rounded' />` component with customizable shimmer effect.

### Acceptance Criteria
- Replaces custom loading placeholders across landing and admin; supports text, circular, and rectangular variants.

---

## Issue 100: Create shared tooltip component with automated flip and collision detection in packages/shared

**Target Area:** `packages/shared/src/Tooltip.jsx`  
**Category:** Shared / UI Overlay Components  
**Labels:** `shared, frontend, tooltip, accessibility, ui`

### Problem
Tooltips near screen edges clip offscreen because they lack boundary collision detection and auto-flip positioning.

### Required Frontend Scope
Implement a lightweight `<Tooltip>` component using floating UI positioning that automatically flips (top/bottom/left/right) to stay in viewport.

### Acceptance Criteria
- Tooltip stays fully visible regardless of scroll position or screen edge proximity; accessible via keyboard focus.

---

## Issue 101: Implement Stale-While-Revalidate caching strategy in landing Service Worker sw.js

**Target Area:** `apps/landing/src/sw.js`  
**Category:** PWA / Caching & Offline  
**Labels:** `landing, frontend, pwa, service-worker, caching`

### Problem
The service worker uses cache-first for all assets, causing returning users to see outdated JavaScript bundles after new deployments.

### Required Frontend Scope
Refactor `sw.js` to use Stale-While-Revalidate for HTML and hashed JS/CSS assets, ensuring instant offline loads while updating in the background.

### Acceptance Criteria
- App loads instantly from cache while checking network for updates; prompts user when new version is activated.

---

## Issue 102: Implement custom offline fallback page in landing Service Worker sw.js

**Target Area:** `apps/landing/src/sw.js`  
**Category:** PWA / Offline Experience  
**Labels:** `landing, frontend, pwa, offline, service-worker`

### Problem
If a user navigates to an uncached route while offline, the browser displays the default 'No Internet' dinosaur page.

### Required Frontend Scope
Pre-cache an `offline.html` page displaying SendAm branding, cached currency tables, and a 'Retry Connection' button.

### Acceptance Criteria
- Visiting uncached routes offline renders the branded offline fallback page instead of browser network error.

---

## Issue 103: Implement dynamic code splitting and lazy loading for heavy landing components

**Target Area:** `apps/landing/src/App.jsx`  
**Category:** Performance / Code Splitting  
**Labels:** `landing, frontend, performance, code-splitting, bundle`

### Problem
Heavy components like `CorridorGlobe` (Three.js/WebGL) and `CurrencyCalculator` are bundled in the initial main chunk, inflating initial JS payload to > 350KB.

### Required Frontend Scope
Use `React.lazy()` and `<Suspense>` to dynamically import `CorridorGlobe` and `CurrencyCalculator` only when entering viewport.

### Acceptance Criteria
- Initial JS bundle size drops by > 40%; initial page load time improves on mobile 3G connections.

---

## Issue 104: Add local WOFF2 font subsetting and font-display: swap in landing index.html

**Target Area:** `apps/landing/index.html`  
**Category:** Performance / Typography & CLS  
**Labels:** `landing, frontend, fonts, web-vitals, performance`

### Problem
Google Fonts are loaded via external render-blocking stylesheets, causing Flash of Invisible Text (FOIT) on slow mobile connections.

### Required Frontend Scope
Self-host Inter and Outfit WOFF2 fonts with `font-display: swap` and preloading for the Latin character subset.

### Acceptance Criteria
- Eliminates render-blocking font requests; prevents text layout shift during initial paint.

---

## Issue 105: Implement responsive image srcset and modern AVIF/WebP formats for hero graphics

**Target Area:** `apps/landing/src/components/Hero.jsx`  
**Category:** Performance / Image Optimization  
**Labels:** `landing, frontend, images, performance, webp`

### Problem
Hero graphics use large uncompressed PNG files, causing slow Largest Contentful Paint (LCP) times on mobile devices.

### Required Frontend Scope
Generate modern WebP and AVIF formats with responsive `<picture>` tags specifying `srcset` for mobile (1x, 2x) and desktop resolutions.

### Acceptance Criteria
- Hero image transfers < 100KB on mobile; LCP metric improves to < 1.8 seconds in Lighthouse.

---

## Issue 106: Inline critical CSS and defer non-critical Tailwind stylesheets in apps/landing

**Target Area:** `apps/landing/vite.config.js`  
**Category:** Performance / Critical Rendering Path  
**Labels:** `landing, frontend, css, performance, vite`

### Problem
Entire Tailwind CSS stylesheet is loaded as a render-blocking file before any DOM elements can be painted.

### Required Frontend Scope
Configure Vite build to extract and inline critical above-the-fold CSS in `index.html` while loading remainder asynchronously.

### Acceptance Criteria
- First Contentful Paint (FCP) drops below 0.8s on simulated 4G mobile profiles.

---

## Issue 107: Add structured JSON-LD schema markup for FinancialService and Organization in landing index.html

**Target Area:** `apps/landing/index.html`  
**Category:** SEO / Structured Data  
**Labels:** `landing, frontend, seo, json-ld, schema`

### Problem
Search engines cannot parse SendAm's corporate identity, payment service type, supported corridors, or official support channels.

### Required Frontend Scope
Inject structured JSON-LD `<script type='application/ld+json'>` defining `FinancialService`, supported currencies, and contact points.

### Acceptance Criteria
- Google Rich Results Test confirms valid `FinancialService` and `Organization` structured data with zero warnings.

---

## Issue 108: Optimize Interaction to Next Paint (INP) on CurrencyCalculator amount slider

**Target Area:** `apps/landing/src/components/CurrencyCalculator.jsx`  
**Category:** Performance / Core Web Vitals  
**Labels:** `landing, frontend, inp, web-vitals, performance`

### Problem
Rapidly sliding the currency amount input triggers synchronous heavy re-renders, causing noticeable INP frame delay (> 200ms).

### Required Frontend Scope
Use React 18 `useTransition` and `useDeferredValue` to prioritize user slider input responsiveness over fee calculation re-renders.

### Acceptance Criteria
- Interaction to Next Paint (INP) remains under 50ms during rapid input sliding on budget Android devices.

---

## Issue 109: Configure Web App Manifest with high-res maskable icons and custom theme color

**Target Area:** `apps/landing/public/manifest.json`  
**Category:** PWA / Mobile Integration  
**Labels:** `landing, frontend, pwa, manifest, icons`

### Problem
PWA manifest is missing maskable icon specifications and theme color definitions, causing ugly square icons on Android home screens.

### Required Frontend Scope
Update `manifest.json` with 192x192 and 512x512 icons with `'purpose': 'any maskable'`, setting navigation bar theme color to `#0f172a`.

### Acceptance Criteria
- Lighthouse PWA audit passes 100%; app installs with circular adaptive icon on Android and matches brand colors.

---

## Issue 110: Enforce frontend bundle size budgets with rollup-plugin-visualizer in apps/admin and apps/landing

**Target Area:** `apps/admin/vite.config.js`  
**Category:** Performance / Build Pipeline  
**Labels:** `admin, landing, frontend, build, bundle-budget`

### Problem
Frontend bundles have occasionally bloated past 500KB without CI warnings, regressing load speeds for operators on mobile.

### Required Frontend Scope
Add `rollup-plugin-visualizer` and build-time bundle budget limits failing builds if initial entry chunks exceed 250KB.

### Acceptance Criteria
- `npm run build` generates interactive bundle size treemap and enforces strict size limits in CI pipeline.

---

## Issue 111: Add Playwright visual regression test suite for landing page across Desktop, Tablet, and Mobile

**Target Area:** `apps/landing/e2e/visual-regression.spec.js`  
**Category:** Testing / Visual Regression  
**Labels:** `landing, frontend, testing, playwright, visual-regression`

### Problem
CSS changes occasionally cause unintended layout breakages or horizontal overflows on specific mobile viewports.

### Required Frontend Scope
Implement Playwright visual snapshot tests comparing pixel diffs across iPhone 14, iPad Mini, and Desktop Chrome viewports.

### Acceptance Criteria
- Tests catch visual regressions with configurable pixel threshold (< 0.1%); generates visual diff artifacts in CI.

---

## Issue 112: Add Playwright E2E test suite for CurrencyCalculator corridor switching and math accuracy

**Target Area:** `apps/landing/e2e/calculator.spec.js`  
**Category:** Testing / End-to-End  
**Labels:** `landing, frontend, testing, playwright, e2e`

### Problem
Currency calculator math regressions could display incorrect fee or payout numbers to prospective users.

### Required Frontend Scope
Create Playwright test verifying USD -> NGN, GBP -> KES, and EUR -> GHS corridor switches, fee subtractions, and output values.

### Acceptance Criteria
- Automated test suite validates calculations across 10 preset corridors and ensures WhatsApp link reflects inputted amount.

---

## Issue 113: Add Playwright E2E test suite for OnboardingWizard step navigation and form validation

**Target Area:** `apps/landing/e2e/onboarding.spec.js`  
**Category:** Testing / End-to-End  
**Labels:** `landing, frontend, testing, playwright, onboarding`

### Problem
Multi-step form flow has no end-to-end test verifying phone formatting, step validation, and error states.

### Required Frontend Scope
Create Playwright suite testing full journey: Step 1 (Phone) -> Step 2 (Identity) -> Step 3 (Confirmation), checking field validations.

### Acceptance Criteria
- Tests assert step gating (cannot proceed with invalid inputs) and successful submission state.

---

## Issue 114: Add Playwright E2E test suite for Admin DataTable sorting, filtering, and pagination

**Target Area:** `apps/admin/e2e/datatable.spec.js`  
**Category:** Testing / End-to-End  
**Labels:** `admin, frontend, testing, playwright, datatable`

### Problem
Admin portal data table filtering and pagination lack end-to-end integration tests, risking silent search breakages.

### Required Frontend Scope
Create Playwright test suite verifying text search filtering, date range inputs, column header sorting, and pagination controls.

### Acceptance Criteria
- Tests run against mock service worker data asserting table row count, sort direction, and URL param synchronization.

---

## Issue 115: Add Playwright E2E test suite for ChatScreen message flow and simulated voice note dispatch

**Target Area:** `apps/chat-sim/e2e/chat.spec.js`  
**Category:** Testing / End-to-End  
**Labels:** `chat-sim, frontend, testing, playwright, chat`

### Problem
Chat simulator lacks automated browser tests verifying message sending, state machine progression, and quick-reply clicks.

### Required Frontend Scope
Create Playwright suite testing text messaging, quick-reply button selection, session reset, and message delivery receipts.

### Acceptance Criteria
- End-to-end test validates complete simulated chat payment conversation from greeting to confirmation message.

---

## Issue 116: Add Vitest unit test suite for CurrencyCalculator rate calculations and boundary checks

**Target Area:** `apps/landing/src/components/CurrencyCalculator.test.jsx`  
**Category:** Testing / Unit Tests  
**Labels:** `landing, frontend, testing, vitest, unit`

### Problem
Currency calculation edge cases (e.g. 0 amount, negative amount, decimal precision, extreme numbers) lack unit test coverage.

### Required Frontend Scope
Write Vitest unit tests covering zero input, negative values, maximum transfer limits, and 7-decimal crypto precision.

### Acceptance Criteria
- 100% test coverage for currency calculation utilities with zero rounding errors.

---

## Issue 117: Add Vitest unit test suite for CorridorChart coordinate projection and data scaling

**Target Area:** `apps/admin/src/components/CorridorChart.test.jsx`  
**Category:** Testing / Unit Tests  
**Labels:** `admin, frontend, testing, vitest, charts`

### Problem
CorridorChart SVG coordinates and bar heights are not tested for empty datasets or single-day datasets.

### Required Frontend Scope
Write unit tests asserting SVG path generation, empty state handling, and zero-volume bar rendering.

### Acceptance Criteria
- Tests verify chart scales smoothly without NaN SVG coordinate errors when input data has zero or missing values.

---

## Issue 118: Add automated axe-core accessibility audit tests for Admin components in accessibility.test.jsx

**Target Area:** `apps/admin/src/accessibility.test.jsx`  
**Category:** Testing / Accessibility Automation  
**Labels:** `admin, frontend, testing, vitest, axe-core, a11y`

### Problem
Admin forms, modals, and tables can accumulate ARIA and label violations unnoticed during rapid feature iteration.

### Required Frontend Scope
Integrate `axe-core` inside Vitest to assert zero WCAG 2.1 AA violations across `DataTable`, `FilterBar`, and `KycReview` modals.

### Acceptance Criteria
- Test suite runs axe audits against rendered components; fails if missing labels or ARIA role mismatches are detected.

---

## Issue 119: Add automated axe-core accessibility audit tests for Landing components in App.test.jsx

**Target Area:** `apps/landing/src/App.test.jsx`  
**Category:** Testing / Accessibility Automation  
**Labels:** `landing, frontend, testing, vitest, axe-core, a11y`

### Problem
Landing page components (Hero, Calculator, Navbar, Faq) lack automated compliance testing for WCAG 2.1 Level AA.

### Required Frontend Scope
Run axe accessibility scans on all landing page components within Vitest and JSDOM, asserting zero violations.

### Acceptance Criteria
- Axe test suite asserts zero color-contrast, missing label, or landmark violations across the entire landing page.

---

## Issue 120: Implement Mock Service Worker (MSW) browser worker handlers for client-side offline development

**Target Area:** `apps/admin/src/mocks/browser.js`  
**Category:** Testing / Developer Experience  
**Labels:** `admin, landing, frontend, msw, testing, mock-api`

### Problem
Frontend developers cannot work on admin dashboards or landing wizards without running the full backend and Docker stack locally.

### Required Frontend Scope
Configure Mock Service Worker (MSW) in browser dev mode to intercept REST requests and return deterministic client mock data.

### Acceptance Criteria
- Starting frontend with `VITE_USE_MSW=true` allows full interactive development and testing of all UI features without backend.

---

