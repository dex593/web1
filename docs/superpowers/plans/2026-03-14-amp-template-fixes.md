# AMP Template Fixes Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix AMP template issues: add #about anchor target, remove duplicate login button, verify template null-safety.

**Architecture:** Small targeted fixes in existing EJS template files without changing non-AMP behavior or breaking existing functionality.

**Tech Stack:** EJS templates, Express.js routes

---

## Issues Identified

1. **#about anchor missing**: Both AMP templates have `<a href="/#about">` links but no corresponding `id="about"` element exists
2. **Duplicate auth UI**: manga-detail-amp.ejs line 776 has unconditional login button that duplicates auth-widget (lines 749-775)
3. **Template safety**: Verify existing null checks are sufficient

---

## Files

- Modify: `views/index-amp.ejs` - Add id="about" to section
- Modify: `views/manga-detail-amp.ejs` - Remove duplicate login button line 776
- Modify: `views/manga-detail-amp.ejs` - Add id="about" to section (optional consistency)
- Test: Manual smoke test via browser

---

## Chunk 1: Fix #about Anchor in index-amp.ejs

### Task 1: Add id="about" to Về section in index-amp.ejs

**Files:**
- Modify: `views/index-amp.ejs:1092-1096`

- [ ] **Step 1: Locate the section header**

Find the section with `<h2><%= aboutTitle %></h2>` around line 1092-1096:
```html
<section class="section">
  <div class="section-header">
    <h2><%= aboutTitle %></h2>
    <span class="section-line"></span>
  </div>
```

- [ ] **Step 2: Add id="about" to section element**

Change line 1092 from:
```html
<section class="section">
```
To:
```html
<section class="section" id="about">
```

- [ ] **Step 3: Verify change**

Run syntax check:
```bash
node --check views/index-amp.ejs
```
Expected: No errors

---

## Chunk 2: Remove Duplicate Login Button in manga-detail-amp.ejs

### Task 2: Remove duplicate unconditional login button

**Files:**
- Modify: `views/manga-detail-amp.ejs:776`

- [ ] **Step 1: Locate the duplicate login button**

Line 776 contains:
```html
<a class="button button--ghost" href="<%= loginHref %>">Đăng nhập</a>
```

This is inside `<div class="header-actions">` and appears AFTER the auth-widget (lines 749-775) which already handles login state conditionally.

- [ ] **Step 2: Remove the duplicate line**

Delete line 776:
```html
<a class="button button--ghost" href="<%= loginHref %>">Đăng nhập</a>
```

The auth-widget at lines 749-775 already handles:
- Shows "Đăng nhập" button when NOT signed in (line 750-752)
- Shows profile icon when signed in (line 753-774)

- [ ] **Step 3: Verify change**

Run syntax check:
```bash
node --check views/manga-detail-amp.ejs
```
Expected: No errors

---

## Chunk 3: Consistency - Add id="about" to manga-detail-amp.ejs (Optional)

### Task 3: Add id="about" for consistency

**Files:**
- Modify: `views/manga-detail-amp.ejs` (find similar section)

- [ ] **Step 1: Check if manga-detail-amp has similar "about" section**

Search for aboutTitle or similar section in manga-detail-amp.ejs

If exists: Add id="about" similar to index-amp.ejs
If not exists: Skip this task

---

## Chunk 4: Verification

### Task 4: Run syntax checks and manual smoke test

- [ ] **Step 1: Run syntax checks on both files**

```bash
node --check views/index-amp.ejs
node --check views/manga-detail-amp.ejs
```

Expected: Both pass without errors

- [ ] **Step 2: Verify route files still work**

```bash
node --check server.js
```

Expected: No errors

- [ ] **Step 3: Manual smoke test (optional, if dev server running)**

Visit:
- `http://127.0.0.1:3000/?amp=1` - Check homepage AMP
- `http://127.0.0.1:3000/manga/some-manga-slug?amp=1` - Check manga detail AMP

Verify:
- Click on "Về" link scrolls to correct section
- No duplicate login button in manga detail header

---

## Implementation Notes

- These are minimal, targeted fixes
- No route changes needed - templates already rendered correctly
- No CSS changes - existing styles work fine
- Auth widget at lines 749-775 already has proper conditional logic for isInitiallySignedIn
- The duplicate at line 776 was likely a copy-paste error

---

## Success Criteria

1. ✅ `node --check` passes for both template files
2. ✅ #about anchor scrolls to correct section when clicked
3. ✅ No duplicate login buttons in manga-detail-amp header
4. ✅ Non-AMP pages unchanged (verify /manga route works)
