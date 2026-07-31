---
name: Capgo Console
description: Product UI for managing Capacitor live updates, releases, channels, devices, and operations.
colors:
  dusk: "#515271"
  azure: "#119eff"
  teal: "#1FB2A5"
  success: "#88d4a6"
  warning: "#ff7211"
  muted-blue: "#456b9a"
  neutral-dark: "#191D24"
  slate-900: "#1e293b"
  slate-800: "#1a1d24"
  slate-700: "#334155"
  slate-600: "#475569"
  slate-500: "#64748b"
  slate-300: "#cbd5e1"
  slate-100: "#f1f5f9"
  slate-50: "#f8fafc"
  white: "#ffffff"
typography:
  display:
    fontFamily: "Prompt, Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "3.75rem"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.02em"
  headline:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.33
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1.125rem"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  body:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  label:
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif"
    fontSize: "0.875rem"
    fontWeight: 500
    lineHeight: 1.5715
rounded:
  sm: "4px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  pill: "9999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.dusk}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-secondary:
    backgroundColor: "{colors.azure}"
    textColor: "{colors.white}"
    rounded: "{rounded.md}"
    padding: "10px 16px"
  button-outline:
    backgroundColor: "{colors.white}"
    textColor: "{colors.slate-600}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.white}"
    textColor: "{colors.slate-900}"
    rounded: "{rounded.xl}"
    padding: "24px"
  input:
    backgroundColor: "{colors.white}"
    textColor: "{colors.slate-900}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
---

# Design System: Capgo Console

## 1. Overview

**Creative North Star: "The Release Control Room"**

Capgo Console is operational product software. The system should feel steady under pressure: dark slate navigation, quiet content surfaces, clear focus states, and concise controls that keep the user in the task. It is not trying to sell the product on every screen. It is helping someone ship, inspect, and recover.

The visual system is restrained by default. Azure is reserved for focus, selection, meaningful state, and the clearest action on a screen. Dusk, slate, and white carry the structure. Cards and shadows exist, but only to separate a repeated object, dialog, empty state, or table tool from its surroundings.

**Key Characteristics:**
- Dense but readable app shell for repeated operational work.
- Dark slate side navigation with azure active state.
- Light content surfaces with slate text and restrained borders.
- Standard product controls: DaisyUI buttons/dialogs, Tailwind utilities, tabs, tables, toggles, and form fields.
- Fast state motion around 150-200ms, used for feedback and navigation only.

## 2. Colors

The palette combines a deep slate operating shell with a rare azure highlight and plain white data surfaces.

### Primary
- **Dusk Control**: The DaisyUI primary color. Use it for primary product actions and brand-bearing UI when the action should feel steady rather than loud.

### Secondary
- **Capgo Azure**: The highlight color. Use it for selected nav items, focus rings, active tabs, links, and high-confidence actions. Keep it rare.
- **Operational Teal**: A supporting accent for positive, health, or secondary semantic moments. Do not use it as decoration.

### Tertiary
- **Build Warning Orange**: Warning and attention state. Use it only when the user needs to notice risk, cost, blocked work, or destructive-adjacent state.
- **Muted Incident Blue**: Existing danger/error-adjacent token. Use carefully and prefer explicit copy because the hue is not a universal danger signal.

### Neutral
- **Console Slate**: Dark shell, sidebar, modal backdrop, and deep surface family.
- **Content Slate**: Body text, muted labels, borders, and dividers.
- **Base White**: Main panel and card surface.
- **Soft Slate Surface**: Page background, table bands, and low-emphasis panels.

### Named Rules

**The Azure Is State Rule.** Azure marks state, focus, selection, or one obvious action. If it is only decoration, remove it.

**The Slate Shell Rule.** Navigation and global chrome stay in slate. Content should not become a rainbow of product areas.

## 3. Typography

**Display Font:** Prompt with Inter and system sans fallback.
**Body Font:** Inter with system sans fallback.
**Label/Mono Font:** System monospace is available for code-like values, but product UI labels stay in Inter.

**Character:** The product uses one practical sans system for most UI, with Prompt reserved for brand-bearing display moments such as the Capgo mark. The type scale is fixed and compact, which suits dashboards, settings, tables, and release workflows.

### Hierarchy
- **Display** (700, 3.75rem, 1.2): Rare. Use for marketing-adjacent or onboarding hero moments only, not routine app screens.
- **Headline** (700, 1.5rem, 1.33): Page titles, dialog titles, and empty-state headings.
- **Title** (600, 1.125rem, 1.5): Card headings, panel headings, and section labels.
- **Body** (400, 1rem, 1.5): Normal explanatory text and settings copy. Keep prose to 65-75ch when it is not table data.
- **Label** (500, 0.875rem, 1.5715): Buttons, field labels, tabs, nav text, and compact metadata.

### Named Rules

**The Product Scale Rule.** Do not use fluid hero typography in console screens. Fixed rem sizes keep dense UI predictable.

**The Prompt Restraint Rule.** Prompt can carry the brand mark. It must not appear in dense labels, tables, settings controls, or logs.

## 4. Elevation

Capgo uses a hybrid of tonal layering and light structural shadows. The default page hierarchy comes from background shifts, borders, and spacing. Shadows are reserved for mobile sidebars, dialogs, dropdowns, elevated empty states, and hover affordances where the user needs a clear layer boundary.

### Shadow Vocabulary
- **Soft Control Shadow**: Low blur for small controls and selected secondary tabs.
- **Panel Shadow**: Medium shadow for empty-state cards and local overlays.
- **Dialog Shadow**: Larger shadow for modal surfaces that need to separate from a dark backdrop.

### Named Rules

**The Flat By Default Rule.** Tables, panels, settings groups, and nav rows stay flat at rest. Add a shadow only when a layer floats above the page.

## 5. Components

### Buttons
- **Shape:** Gently rounded rectangles (8px) for most actions, circles only for icon-only affordances.
- **Primary:** DaisyUI primary uses Dusk Control with white text. Direct route actions also use azure or Tailwind blue when selection/action continuity matters.
- **Hover / Focus:** 150-200ms color transitions. Focus rings use azure/blue with visible offset.
- **Secondary / Ghost / Tertiary:** Outline and ghost actions should stay slate and quiet. Disabled states use opacity plus cursor changes, not color alone.

### Chips
- **Style:** Small rounded or pill-like labels with muted backgrounds and strong enough text contrast.
- **State:** Selected filter chips may use azure or white-on-slate depending on the surface. Do not use full-saturation inactive chips.

### Cards / Containers
- **Corner Style:** Cards and dialogs use 12-16px at most.
- **Background:** Main content cards use white in light mode and slate surfaces in dark mode.
- **Shadow Strategy:** Use elevation only for overlays, dialogs, empty states, and temporary layers.
- **Border:** Borders are slate-tinted and subtle. Do not use side-stripe borders.
- **Internal Padding:** 16-32px depending on density; tables and toolbars stay tighter.

### Inputs / Fields
- **Style:** White or slate field background, 8px radius, subtle border, compact vertical rhythm.
- **Focus:** Azure/blue ring with offset. The focused field must be unmistakable.
- **Error / Disabled:** Pair color with text or iconography. Do not rely on hue alone.

### Navigation
- **Style, typography, default/hover/active states, mobile treatment.** Sidebar navigation uses slate surfaces, 14px medium labels, 20px icons, 12px row padding, 8px radius, and azure active text/icon state. Mobile sidebar floats with rounded corners and a dark overlay; desktop sidebar is fixed and square-edged against the app shell.

### Tables
- **Style:** Dense controls, sticky mental model, clear search/filter/reload/add affordances, and visible skeleton rows.
- **State:** Loading uses skeletons or spinner-in-button feedback. Empty states teach the next action.
- **Actions:** Icon buttons need accessible titles/tooltips and disabled styles.

### Dialogs
- **Style:** Teleported modal with black backdrop, base surface, 8px radius, and strong shadow.
- **Layout:** Title, description, custom content, then right-aligned action row.
- **Buttons:** Use role-mapped DaisyUI actions and keep destructive or warning actions visually explicit.

## 6. Do's and Don'ts

### Do:
- **Do** preserve the dark slate shell and quiet content surface split.
- **Do** use Capgo Azure for state, selection, focus, and one clear action.
- **Do** keep console copy concise and operational.
- **Do** use DaisyUI `d-` prefixed primitives for buttons, dialogs, fields, and interactive controls when they fit.
- **Do** design tables, logs, and settings for dense data and repeated use.
- **Do** include loading, empty, disabled, hover, focus, error, and restricted-access states.

### Don't:
- **Don't** make the console feel like an overdecorated SaaS dashboard.
- **Don't** make authenticated product screens feel like a marketing-heavy landing page.
- **Don't** build generic AI card grids, decorative gradients, glass effects, or ornamental animation.
- **Don't** use large side-stripe borders, gradient text, nested cards, or 32px-plus card radii.
- **Don't** hide operational state behind vague wizard copy.
- **Don't** introduce a new color family when slate, dusk, azure, teal, warning, and status colors already cover the role.
