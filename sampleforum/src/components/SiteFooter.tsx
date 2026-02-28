export function SiteFooter() {
  return (
    <footer className="border-t border-border bg-card/70">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-3 px-4 py-4 text-sm text-muted-foreground">
        <span>© 2026 BFANG Team</span>
        <div className="flex items-center gap-3">
          <a className="transition-colors hover:text-foreground" href="/privacy-policy">
            Privacy Policy
          </a>
          <span aria-hidden="true">·</span>
          <a className="transition-colors hover:text-foreground" href="/terms-of-service">
            Terms of Service
          </a>
        </div>
      </div>
    </footer>
  );
}
